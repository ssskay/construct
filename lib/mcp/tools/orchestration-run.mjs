/**
 * lib/mcp/tools/orchestration-run.mjs — MCP entry for Construct orchestration.
 *
 * Runs a real multi-specialist orchestration so MCP hosts with no subagent
 * primitive (VS Code/Copilot, Cursor) reach orchestrated outcomes through a tool
 * they already expose. The engine is the in-process orchestration runtime
 * (lib/orchestration/runtime.mjs) — solo runs need no daemon, no port, no token
 * (ADR-0022: the engine owns orchestration; ADR-0041 owned loop). When
 * CONSTRUCT_ORCHESTRATION_URL points at a remote/team orchestration service the
 * same call is proxied over HTTP instead, with the bearer token resolved from the
 * Construct env (CONSTRUCT_ORCHESTRATION_TOKEN / CONSTRUCT_DASHBOARD_TOKEN), not
 * from the dashboard server.
 */

import { runOrchestration, startRun, getRun, getRuns } from '../../orchestration/runtime.mjs';
import { HOST } from '../../orchestration/worker.mjs';
import { loadProjectConfig } from '../../config/project-config.mjs';
import { governWebResults } from './web-search-governance.mjs';
import { resolveNonNegativeSetting } from '../../env-config.mjs';

// Host loop instructions echoed on an awaiting-host run so the calling agent
// never has to guess the protocol: execute each materialized prompt as that
// specialist, submit the result, and follow next_task until it is null.
// Worded to be un-misreadable as a failure: a VS Code host once read "did not
// execute" as prepare-only-and-stuck, retried with worker_backend "provider",
// and died on missing API credits — so the text must lead with success and
// explicitly forbid that fallback.

const HOST_INSTRUCTIONS =
  'ACTION REQUIRED — this run succeeded and is now waiting on YOU, the calling agent. The host worker '
  + 'backend means Construct materialized each specialist prompt and you execute them in your own '
  + 'session (no API credits are spent). This is the normal path, not a failure: do NOT re-run with '
  + 'worker_backend "provider" (real API spend, needs provider credits) and do not report the run as '
  + 'incomplete. For each task in `tasks`, execute its `system`/`user` prompt yourself as that '
  + 'specialist role, in order, then submit the result by calling orchestration_task_result with '
  + '{ run_id, task_id, output }. Its response carries next_task (the next prompt to execute) or null '
  + 'once the run is terminal — keep submitting until next_task is null, then re-read the run via '
  + 'orchestration_status if you need the final consolidated output.';

// Every state a run can rest in. `degraded` and `completed-prepare-only` are
// terminal too — the poll loop must stop on them or a finished degraded/prepare-only
// remote run reads as "still executing" until the overall deadline elapses.

const TERMINAL = ['completed', 'completed-with-failures', 'completed-prepare-only', 'degraded', 'cancelled', 'error'];

// construct-vzg2i.2: a prepare-only run must say so loudly in the surface a
// caller actually reads, not just in prepareOnly/degraded metadata fields a
// caller has to know to check. readiness.mjs's NEXT_STEPS map (keyed by
// ORCHESTRATION_READINESS_REASONS) does not apply here — those reason codes
// describe why a host/session failed to ATTACH to orchestration at all, while
// completed-prepare-only is a post-run backend-selection outcome (the run
// attached and executed fine; it simply never reached a specialist). The
// remediation text below mirrors the wording `construct doctor` already gives
// for an inline-resolved backend (bin/construct's Worker-backend advisory
// line) so a caller sees one consistent instruction wherever it surfaces.

const PREPARE_ONLY_NEXT_STEP = 'set orchestration.workerBackend=provider (needs a provider API key, e.g. ANTHROPIC_API_KEY) '
  + 'for real specialist execution, or invoke orchestration_run through an attached MCP host with worker_backend=host';

export function prepareOnlyNotice(run) {
  const taskCount = Array.isArray(run.tasks) ? run.tasks.length : 0;
  return `PREPARE-ONLY: no specialist executed. Construct only prepared ${taskCount} specialist prompt(s) on the `
    + `inline backend — no API calls were made and no output was produced. Next step: ${PREPARE_ONLY_NEXT_STEP}.`;
}

