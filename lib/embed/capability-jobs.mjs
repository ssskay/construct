/**
 * lib/embed/capability-jobs.mjs — daemon-side registration of embed-capability
 * scheduled jobs (ADR-0061 §4, LMCP-P2/F5).
 *
 * `registerEmbedCapabilityJobs` reads the enabled set and registers exactly
 * one Scheduler job per enabled capability — no more, no fewer, and never
 * for a capability that is merely available-but-not-enabled. Each job body
 * (`runCapabilityTick`) is the real F5 glue: it slices the specialist's
 * bound provider snapshot (E4 providerBindings + B11 filter enforcement)
 * out of the daemon's last snapshot, asks `workflow-invoke.mjs` for the
 * orchestration plan, and — only when a reasoning executor is actually
 * wired in (see below) — runs it, validates the resulting output packet
 * against the role's output contract (F2's `validateOutputPacket`), checks
 * every proposed external write against the specialist's E4 grant
 * (`AuthorityGuard`), and enqueues surviving proposals as durable
 * writeIntents in the approval queue (I2). The daemon never calls a
 * provider write adapter itself — enqueue is the only path out of this
 * module; the J2 envelope executor is the sole drain.
 *
 * Reasoning-executor placement (ADR-0061 §3): `resolveRuntime` reports
 * whether an `in-process` or `external` runtime is *configured*.
 * `runCapabilityTick` accepts an optional
 * `reasoningExecutor(plan, sliceCtx) -> { outputPacket, writeProposals }`
 * so an engine can be wired in without changing this module again; absent
 * that injection, a resolved runtime with no executor records a visible
 * `skipped-with-reason(reasoning-executor-not-available)` tick — never a
 * fabricated completion. A `runtime: 'none'` resolution still short-circuits
 * to `skipped-with-reason(no-runtime)` before any of this even runs, exactly
 * as the pre-F5 stub did.
 *
 * lib/embed/reasoning-executor.mjs (construct-jvjow.2) is the first real
 * engine: opt-in and off by default, budget-gated through
 * lib/policy/unattended-budget.mjs. Its executor function can also return
 * `{ skippedReason }` — e.g. budget exhaustion — which this module turns
 * into the same honest `skipped-with-reason` shape rather than a fabricated
 * or contract-checked completion; the deterministic snapshot/plan work
 * above always finishes first and is never rolled back by a reasoning skip.
 */

import { loadEmbedCapabilities } from './capability-loader.mjs';
import { enabledCapabilityIds, writeCapabilityTick } from './capability-lifecycle.mjs';
import { resolveRuntime } from './capability-runtime.mjs';
import { matchesFilter, validateFilterConfig } from '../providers/contract.mjs';
import { validateOutputPacket } from '../orchestration/worker.mjs';
import { invokeWorkflow } from '../embedded-contract/workflow-invoke.mjs';
import { loadAllPacks } from '../packs/loader.mjs';
import { AuthorityGuard } from './authority-guard.mjs';

/** Default cadence (ms) for a capability with no declared `embed.cadence.every`. */
const DEFAULT_CADENCE_MS = 15 * 60_000;

/** Reserved reason recorded when a runtime resolves but no reasoning executor is wired in. */
export const SKIP_REASON_NO_EXECUTOR = 'reasoning-executor-not-available';

/** Generic linear workflow used to obtain a role-scoped plan for a capability's bound specialist. */
const CAPABILITY_WORKFLOW_TYPE = 'structure-notes';

const PACK_TIER_RANK = { project: 0, user: 1, builtin: 2, unknown: 3 };

/**
 * Parse the ISO-8601 duration subset accepted by `embed.cadence.every`
 * (P and T with D/H/M components — the same grammar ADR-0060's
 * `updatedSince` predicate accepts). An unparsable value returns null,
 * falling back to DEFAULT_CADENCE_MS rather than throwing at daemon
 * startup over one malformed capability.
 */
export function parseCadenceMs(every) {
  if (typeof every !== 'string' || !every) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(every);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000;
  return ms > 0 ? ms : null;
}

/**
 * Strip a `cx-` prefix from a specialist id, mirroring the bare role ids
 * `workflow-invoke.mjs` (role-facts.mjs `roleMap`) and `AuthorityGuard`'s
 * embedBindings map key expect.
 */
function bareRoleId(specialistId) {
  return String(specialistId || '').replace(/^cx-/, '');
}

/**
 * Merge every loaded pack's `embedBindings` block into a single
 * specialistId → { providers[], proposals[] } map, project tier winning
 * over user winning over builtin — the same precedence
 * `lib/embedded-contract/workflow-invoke.mjs` applies to framework
 * resolution. Reuses `loadAllPacks` read-only; performs no validation of
 * its own (E4 validation already ran when the pack was loaded).
 */
export function mergedEmbedBindings({ rootDir, env = process.env } = {}) {
  const { packs } = loadAllPacks({ rootDir, env });
  const ordered = [...packs].sort((a, b) => (PACK_TIER_RANK[a._tier] ?? 3) - (PACK_TIER_RANK[b._tier] ?? 3));

  const merged = {};
  // Lowest precedence first so a higher-precedence tier's binding for the
  // same specialist overwrites rather than merges field-by-field — a
  // project override fully replaces a builtin grant for that specialist.
  for (const pack of [...ordered].reverse()) {
    for (const [specialistId, binding] of Object.entries(pack.embedBindings || {})) {
      merged[specialistId] = binding;
    }
  }
  return merged;
}

/**
 * Slice the capability's bound providers out of the daemon's last-generated
 * snapshot and re-apply the capability's own `embed.filter` (ADR-0060/B11)
 * on top of whatever the poll-time source filter already admitted — a
 * capability's filter can be narrower than the source's, never wider,
 * since it runs after the source filter already ran. Returns `null`
 * sections are skipped entirely when the bound provider has no section in
 * the snapshot (not configured as a source, or the provider errored).
 *
 * @param {object|null} snapshot   the daemon's last SnapshotEngine.generate() result
 * @param {string[]} providerBindings
 * @param {object|null} filter     embed.filter (ADR-0060 block) or null
 * @returns {{ sections: Array<{provider:string, items:object[]}>, errors: string[] }}
 */
export function sliceBoundSnapshot(snapshot, providerBindings, filter) {
  const bound = new Set(providerBindings || []);
  const sections = [];
  const errors = [];

  for (const section of snapshot?.sections ?? []) {
    if (!bound.has(section.provider)) continue;

    let items = section.items ?? [];
    if (filter != null) {
      try {
        validateFilterConfig(section.provider, filter);
        items = items.filter((item) => matchesFilter(item, filter));
      } catch (err) {
        errors.push(`embed.filter invalid for bound provider '${section.provider}': ${err.message}`);
        items = [];
      }
    }
    sections.push({ provider: section.provider, items });
  }

  return { sections, errors };
}

/**
 * Any-key-autonomous authority profile: `AuthorityGuard.check()` runs its
 * E4 binding gate before consulting authority level at all, but its
 * approval-queued branch calls `approvalQueue.approvalMode()`, a method
 * the real `lib/embed/approval-queue.mjs` ApprovalQueue does not implement
 * (only test doubles do). This module owns writeIntent enqueueing itself
 * (the actual durable record), so the guard is only ever consulted here
 * for the binding decision — every key resolves `autonomous` so a granted
 * proposal short-circuits to `allowed:true` without reaching that branch.
 */
const AUTONOMOUS_AUTHORITY = new Proxy({}, { get: () => 'autonomous' });

/**
 * Check a single proposed write against the specialist's E4 grant.
 * Returns `{ allowed: true }` or `{ allowed: false, reason }` — never
 * throws, so one denied proposal never aborts the rest of the batch.
 */
async function checkProposalAuthority(embedBindings, { specialistId, providerId, writeKind }) {
  const guard = new AuthorityGuard({ authority: AUTONOMOUS_AUTHORITY }, null, embedBindings);
  const result = await guard.check(`${providerId}.${writeKind}`, {
    proposal: { specialistId, providerId, writeKind },
  });
  return result.allowed
    ? { allowed: true }
    : { allowed: false, reason: result.reason || `proposal ${providerId}.${writeKind} denied` };
}