export function shapeRun(run) {
  const hasTasks = Array.isArray(run.tasks) && run.tasks.length > 0;
  const allPrepared = hasTasks && run.tasks.every((t) => t.status === 'prepared');
  const degraded = run.degraded ?? run.execution?.degraded ?? false;

  // Terminal-status taxonomy (construct-fbxv.1): a degraded run never surfaces as a
  // bare 'completed'. All-prepared is the more specific "no specialist executed"
  // signal, so it wins; otherwise any degraded run — whether it prepared zero tasks
  // or executed with a capability gap — reports 'degraded'. Legacy runs persisted as
  // bare 'completed' before this taxonomy are re-derived the same way.
  const shapedStatus = allPrepared
    ? 'completed-prepare-only'
    : degraded && run.status === 'completed'
      ? 'degraded'
      : run.status;

  return {
    runId: run.runId,
    status: shapedStatus,
    // Loud, user-facing echo of prepareOnly — the whole shaped object is what
    // callers read (MCP stringifies it verbatim; the CLI prints fields off
    // it), so the honesty has to live in a message field, not just the boolean.
    ...(shapedStatus === 'completed-prepare-only' ? { message: prepareOnlyNotice(run) } : {}),
    prepareOnly: allPrepared,
    runMode: run.runMode ?? null,
    semantics: run.semantics ?? null,
    executionMode: run.execution?.executionMode,
    degraded,
    degradationReason: run.degradationReason ?? run.execution?.degradationReason ?? null,
    intent: run.plan?.intent ?? null,
    track: run.plan?.track ?? null,
    suggestedWorkflowType: run.plan?.suggestedWorkflowType ?? null,
    researchExecutionPolicy: run.plan?.researchExecutionPolicy ?? null,
    specialists: run.plan?.specialists ?? [],
    contextBindings: run.contextBindings ?? [],
    tasks: (run.tasks || []).map((t) => ({
      id: t.id, role: t.role, status: t.status, executor: t.executor,
      output: t.output ?? null, reasoning: t.reasoning ?? null, error: t.error ?? null,
      webCapability: t.webCapability ?? null,
      webEvidence: t.webEvidence ?? null,
      webSearchRequests: t.webSearchRequests ?? 0,
      // Host-backend fields only: the materialized prompt an awaiting-host task
      // carries (nulled out once submitHostTaskResult records a real result),
      // and provenanceSource — present only on a host-reported result, so it can
      // never be confused with a construct-verified provider execution.
      ...(t.hostPrompt ? { system: t.hostPrompt.system, user: t.hostPrompt.user } : {}),
      ...(t.provenanceSource ? { provenanceSource: t.provenanceSource } : {}),
      ...(t.evidenceGate ? { evidenceGate: t.evidenceGate } : {}),
    })),
  };
}

// Fail-closed remote ingress guard (ADR-0050): the remote orchestration service is
// out-of-repo and cannot be trusted to govern. Re-run every task's webEvidence through
// the single F08 grader so a citation can never arrive trusted or ungoverned, and mark the
// run degraded if any item was not already trust:'untrusted' with a valid Admiralty grade.

export function governRemoteWebEvidence(run, now = Date.now()) {
  let tampered = false;
  for (const t of run.tasks || []) {
    if (!Array.isArray(t.webEvidence) || t.webEvidence.length === 0) continue;
    if (t.webEvidence.some((e) => e?.trust !== 'untrusted' || !/^[A-F][1-6]$/.test(e?.admiralty || ''))) tampered = true;
    t.webEvidence = governWebResults(t.webEvidence, { now });
  }
  if (tampered) {
    run.degraded = true;
    run.degradationReason = run.degradationReason || 'remote-web-evidence-regoverned';
  }
  return run;
}

function toRequest(args) {
  return {
    request: args.request,
    workflowType: args.workflow_type,
    requestedStrategy: args.requested_strategy ?? 'auto',
    host: args.host,
    hostModel: args.host_model,
    hostProvider: args.host_provider,
    fileCount: args.file_count,
    moduleCount: args.module_count,
    contextTargets: args.context_targets,
  };
}

// Only MCP dispatch reaches orchestrationRun() — an in-process CLI call goes
// through runOrchestration/planRun directly (see bin/construct's `orchestrate
// run`), never through this function — so the host-execution default belongs
// exactly here: when the caller gave no explicit worker_backend AND the
// project's own construct.config.json declares none, an MCP-originated run
// defaults to the host executing specialists in its own session rather than
// inline prepare-only or a provider API spend the caller may have no credits
// for. The RAW (pre-default-merge) project config is the check that matters —
// loadProjectConfig always merges DEFAULT_PROJECT_CONFIG in, so the merged
// config's workerBackend is never actually absent; only the raw file reveals
// whether the user configured one.

function resolveMcpDefaultBackend(explicitBackend, { cwd, env }) {
  if (explicitBackend) return explicitBackend;
  try {
    const { raw } = loadProjectConfig(cwd, env);
    if (raw?.orchestration?.workerBackend) return undefined;
  } catch { /* no resolvable config — fall through to the host default */ }
  return HOST;
}

// A remote orchestration service is opt-in: only when CONSTRUCT_ORCHESTRATION_URL
// is set (team / enterprise). The token comes from the Construct env, not from
// the dashboard server, so the in-process default path carries no dashboard coupling.