/**
 * Real tick body (LMCP-F5): resolves the runtime selector, and when a
 * runtime is available AND a reasoning executor is wired in, composes the
 * specialist's bound snapshot slice, asks workflow-invoke.mjs for the
 * orchestration plan, runs the executor, validates its output packet
 * against the role's output contract, checks every proposed write against
 * the E4 grant, and enqueues surviving proposals as writeIntents. Every
 * other path — no runtime, no executor, contract failure — records an
 * honest status and never a fabricated completion.
 *
 * @param {object} manifest                embed-capability manifest (capability-loader.mjs shape)
 * @param {object} [opts]
 * @param {string} opts.rootDir
 * @param {object} [opts.env]
 * @param {() => object|null} [opts.getSnapshot]        returns the daemon's last snapshot, or null
 * @param {import('./approval-queue.mjs').ApprovalQueue} [opts.approvalQueue]
 * @param {object} [opts.embedBindings]                  specialistId → {providers[],proposals[]}; built fresh from mergedEmbedBindings when omitted
 * @param {(plan: object, ctx: object) => Promise<{outputPacket?: object, writeProposals?: object[]}>} [opts.reasoningExecutor]
 * @returns {Promise<object>} the recorded tick
 */
export async function runCapabilityTick(manifest, {
  rootDir,
  env = process.env,
  getSnapshot = () => null,
  approvalQueue = null,
  embedBindings = null,
  reasoningExecutor = null,
} = {}) {
  const embed = manifest.embed;
  const runtime = await resolveRuntime(embed.runtime, env);
  const tickedAt = new Date().toISOString();

  if (runtime.resolved === 'none') {
    const tick = { status: 'skipped-with-reason', reason: runtime.reason, runtime: runtime.resolved, tickedAt };
    writeCapabilityTick(manifest.id, tick, rootDir);
    return tick;
  }

  if (typeof reasoningExecutor !== 'function') {
    const tick = { status: 'skipped-with-reason', reason: SKIP_REASON_NO_EXECUTOR, runtime: runtime.resolved, tickedAt };
    writeCapabilityTick(manifest.id, tick, rootDir);
    return tick;
  }

  const specialistId = bareRoleId(embed.specialist);
  const snapshot = getSnapshot();
  const { sections, errors: sliceErrors } = sliceBoundSnapshot(snapshot, embed.providerBindings, embed.filter ?? null);

  const plan = await invokeWorkflow(
    {
      workflowType: CAPABILITY_WORKFLOW_TYPE,
      roleStrategy: 'explicit',
      requestedRoles: [specialistId],
      approvalMode: 'proposal-only',
      context: { snapshotSections: sections },
    },
    { env, cwd: rootDir },
  );

  if (plan.status === 'error') {
    const tick = {
      status: 'skipped-with-reason',
      reason: `plan-error: ${plan.errors?.[0]?.code || 'unknown'}`,
      runtime: runtime.resolved,
      tickedAt,
    };
    writeCapabilityTick(manifest.id, tick, rootDir);
    return tick;
  }

  const bindings = embedBindings ?? mergedEmbedBindings({ rootDir, env });

  const executorResult = await reasoningExecutor(plan, { manifest, sections, sliceErrors, specialistId });

  // A `skippedReason` (e.g. construct-jvjow.2's budget-exhausted gate) means
  // the executor deliberately declined to reason this tick — an honest
  // skip, not a fabricated or contract-checked completion. The deterministic
  // snapshot/plan work above already ran and is not undone; only the
  // reasoning step itself is skipped.

  if (executorResult?.skippedReason) {
    const tick = {
      status: 'skipped-with-reason',
      reason: executorResult.skippedReason,
      runtime: runtime.resolved,
      tickedAt,
    };
    writeCapabilityTick(manifest.id, tick, rootDir);
    return tick;
  }

  const outputPacket = executorResult?.outputPacket ?? null;
  const writeProposals = Array.isArray(executorResult?.writeProposals) ? executorResult.writeProposals : [];

  const outputCheck = validateOutputPacket(
    { role: `cx-${specialistId}`, outputContractId: embed.outputContract, outputPacket },
    { cwd: rootDir },
  );

  if (outputCheck.checked && outputCheck.contractStatus === 'contract-failed') {
    const tick = {
      status: 'blocked',
      reason: 'output-contract-violation',
      contractId: outputCheck.contractId,
      violations: outputCheck.violations,
      runtime: runtime.resolved,
      tickedAt,
    };
    writeCapabilityTick(manifest.id, tick, rootDir);
    return tick;
  }

  const enqueued = [];
  const denied = [];

  for (const proposal of writeProposals) {
    const { providerId, writeKind, payload } = proposal || {};
    const authResult = await checkProposalAuthority(bindings, { specialistId, providerId, writeKind });

    if (!authResult.allowed) {
      denied.push({ providerId, writeKind, reason: authResult.reason });
      continue;
    }

    const record = approvalQueue?.enqueue({
      tool: `${providerId}.${writeKind}`,
      args: payload ?? {},
      surface: 'embed-capability',
      requestedBy: { serviceId: manifest.id, role: `cx-${specialistId}` },
    });
    enqueued.push({ providerId, writeKind, approvalId: record?.approvalId ?? null });
  }

  const tick = {
    status: 'ran',
    runtime: runtime.resolved,
    contractStatus: outputCheck.contractStatus,
    proposalsEnqueued: enqueued,
    proposalsDenied: denied,
    tickedAt,
  };
  writeCapabilityTick(manifest.id, tick, rootDir);
  return tick;
}