function remoteService(env) {
  const url = env.CONSTRUCT_ORCHESTRATION_URL;
  if (!url) return null;
  const token = env.CONSTRUCT_ORCHESTRATION_TOKEN || env.CONSTRUCT_DASHBOARD_TOKEN || null;
  return { base: url.replace(/\/$/, ''), token };
}

function unreachable(base, detail) {
  return {
    error: `Remote orchestration service not reachable at ${base}: ${detail}. Unset CONSTRUCT_ORCHESTRATION_URL to run in-process, or start the service and retry.`,
    service: base,
    failFast: true,
  };
}

// A bounded fetch timing out is not the same failure as a genuinely unreachable host
// (ORCH-004 AC3): the error text must say timeout and name the bound so a healthy but
// slow service is never misreported as network-down.

function remoteFetchFailed(base, err) {
  if (err?.name === 'RemoteFetchTimeoutError') {
    return { error: `${err.message}. Raise CONSTRUCT_ORCHESTRATION_TIMEOUT_MS if the remote service is healthy but slow.`, service: base, failFast: true };
  }
  return unreachable(base, err.message);
}

export async function orchestrationRun(args = {}, { env = process.env, cwd = process.cwd(), fetchImpl = fetch } = {}) {
  const { request, worker_backend, wait = true, timeout_ms = 120000 } = args;
  if (!request || typeof request !== 'string') {
    return { error: 'Missing "request" string describing the work to orchestrate.' };
  }

  const reqObj = toRequest(args);
  const remote = remoteService(env);
  if (remote) return runViaService(remote, reqObj, { wait, timeout_ms, workerBackend: worker_backend, fetchImpl, env });

  const workerBackend = resolveMcpDefaultBackend(worker_backend, { cwd, env });
  const opts = { env, cwd, workerBackend, fetchImpl };
  try {
    if (!wait) {
      const planned = await startRun(reqObj, opts);
      return { runId: planned.runId, status: planned.status, executionMode: planned.execution?.executionMode, poll: 'orchestration_status with run_id' };
    }
    const shaped = shapeRun(await runOrchestration(reqObj, opts));
    return shaped.status === 'awaiting-host' ? { ...shaped, hostInstructions: HOST_INSTRUCTIONS } : shaped;
  } catch (err) {
    return { error: `Orchestration failed: ${err.message}`, failFast: true };
  }
}

export async function orchestrationStatus(args = {}, { env = process.env, cwd = process.cwd(), fetchImpl = fetch } = {}) {
  const { run_id, limit = 20 } = args;
  const remote = remoteService(env);
  if (remote) return statusViaService(remote, { run_id, limit }, { fetchImpl, env });
  try {
    if (run_id) {
      const run = await getRun(cwd, run_id, { env });
      if (!run) return { error: `No run found with id ${run_id}.` };
      const shaped = shapeRun(run);
      return shaped.status === 'awaiting-host' ? { ...shaped, hostInstructions: HOST_INSTRUCTIONS } : shaped;
    }
    const runs = await getRuns(cwd, { env, limit });
    return runs.map(shapeRun);
  } catch (err) {
    return { error: `Failed to read orchestration runs: ${err.message}` };
  }
}

// Remote (team / enterprise) HTTP path. Reached only when CONSTRUCT_ORCHESTRATION_URL
// is set; the wire shape matches the standalone orchestration service's
// /api/orchestration/runs contract (ADR-0022).

// Reachability fail-fast belongs to the deadline check in the poll loop, not the
// per-request budget: a remote LLM-backed run needs a generous per-request window
// (ORCH-004; construct-o6t8.2). Default is 30s, well above the industry reachability-probe
// mistake this replaces, and short of the 600s ceiling the OpenAI/Anthropic SDKs use for
// long completions — an orchestration run/status round trip is shorter-lived than that.
// Env-overridable via the shared non-negative resolver so an explicit 0 is honored
// (near-instant abort) rather than silently treated as unset, and garbage/negative
// values fall back to the default instead of producing a NaN AbortSignal delay.

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function requestTimeoutMs(env) {
  return resolveNonNegativeSetting(env, 'CONSTRUCT_ORCHESTRATION_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
}

// Per-request bound on every remote fetch (ORCH-004; construct-o6t8.2 / construct-neq9.6):
// a timer aborts the request at perRequestMs and races it against a timeout rejection, so
// a hung request settles the call even when the underlying fetch ignores its own signal.
// The timer is cleared the instant either side of the race wins, so a healthy fast response
// leaves no scheduled timer alive to fire and resolve a promise outside its own async scope
// — the leak that tripped node:test's "resolution still pending after the loop resolved". The
// rejection carries the numbered RemoteFetchTimeoutError so a bounded timeout stays
// distinguishable from a genuinely unreachable host, never the signal's own DOMException
// message ("aborted due to timeout" with no number).

class RemoteFetchTimeoutError extends Error {
  constructor(perRequestMs) {
    super(`Remote orchestration request timed out after ${perRequestMs}ms`);
    this.name = 'RemoteFetchTimeoutError';
    this.timeoutMs = perRequestMs;
  }
}

async function timedRemoteFetch(fetchImpl, url, opts, perRequestMs) {
  const controller = new AbortController();
  let clearTimer;
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const err = new RemoteFetchTimeoutError(perRequestMs);
      controller.abort(err);
      reject(err);
    }, perRequestMs);
    clearTimer = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...opts, signal: controller.signal }), timeout]);
  } finally {
    clearTimer();
  }
}