/**
 * Register exactly one Scheduler job per enabled embed capability.
 * Capabilities that are available but not enabled are never registered.
 * An invalid or missing manifest for a nominally-enabled id is skipped with
 * a stderr line rather than crashing daemon startup — the loader already
 * fails closed at `enable` time, so this path only defends against a
 * project manifest edited or corrupted after enable.
 *
 * @param {import('./scheduler.mjs').Scheduler} scheduler
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {object} [opts.env]
 * @param {string[]} [opts.packRoots]
 * @param {string[]} [opts.knownSpecialists]
 * @param {() => object|null} [opts.getSnapshot]
 * @param {import('./approval-queue.mjs').ApprovalQueue} [opts.approvalQueue]
 * @param {object} [opts.embedBindings]
 * @param {(plan: object, ctx: object) => Promise<object>} [opts.reasoningExecutor]
 * @returns {string[]} ids of capabilities actually registered
 */
export function registerEmbedCapabilityJobs(scheduler, {
  rootDir,
  env = process.env,
  packRoots,
  knownSpecialists,
  getSnapshot,
  approvalQueue,
  embedBindings,
  reasoningExecutor,
} = {}) {
  const enabledIds = new Set(enabledCapabilityIds({ rootDir, packRoots, knownSpecialists }));
  if (enabledIds.size === 0) return [];

  const { capabilities, errors } = loadEmbedCapabilities({ rootDir, packRoots, knownSpecialists });
  for (const err of errors) {
    process.stderr.write(`[embed] capability load error: ${err}\n`);
  }

  const registered = [];
  for (const manifest of capabilities) {
    if (!enabledIds.has(manifest.id)) continue;

    const cadenceMs = parseCadenceMs(manifest.embed.cadence?.every) ?? DEFAULT_CADENCE_MS;
    scheduler.register(
      `embed-capability:${manifest.id}`,
      cadenceMs,
      async () => {
        const tick = await runCapabilityTick(manifest, {
          rootDir,
          env,
          getSnapshot,
          approvalQueue,
          embedBindings,
          reasoningExecutor,
        });
        const detail = tick.reason ? ` (${tick.reason})` : '';
        process.stderr.write(`[embed] capability '${manifest.id}': ${tick.status}${detail}\n`);
      },
      { runImmediately: true },
    );
    registered.push(manifest.id);
  }

  const missingIds = [...enabledIds].filter((id) => !registered.includes(id));
  for (const id of missingIds) {
    process.stderr.write(`[embed] capability '${id}' is enabled but its manifest failed to load — not registered\n`);
  }

  return registered;
}