async function runViaService(remote, reqObj, { wait, timeout_ms, workerBackend, fetchImpl, env = process.env, perRequestTimeoutMs = requestTimeoutMs(env) } = {}) {
  const { base, token } = remote;
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const body = JSON.stringify({ ...reqObj, workerBackend });
  let started;
  try {
    const res = await timedRemoteFetch(fetchImpl, `${base}/api/orchestration/runs`, { method: 'POST', headers, body }, perRequestTimeoutMs);
    if (res.status === 401 || res.status === 403) {
      return { error: `Remote service rejected the request (HTTP ${res.status}). Set CONSTRUCT_ORCHESTRATION_TOKEN (or CONSTRUCT_DASHBOARD_TOKEN).`, service: base, failFast: true };
    }
    const envelope = await res.json();
    if (!res.ok) return { error: `Remote service error (HTTP ${res.status}): ${envelope.error || 'unknown'}`, service: base };
    started = envelope.data;
  } catch (err) {
    return remoteFetchFailed(base, err);
  }

  if (!wait) {
    return { runId: started.runId, status: started.status, executionMode: started.execution?.executionMode, service: base, poll: 'orchestration_status with run_id' };
  }

  const deadline = Date.now() + timeout_ms;
  let run = started;
  while (!TERMINAL.includes(run.status)) {
    if (Date.now() > deadline) {
      return { runId: started.runId, status: run.status, timedOut: true, service: base, note: 'Run is still executing; poll it with orchestration_status.' };
    }
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await timedRemoteFetch(fetchImpl, `${base}/api/orchestration/runs/${encodeURIComponent(started.runId)}`, { headers }, perRequestTimeoutMs);
      const envelope = await res.json();
      if (!res.ok) return { error: `Remote service error while polling (HTTP ${res.status}): ${envelope.error || 'unknown'}`, runId: started.runId, service: base };
      run = envelope.data;
    } catch (err) {
      if (err?.name === 'RemoteFetchTimeoutError') {
        return { error: `${err.message} while polling run ${started.runId}. Raise CONSTRUCT_ORCHESTRATION_TIMEOUT_MS if the remote service is healthy but slow.`, runId: started.runId, service: base, failFast: true };
      }
      return { error: `Lost connection to the remote service while polling run ${started.runId}: ${err.message}`, runId: started.runId, service: base, failFast: true };
    }
  }
  return { ...shapeRun(governRemoteWebEvidence(run)), service: base };
}

// The status poll GET carries the same AbortSignal bound as the run POST (ORCH-004),
// so a service that accepts the connection but never replies cannot hang this call
// indefinitely. `timeoutMs` is overridable directly for tests; production callers
// resolve it from env the same way runViaService does.

export async function statusViaService(remote, { run_id, limit } = {}, { fetchImpl, env = process.env, timeoutMs = requestTimeoutMs(env) } = {}) {
  const { base, token } = remote;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const path = run_id ? `/api/orchestration/runs/${encodeURIComponent(run_id)}` : `/api/orchestration/runs?limit=${encodeURIComponent(limit)}`;
  try {
    const res = await timedRemoteFetch(fetchImpl, `${base}${path}`, { headers }, timeoutMs);
    const envelope = await res.json();
    if (!res.ok) return { error: `Remote service error (HTTP ${res.status}): ${envelope.error || 'unknown'}`, service: base };
    // The remote service is out-of-repo and cannot be trusted to have governed its
    // own web evidence (ADR-0050); re-run every run through the F08 grader on the
    // status path exactly as runViaService does, so a citation can never arrive
    // pre-marked trusted. shapeRun then applies the honest terminal-status taxonomy.
    if (Array.isArray(envelope.data)) {
      return envelope.data.map((r) => shapeRun(governRemoteWebEvidence(r)));
    } else if (envelope.data) {
      return shapeRun(governRemoteWebEvidence(envelope.data));
    }
    return envelope.data;
  } catch (err) {
    return remoteFetchFailed(base, err);
  }
}
