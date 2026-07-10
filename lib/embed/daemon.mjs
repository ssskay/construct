/**
 * lib/embed/daemon.mjs — embed mode daemon.
 *
 * Ties together: config, provider registry, scheduler, snapshot engine,
 * approval queue, and output dispatch. This is what `construct embed start`
 * runs.
 *
 * Self-healing jobs (all scheduled, all fire-and-forget):
 *   - snapshot          — polls providers, records errors as observations
 *   - provider-health   — exponential backoff for consistently failing providers
 *   - session-distill   — extracts session summaries into the observation store
 *   - self-repair       — detects degraded state, fixes stale locks and state files
 *   - approval-expiry   — expires stale approval queue items
 *   - eval-dataset-sync — syncs scored traces to telemetry dataset items
 *   - prompt-regression-check — detects low-quality score clusters per promptHash
 *   - inbox-watcher     — ingests new files from inbox/ + CX_INBOX_DIRS into
 *                         observations (agnostic: specs, ADRs, meeting notes, etc.)
 *   - roadmap           — cross-references open items + observations → .cx/roadmap.md
 *
 * Usage:
 *   const daemon = new EmbedDaemon({ configPath, registry });
 *   await daemon.start();
 *   // ...
 *   daemon.stop();
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadEmbedConfig } from './config.mjs';
import { Scheduler } from './scheduler.mjs';
import { rotateIfOversized } from '../logging/rotate.mjs';
import { resolveStatePath } from '../state-root.mjs';
import { SnapshotEngine, renderMarkdown } from './snapshot.mjs';
import { ApprovalQueue } from './approval-queue.mjs';
import { dispatchOutputs } from './output.mjs';
import { AuthorityGuard } from './authority-guard.mjs';
import { ProviderRegistry } from './providers/registry.mjs';
import { addObservation, searchObservations } from '../observation-store.mjs';
import { filterHash, matchesFilter, validateFilterConfig } from '../providers/contract.mjs';
import { recordFilterAudit } from '../providers/filter-audit.mjs';
import { listSessions, loadSession } from '../session-store.mjs';
import { syncEvalDatasets } from '../telemetry/eval-datasets.mjs';
import { runLLMJudgeEvaluations } from '../telemetry/llm-judge.mjs';
import { InboxWatcher } from './inbox.mjs';
import { InboxLiveWatcher } from './inbox-live-watcher.mjs';
import { registerEmbedCapabilityJobs } from './capability-jobs.mjs';
import { createReasoningExecutor } from './reasoning-executor.mjs';
import { generateRoadmap } from './roadmap.mjs';
import { runDocsLifecycle } from './docs-lifecycle.mjs';
import { emitEmbedNotification, notifySlack } from './notifications.mjs';
import { intentToCategory } from './providers/slack.mjs';
import { runTelemetrySetup } from '../telemetry/setup.mjs';
import { emitTraceEvent, newTraceId, newSpanId } from '../worker/trace.mjs';
import { doctorRoot } from '../config/xdg.mjs';
import { resolveNonNegativeSetting } from '../env-config.mjs';
import { checkUnattendedSpend, recordUnattendedSpend } from '../policy/unattended-budget.mjs';

/**
 * Log a non-fatal error to stderr. Use instead of empty catch {} blocks
 * so transient failures produce a visible trail without crashing the daemon.
 */
function logCatch(source, err) {
  process.stderr.write(`[embed] ${source}: ${err?.message ?? String(err)}\n`);
}

/**
 * Resolve an LLM API key via the shared secret resolver (cached op read per process).
 */
async function resolveLLMKey(varName, env) {
  const { resolveSecret } = await import('../providers/secret-resolver.mjs');
  return resolveSecret(varName, { env, cwd: process.cwd() });
}

// ─── Root dir resolution ─────────────────────────────────────────────────────

// Cap upward search so a daemon launched from deep in the filesystem cannot
// fan out to thousands of stat() calls in pathological layouts.

const PROJECT_WALKUP_MAX = 10;

/**
 * Walk up from `startDir` looking for a directory that contains `.cx/context.md`.
 * Returns the project root path, or null if nothing is found within the cap.
 * Exported for unit tests.
 */
export function findProjectRoot(startDir, { maxLevels = PROJECT_WALKUP_MAX } = {}) {
  if (!startDir || typeof startDir !== 'string') return null;
  let current = startDir;
  for (let i = 0; i <= maxLevels; i++) {
    try {
      if (existsSync(join(current, '.cx', 'context.md'))) return current;
    } catch { /* skip unreadable dir */ }
    const parent = dirname(current);
    if (!parent || parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Resolve the daemon's rootDir.
 *
 * Precedence:
 *   1. `CX_DATA_DIR` env override (operator authority)
 *   2. Project root discovered by walking up from `cwd` looking for `.cx/context.md`
 *   3. `homedir()` fallback
 */
export function resolveRootDir(env = process.env, cwd = process.cwd()) {
  const override = (env.CX_DATA_DIR ?? '').trim();
  if (override) return override;
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) return projectRoot;
  return homedir();
}

function resolveWorkspaceDir(env = process.env) {
  return (env.CX_WORKSPACE ?? '').trim() || process.cwd();
}

function resolveLockPath(env = process.env) {
  return join(resolveRootDir(env), '.cx', 'sync.lock');
}

function resolveDaemonStatePath(env = process.env) {
  return resolveStatePath(resolveRootDir(env), 'runtime', 'embed-daemon.json');
}

// ─── Self-repair helpers ────────────────────────────────────────────────────

const LOCK_PATH = join(doctorRoot(), 'sync.lock');
const DAEMON_STATE_PATH = join(doctorRoot(), 'runtime', 'embed-daemon.json');

/**
 * Run in-process health checks and fix what can be fixed.
 * Returns an array of { issue, action } describing what was done.
 */
function runSelfRepair(lockPath = LOCK_PATH, daemonStatePath = DAEMON_STATE_PATH) {
  const actions = [];

   // Check for stale sync lock held by dead process
  if (existsSync(lockPath)) {
    try {
      const holder = readFileSync(lockPath, 'utf8').trim();
      let holderAlive = false;
      try { process.kill(Number(holder), 0); holderAlive = true; } catch { /* dead */ }
      if (!holderAlive) {
        unlinkSync(lockPath);
        actions.push({ issue: `stale sync.lock (pid ${holder})`, action: 'removed' });
      }
    } catch (err) { logCatch('self-repair:lock', err); }
  }

   // Check for stale daemon state pointing to dead PID
  if (existsSync(daemonStatePath)) {
    try {
      const state = JSON.parse(readFileSync(daemonStatePath, 'utf8'));
      if (state.status === 'running' && state.pid && state.pid !== process.pid) {
        let alive = false;
        try { process.kill(state.pid, 0); alive = true; } catch { /* dead */ }
        if (!alive) {
          writeFileSync(daemonStatePath, JSON.stringify({ ...state, status: 'stopped', repairedAt: new Date().toISOString() }, null, 2) + '\n');
          actions.push({ issue: `stale daemon state (pid ${state.pid})`, action: 'marked stopped' });
        }
      }
    } catch (err) { logCatch('daemon.mjs:self-repair-state', err); }
  }

   // Check heap pressure and record warning observation if critical
  try {
    const mem = process.memoryUsage();
    const heapPct = mem.heapUsed / mem.heapTotal;
    if (heapPct >= 0.80) {
      actions.push({ issue: `heap ${Math.round(heapPct * 100)}%`, action: 'observation recorded' });
      // Observation is recorded below when actions are written to the store
    }
  } catch (err) { logCatch('daemon.mjs:heap-check', err); }

  return actions;
}

// ─── Session distillation helpers ────────────────────────────────────────────

/**
 * For each recently completed session that has a summary but no existing
 * session-summary observation, write one into the observation store.
 */
function distillRecentSessions(rootDir) {
  const distilled = [];
  try {
    const recent = listSessions(rootDir, { status: 'completed', limit: 10 });
    for (const entry of recent) {
      if (!entry.summary) continue;

      // Check if we already have a session-summary observation for this session
      const existing = searchObservations(rootDir, entry.id, { category: 'session-summary', limit: 1 });
      const alreadyRecorded = existing.some((o) => o.summary?.includes(entry.id));
      if (alreadyRecorded) continue;

      const full = loadSession(rootDir, entry.id);
      if (!full?.summary) continue;

      const tags = ['session-distill'];
      if (full.project) tags.push(full.project);
      if (Array.isArray(full.filesChanged)) {
        const modules = [...new Set(full.filesChanged.map((f) => f.path?.split('/')[1]).filter(Boolean))];
        tags.push(...modules.slice(0, 4));
      }

      addObservation(rootDir, {
        role: 'construct',
        category: 'session-summary',
        summary: `[${entry.id}] ${full.summary.slice(0, 200)}`,
        content: [
          full.summary,
          full.decisions?.length ? `Decisions: ${full.decisions.join('; ')}` : '',
          full.openQuestions?.length ? `Open: ${full.openQuestions.join('; ')}` : '',
        ].filter(Boolean).join('\n\n'),
        tags,
        project: full.project ?? null,
        confidence: 0.9,
        source: 'session-distill',
      });
      distilled.push(entry.id);
    }
  } catch (err) { logCatch('daemon.mjs:session-distill', err); }
  return distilled;
}

// ─── ADR-0060 filter enforcement (LMCP-B11) ─────────────────────────────────

/**
 * Match each snapshot section back to the source record that produced it.
 * Sections are pushed in config.sources order but a source with no
 * registered provider is skipped upstream (lib/embed/snapshot.mjs), so
 * position alone is unreliable — walk both lists in lockstep, consuming one
 * unmatched source per section by provider name.
 */
function matchSourceForSections(sources) {
  const remaining = [...(sources ?? [])];
  return (providerName) => {
    const idx = remaining.findIndex((s) => s.provider === providerName);
    if (idx === -1) return null;
    return remaining.splice(idx, 1)[0];
  };
}

/**
 * Enforce the ADR-0060 filter block on every snapshot section before any
 * item reaches observation distillation. Validates the source's `filter`
 * config first (fail closed: an unknown/invalid key throws, the section's
 * items are dropped entirely, and the failure is recorded as a source
 * error visible in the snapshot). Valid filters run the plane-side
 * `matchesFilter` predicate over every item — the mandatory backstop even
 * when the provider already pushed the filter down server-side — and a
 * `{provider, instance, filterHash, matched, dropped}` audit line is
 * appended per section, matched or not.
 *
 * Mutates `snapshot.sections[].items` in place and appends to
 * `snapshot.errors` on a filter config failure. Returns nothing.
 */
export function enforceSectionFilters(rootDir, snapshot, sources) {
  const nextSourceFor = matchSourceForSections(sources);

  for (const section of snapshot.sections ?? []) {
    const source = nextSourceFor(section.provider);
    const filter = source?.filter ?? null;
    const fetched = section.items?.length ?? 0;

    if (filter == null) {
      recordFilterAudit(rootDir, {
        provider: section.provider,
        instance: source?.instance ?? null,
        filterHash: null,
        pushdown: false,
        fetched,
        matched: fetched,
      });
      continue;
    }

    try {
      validateFilterConfig(section.provider, filter);
    } catch (err) {
      section.items = [];
      snapshot.errors = snapshot.errors ?? [];
      snapshot.errors.push({ source: section.provider, error: `filter config: ${err.message}` });
      recordFilterAudit(rootDir, {
        provider: section.provider,
        instance: source?.instance ?? null,
        filterHash: filterHash(filter),
        scope: filter.scope ?? null,
        predicates: filter.predicates ?? null,
        nativeQuery: filter.nativeQuery ?? null,
        pushdown: false,
        fetched,
        matched: 0,
      });
      continue;
    }

    const admitted = (section.items ?? []).filter((item) => matchesFilter(item, filter));
    section.items = admitted;

    recordFilterAudit(rootDir, {
      provider: section.provider,
      instance: source?.instance ?? null,
      filterHash: filterHash(filter),
      scope: filter.scope ?? null,
      predicates: filter.predicates ?? null,
      nativeQuery: filter.nativeQuery ?? null,
      pushdown: Boolean(filter.nativeQuery) || Boolean(filter.scope?.projects?.length),
      fetched,
      matched: admitted.length,
    });
  }
}

/**
 * Distill snapshot items (issues, PRs, messages) into the observation store.
 * Skips items already recorded in this snapshot cycle using a dedup key.
 * Returns the count of new observations written.
 */
export async function distillSnapshotItems(rootDir, sections) {
  let written = 0;
  for (const section of sections ?? []) {
    for (const item of section.items ?? []) {
      try {
        const dedupKey = item.key ?? item.id ?? item.url ?? item.hash;
        if (!dedupKey) continue;

        // Check if we already have a recent observation for this exact item key
        const existing = await searchObservations(rootDir, dedupKey, { limit: 1 });
        if (existing.some((o) => o.tags?.includes(`item:${dedupKey}`))) continue;

        const summary = buildItemSummary(item, section.provider);
        if (!summary) continue;

        // Determine category: Slack messages use channel intent; issues use status signals
        let category = 'insight';
        if (item.intent) {
          category = intentToCategory(item.intent);
        } else if (item.type === 'issue') {
          const s = String(item.status ?? '').toLowerCase();
          if (/blocked|critical|urgent/.test(s)) category = 'anti-pattern';
        }

        const tags = ['snapshot-item', section.provider, `item:${dedupKey}`];
        if (item.intent) tags.push(`intent:${item.intent}`);
        if (item.channelName) tags.push(`channel:${item.channelName}`);
        if (item.status) tags.push(`status:${item.status}`);
        if (item.priority) tags.push(`priority:${item.priority}`);
        if (Array.isArray(item.labels)) tags.push(...item.labels.map((l) => `label:${l}`));
        if (item.author) tags.push(`author:${item.author}`);

        addObservation(rootDir, {
          role: 'construct',
          category,
          summary,
          content: buildItemContent(item, section.provider),
          tags: tags.slice(0, 10),
          confidence: 0.8,
          source: 'snapshot-distill',
        });
        written += 1;
      } catch (err) { logCatch('daemon.mjs:snapshot-distill', err); }
    }
  }
  return written;
}

function buildItemSummary(item, provider) {
  if (item.type === 'issue') {
    return `[${provider}] ${item.key ?? ''} ${item.summary ?? item.title ?? ''} (${item.status ?? 'unknown'})`.trim();
  }
  if (item.type === 'commit') {
    return `[${provider}] commit ${item.hash?.slice(0, 7) ?? ''}: ${item.subject ?? ''}`.trim();
  }
  if (item.type === 'message') {
    return `[${provider}] message from ${item.user ?? 'unknown'}: ${(item.text ?? '').slice(0, 80)}`.trim();
  }
  if (item.type === 'page') {
    return `[${provider}] page: ${item.title ?? ''}`.trim();
  }
  if (item.title || item.summary) {
    return `[${provider}] ${item.title ?? item.summary ?? ''}`.trim();
  }
  return null;
}

function buildItemContent(item, provider) {
  const lines = [`provider: ${provider}`];
  if (item.type) lines.push(`type: ${item.type}`);
  if (item.key) lines.push(`key: ${item.key}`);
  if (item.url) lines.push(`url: ${item.url}`);
  if (item.status) lines.push(`status: ${item.status}`);
  if (item.priority) lines.push(`priority: ${item.priority}`);
  if (item.assignee) lines.push(`assignee: ${item.assignee}`);
  if (item.author) lines.push(`author: ${item.author}`);
  if (Array.isArray(item.labels) && item.labels.length) lines.push(`labels: ${item.labels.join(', ')}`);
  if (item.description) lines.push(`\ndescription:\n${String(item.description).slice(0, 500)}`);
  if (item.body) lines.push(`\nbody:\n${String(item.body).slice(0, 500)}`);
  return lines.join('\n');
}

// ─── Provider health tracker ─────────────────────────────────────────────────

const BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

class ProviderHealthTracker {
  #errors = new Map(); // provider → { count, suppressUntil }

  recordSuccess(provider) {
    this.#errors.delete(provider);
  }

  recordError(provider) {
    const prev = this.#errors.get(provider) ?? { count: 0, suppressUntil: 0 };
    const count = prev.count + 1;
    const step = Math.min(count - 1, BACKOFF_STEPS_MS.length - 1);
    const suppressUntil = Date.now() + BACKOFF_STEPS_MS[step];
    this.#errors.set(provider, { count, suppressUntil });
    return count;
  }

  isSuppressed(provider) {
    const entry = this.#errors.get(provider);
    if (!entry) return false;
    return Date.now() < entry.suppressUntil;
  }

  summary() {
    return [...this.#errors.entries()].map(([provider, e]) => ({
      provider,
      consecutiveErrors: e.count,
      suppressedUntil: new Date(e.suppressUntil).toISOString(),
    }));
  }
}

// ─── Daemon ───────────────────────────────────────────────────────────────────

export class EmbedDaemon {
  #config = null;
  #registry = null;
  #env = null;
  #scheduler = null;
  #snapshotEngine = null;
  #approvalQueue = null;
  #authorityGuard = null;
  #status = 'stopped';
  #lastSnapshot = null;
  #configPath = null;
  #persistPath = null;
  #rootDir = null;
  #workspaceDir = null;
  #lockPath = null;
  #daemonStatePath = null;
  #inboxWatcher = null;
  #inboxLiveWatcher = null;
  #capabilityIds = [];
  #providerHealth = new ProviderHealthTracker();
  #daemonTraceId = null;

  /**
   * @param {object} opts
   * @param {string} opts.configPath          - Path to embed.yaml
   * @param {ProviderRegistry} [opts.registry] - Pre-built registry (default: fromEnv)
   * @param {object} [opts.env]               - Env override (default: process.env)
   * @param {string} [opts.persistPath]       - Approval queue persistence path
   * @param {string} [opts.rootDir]           - Root dir for observation/session stores (default: homedir())
   * @param {string} [opts.workspaceDir]      - Project workspace dir for project-relative focal resources (default: cwd or CX_WORKSPACE)
   */
  constructor({ configPath, config, registry, env, persistPath, rootDir, workspaceDir } = {}) {
    this.#configPath = configPath;
    this.#config = config ?? null;
    this.#registry = registry ?? null;
    this.#env = env ?? process.env;
    this.#persistPath = persistPath;
    this.#rootDir = rootDir ?? resolveRootDir(env ?? process.env);
    this.#workspaceDir = workspaceDir ?? resolveWorkspaceDir(env ?? process.env);
    this.#lockPath = resolveLockPath(this.#env);
    this.#daemonStatePath = resolveDaemonStatePath(this.#env);
    this.#inboxWatcher = new InboxWatcher({ rootDir: this.#rootDir, env: this.#env, cwd: this.#rootDir });
    this.#inboxLiveWatcher = null;
  }

  async start() {
    if (this.#status === 'running') throw new Error('EmbedDaemon is already running');

    // Use injected config, or load from file path
    if (!this.#config) {
      this.#config = loadEmbedConfig(this.#configPath);
    }

    // Build the provider registry from env if one wasn't injected (normal runtime path)
    if (!this.#registry) {
      this.#registry = await ProviderRegistry.fromEnv(this.#env);
    }
    this.#scheduler = new Scheduler();
    this.#snapshotEngine = new SnapshotEngine(this.#registry, this.#config, { rootDir: this.#rootDir, workspaceDir: this.#workspaceDir });
    this.#approvalQueue = new ApprovalQueue({
      require: this.#config.approval.require,
      timeoutMs: this.#config.approval.timeout_ms,
      fallback: this.#config.approval.fallback,
      persistPath: this.#persistPath,
    });
    this.#authorityGuard = new AuthorityGuard(
      this.#config.operatingProfile,
      this.#approvalQueue,
    );

    // Initialize providers for all sources
    for (const source of this.#config.sources) {
      const provider = this.#registry.get(source.provider);
      if (!provider) {
        process.stderr.write(`[embed] Warning: provider "${source.provider}" not registered — skipping\n`);
      }
    }

    // ── Job 1: snapshot ───────────────────────────────────────────────────────
    // Generate snapshot, record provider errors as observations, apply backoff.
    this.#scheduler.register(
      'snapshot',
      this.#config.snapshot.intervalMs,
      async () => {
        const snapshot = await this.#snapshotEngine.generate();

        // ADR-0060: drop out-of-filter items before anything downstream
        // (outputs, distillation, roadmap) can see them.
        enforceSectionFilters(this.#rootDir, snapshot, this.#config.sources);

        this.#lastSnapshot = snapshot;
        await dispatchOutputs(snapshot, this.#config.outputs, this.#registry, this.#authorityGuard, this.#rootDir);
        process.stderr.write(`[embed] Snapshot generated at ${snapshot.completedAt} — ${snapshot.summary.totalItems} items, ${snapshot.summary.errorCount} errors\n`);

        // Record provider errors as observations so they surface in future sessions
        for (const err of snapshot.errors ?? []) {
          const count = this.#providerHealth.recordError(err.source);
          const summary = `Provider ${err.source} error (${count} consecutive): ${err.error}`;
          addObservation(this.#rootDir, {
            role: 'construct',
            category: count >= 3 ? 'anti-pattern' : 'insight',
            summary,
            content: `Source: ${err.source}\nRef: ${err.ref ?? 'n/a'}\nError: ${err.error}\nConsecutive failures: ${count}`,
            tags: ['embed', 'provider-error', err.source],
            confidence: 0.95,
            source: 'embed-daemon',
          });
          if (count >= 3) {
            process.stderr.write(`[embed] Provider "${err.source}" has failed ${count} times — backing off\n`);
          }
        }

        // Record success for providers that came back clean
        for (const section of snapshot.sections ?? []) {
          this.#providerHealth.recordSuccess(section.provider);
        }

        // Distill snapshot items (issues, PRs, messages) into observation store
        const itemsWritten = await distillSnapshotItems(this.#rootDir, snapshot.sections ?? []);
        if (itemsWritten) {
          process.stderr.write(`[embed] Distilled ${itemsWritten} snapshot item(s) into observation store\n`);
        }

        // Regenerate roadmap each tick unless disabled by the host config.
        if (process.env.CONSTRUCT_EMBED_ROADMAP_ENABLED !== '0') {
          try {
            const roadmap = generateRoadmap({ targetPath: this.#rootDir, snapshot, roles: this.#config?.roles });
            if (!roadmap.skipped) {
              process.stderr.write(`[embed] Roadmap refreshed: ${roadmap.itemCount} open item(s) → ${roadmap.path}\n`);
            }
          } catch (err) {
            process.stderr.write(`[embed] Roadmap refresh failed: ${err.message}\n`);
          }
        }
      },
      { runImmediately: true },
    );

    // ── Job 2: provider-health ─────────────────────────────────────────────────
    // Every 5 min — log suppressed providers and write a health observation if any
    // have been suppressed for a full backoff cycle.
    this.#scheduler.register(
      'provider-health',
      5 * 60_000,
      async () => {
        const degraded = this.#providerHealth.summary();
        if (!degraded.length) return;
        process.stderr.write(`[embed] Provider health: ${JSON.stringify(degraded)}\n`);
        const criticalProviders = degraded.filter((p) => p.consecutiveErrors >= 3);
        if (criticalProviders.length) {
          addObservation(this.#rootDir, {
            role: 'construct',
            category: 'anti-pattern',
            summary: `${criticalProviders.length} provider(s) in backoff: ${criticalProviders.map((p) => p.provider).join(', ')}`,
            content: JSON.stringify(criticalProviders, null, 2),
            tags: ['embed', 'provider-health', 'backoff'],
            confidence: 0.9,
            source: 'embed-daemon',
          });
        }
      },
    );

    // ── Job 3: session-distill ─────────────────────────────────────────────────
    // Every 30 min — extract completed session summaries into the observation store.
    this.#scheduler.register(
      'session-distill',
      30 * 60_000,
      async () => {
        const distilled = distillRecentSessions(this.#rootDir);
        if (distilled.length) {
          process.stderr.write(`[embed] Distilled ${distilled.length} session(s) into observation store\n`);
        }
      },
      { runImmediately: true },
    );



    // ── Job 4: self-repair ────────────────────────────────────────────────────
    // Every 5 min — detect and fix stale locks, stale state files, heap pressure.
    this.#scheduler.register(
      'self-repair',
      5 * 60_000,
      async () => {
        const actions = runSelfRepair(this.#lockPath, this.#daemonStatePath);
        for (const { issue, action } of actions) {
          process.stderr.write(`[embed] Self-repair: ${issue} → ${action}\n`);
          addObservation(this.#rootDir, {
            role: 'construct',
            category: action === 'observation recorded' ? 'insight' : 'pattern',
            summary: `Self-repair: ${issue} → ${action}`,
            content: `Daemon self-repair triggered at ${new Date().toISOString()}\nIssue: ${issue}\nAction: ${action}`,
            tags: ['self-repair', 'daemon'],
            confidence: 0.85,
            source: 'embed-daemon',
          });
        }
      },
      { runImmediately: true },
    );

    // ── Job 5: approval-expiry ────────────────────────────────────────────────
    this.#scheduler.register(
      'approval-expiry',
      60_000,
      async () => {
        const expired = this.#approvalQueue.expireStale();
        if (expired.length) {
          process.stderr.write(`[embed] Expired ${expired.length} stale approval item(s)\n`);
        }
      },
    );

    // ── Job 6: daemon-log-rotation ────────────────────────────────────────────
    // OS supervisors (launchd/systemd/schtasks) redirect daemon stdout to
    // ~/.cx/runtime/embed-daemon.log with no rotation. A stuck telemetry
    // log line filled it to 34 GB on one local install; rotate proactively.
    // CONSTRUCT_EMBED_LOG_MAX_MB overrides the default 50 MB cap.

    this.#scheduler.register(
      'daemon-log-rotation',
      60_000,
      async () => {
        const logPath = join(doctorRoot(), 'runtime', 'embed-daemon.log');
        const capMb = resolveNonNegativeSetting(process.env, 'CONSTRUCT_EMBED_LOG_MAX_MB', 50);
        const maxBytes = Math.floor(capMb * 1024 * 1024);
        const maxSegments = resolveNonNegativeSetting(process.env, 'CONSTRUCT_EMBED_LOG_MAX_SEGMENTS', 5);
        await rotateIfOversized(logPath, { maxBytes, maxSegments, gzip: true });
      },
      { runImmediately: true },
    );

    // ── Job 7: rss-cap ────────────────────────────────────────────────────────
    const { memoryCapMbFor, rssOverCap, currentRssMb } = await import('../resources/process-budget.mjs');
    const rssCapMb = memoryCapMbFor('embed-daemon', this.#rootDir, this.#env);
    this.#scheduler.register(
      'rss-cap',
      60_000,
      async () => {
        if (!rssOverCap(rssCapMb)) return;
        process.stderr.write(
          `[embed] RSS ${Math.round(currentRssMb())}MB exceeds cap ${rssCapMb}MB — stopping daemon\n`,
        );
        this.stop();
      },
    );

    // ── Job 0: telemetry-setup ───────────────────────────────────────────────────
// On startup — ensure annotation queues and eval configs exist (idempotent)
this.#scheduler.register(
  'telemetry-setup',
  0, // run immediately
  async () => {
    try {
      const result = await runTelemetrySetup({
        publicKey: this.#env.CONSTRUCT_TELEMETRY_PUBLIC_KEY,
        secretKey: this.#env.CONSTRUCT_TELEMETRY_SECRET_KEY,
        baseUrl: this.#env.CONSTRUCT_TELEMETRY_URL,
        env: this.#env,
      });

      if (result.ok && result.results?.length) {
        const ok = result.results.filter(r => r.success).length;
        const total = result.results.length;
        process.stderr.write(`[embed] Telemetry setup: ${ok}/${total} resources configured\n`);
      } else if (!result.ok && !result.error?.includes('required')) {
        // Suppress the "keys required" message — normal for solo mode without telemetry configured.
        process.stderr.write(`[embed] Telemetry setup skipped: ${result.error}\n`);
      } else if (result.results?.some(r => !r.success)) {
        const failures = result.results.filter(r => !r.success);
        process.stderr.write(`[embed] Telemetry setup: ${failures.length} resource(s) failed\n`);
      }
    } catch (err) {
      process.stderr.write(`[embed] Telemetry setup error: ${err.message}\n`);
    }
  },
  { runImmediately: true, repeat: false } // one-time startup job
);

// ── Job 6: eval-dataset-sync ──────────────────────────────────────────────
    // Every 6h — read scored traces and upsert as dataset items
    // so prompt regressions are visible in the telemetry backend UI.
    this.#scheduler.register(
      'eval-dataset-sync',
      6 * 60 * 60_000,
      async () => {
        const result = await syncEvalDatasets({ env: this.#env, bestEffort: true });
        if (result.synced || result.errors.length) {
          process.stderr.write(`[embed] Eval datasets: synced=${result.synced} skipped=${result.skipped} errors=${result.errors.length}\n`);
        }
        if (result.synced) {
          addObservation(this.#rootDir, {
            role: 'construct',
            category: 'insight',
            summary: `Eval dataset sync: ${result.synced} trace(s) upserted to telemetry datasets`,
            content: `synced=${result.synced} skipped=${result.skipped} errors=${result.errors.length}\n${result.errors.join('\n')}`,
            tags: ['eval', 'telemetry', 'dataset-sync'],
            confidence: 0.9,
            source: 'embed-daemon',
          });
        }
      },
    );

    // ── Job 7: prompt-regression-check ───────────────────────────────────────
    // Every 12h — scan recent observations for clusters of low-quality scores
    // that correlate with a specific promptHash. If found, record an anti-pattern
    // so future sessions know a prompt change degraded quality.
    this.#scheduler.register(
      'prompt-regression-check',
      12 * 60 * 60_000,
      async () => {
        try {
          const rootDir = this.#rootDir;
          // Get recent low-score observations
          const lowScores = searchObservations(rootDir, 'low quality score', {
            category: 'anti-pattern',
            limit: 20,
          });
          if (lowScores.length < 3) return; // not enough signal

          // Check if multiple low scores share a prompt version tag
          const promptVersionCounts = {};
          for (const obs of lowScores) {
            const match = obs.content?.match(/promptVersion[:\s]+([a-f0-9]{8,12})/i);
            if (match) {
              const v = match[1];
              promptVersionCounts[v] = (promptVersionCounts[v] ?? 0) + 1;
            }
          }
          for (const [version, count] of Object.entries(promptVersionCounts)) {
            if (count >= 3) {
              // Check we haven't already recorded this regression
              const existing = searchObservations(rootDir, `prompt regression ${version}`, { limit: 1 });
              if (existing.some((o) => o.summary?.includes(version))) continue;

              addObservation(rootDir, {
                role: 'construct',
                category: 'anti-pattern',
                summary: `Prompt regression detected: version ${version} has ${count} low-quality scores`,
                content: `Prompt version ${version} appears in ${count} low-quality score observations.\nThis may indicate a prompt change degraded agent output quality.\nReview traces with promptVersion=${version} in the telemetry backend.`,
                tags: ['prompt-regression', 'quality', version],
                confidence: 0.85,
                source: 'embed-daemon',
              });
              process.stderr.write(`[embed] Prompt regression detected: version ${version} (${count} low scores)\n`);
            }
          }
        } catch (err) { logCatch('daemon.mjs:prompt-regression', err); }
      },
    );

     // ── Job 8: llm-judge-evaluations ──────────────────────────────────────────
     // Every 3h — automatically evaluate unscored traces using LLM-as-a-judge
     this.#scheduler.register(
       'llm-judge-evaluations',
       3 * 60 * 60_000,
       async () => {
        try {
          const result = await runLLMJudgeEvaluations({
            env: this.#env,
            rootDir: this.#rootDir,
            bestEffort: true,
            limit: 5, // Conservative limit to manage LLM costs
          });
          
          if (result.evaluated || result.errors.length) {
            process.stderr.write(`[embed] LLM judge: evaluated=${result.evaluated} errors=${result.errors.length}\n`);
          }
          
          if (result.evaluated) {
            addObservation(this.#rootDir, {
              role: 'construct',
              category: 'insight',
              summary: `LLM judge evaluated ${result.evaluated} trace(s) for quality`,
              content: `evaluated=${result.evaluated} errors=${result.errors.length}\n${result.errors.join('\n')}`,
              tags: ['llm-judge', 'auto-evaluation', 'quality'],
              confidence: 0.9,
              source: 'embed-daemon',
            });
          }
        } catch (err) {
          process.stderr.write(`[embed] LLM judge job failed: ${err.message}\n`);
        }
      },
    );

    // ── Job 9: inbox-watcher ──────────────────────────────────────────────────
    // Every 2 min — scan configured inbox dirs for new files, ingest them, and
    // record observations. Agnostic to content: specs, ADRs, meeting notes,
    // internal docs, PDFs, Office files — anything on the local filesystem.
    // Dirs: <rootDir>/inbox/ always; CX_INBOX_DIRS env for extra paths.
    this.#scheduler.register(
      'inbox-watcher',
      2 * 60_000,
      async () => {
        const result = await this.#inboxWatcher.poll();
        if (result.processed.length) {
          const { getRebrand } = await import('../scopes/rebrand.mjs');
          const { signalNoun } = getRebrand(this.#rootDir);
          const noun = result.processed.length === 1 ? signalNoun : `${signalNoun}s`;
          process.stderr.write(`[embed] Classified ${result.processed.length} ${noun} from [${result.dirs.join(', ')}]\n`);
          addObservation(this.#rootDir, {
            role: 'construct',
            category: 'insight',
            summary: `Inbox ingest: ${result.processed.length} file(s) processed from local filesystem`,
            content: result.processed.map((f) => `${f.path} → ${f.outputPath} (${f.characters} chars)`).join('\n'),
            tags: ['inbox', 'ingest-batch'],
            confidence: 0.85,
            source: 'inbox-watcher',
          });
        }
        if (result.errors.length) {
          process.stderr.write(`[embed] Inbox errors: ${result.errors.map((e) => `${e.path}: ${e.error}`).join('; ')}\n`);
          for (const e of result.errors) {
            addObservation(this.#rootDir, {
              role: 'construct',
              category: 'anti-pattern',
              summary: `Inbox ingest error: ${e.path.split('/').pop()}: ${e.error}`,
              content: `path: ${e.path}\nerror: ${e.error}`,
              tags: ['inbox', 'ingest-error'],
              confidence: 0.9,
              source: 'inbox-watcher',
            });
          }
        }
       },
      { runImmediately: true },
    );

    // ── Job 10: roadmap ───────────────────────────────────────────────────────
    // Every hour — cross-reference open items from last snapshot with observation
    // store (risks, decisions, patterns) and write a prioritised roadmap to
    // <rootDir>/.cx/roadmap.md. Optionally posts a summary to Slack.
    this.#scheduler.register(
      'roadmap',
      60 * 60_000,
      async () => {
        if (process.env.CONSTRUCT_EMBED_ROADMAP_ENABLED === '0') return;
        if (!this.#lastSnapshot) return; // wait until at least one snapshot exists
        try {
          const result = generateRoadmap({ targetPath: this.#rootDir, snapshot: this.#lastSnapshot, roles: this.#config?.roles });
          if (!result.skipped) {
            process.stderr.write(`[embed] Roadmap updated: ${result.itemCount} open item(s) → ${result.path}\n`);
            emitEmbedNotification({
              type: 'success',
              source: 'roadmap',
              message: `Roadmap updated: ${result.itemCount} open item(s)`,
              meta: { path: result.path, itemCount: result.itemCount },
            });
            addObservation(this.#rootDir, {
              role: 'construct',
              category: 'insight',
              summary: `Roadmap generated: ${result.itemCount} open item(s) prioritised`,
              content: `path: ${result.path}\nitems: ${result.itemCount}\nupdatedAt: ${result.updatedAt}`,
              tags: ['roadmap', 'prioritisation'],
              confidence: 0.8,
              source: 'roadmap-job',
            });

            // Post to Slack if provider is available and authority allows
            const slackProvider = this.#registry?.get('slack');
            if (slackProvider) {
              const channel = this.#env.SLACK_CHANNELS?.split(',')[0]?.trim()
                ?? this.#env.SLACK_CHANNEL?.trim();
              if (channel) {
                try {
                  const authorityResult = await this.#authorityGuard.check('externalPost', {
                    description: `Post roadmap summary to Slack channel ${channel}`,
                  });
                  if (authorityResult.allowed) {
                    const { roadmapSlackSummary } = await import('./roadmap.mjs');
                    const text = roadmapSlackSummary({ targetPath: this.#rootDir, snapshot: this.#lastSnapshot, roles: this.#config?.roles });
                    if (text) await slackProvider.write({ channel, text });
                  } else {
                    process.stderr.write(`[embed] Roadmap Slack post queued for approval (id: ${authorityResult.queueId})\n`);
                  }
                } catch (err) { logCatch('daemon.mjs:roadmap-slack', err); }
              }
            }
          }
        } catch (err) {
          process.stderr.write(`[embed] Roadmap job error: ${err.message}\n`);
        }
      },
    );

    // ── Job 11: docs-lifecycle ──────────────────────────────────────────────────
    // Every 30 minutes — detect stale/missing docs, auto-fix low-risk gaps,
    // queue high-risk changes for approval.
    this.#scheduler.register(
      'docs-lifecycle',
      30 * 60_000,
      async () => {
        if (!this.#lastSnapshot) return;
        try {
          // Load pending intake packets for conflict detection
          const pendingPackets = [];
          try {
            const pendingDir = join(this.#rootDir, '.cx', 'intake', 'pending');
            if (existsSync(pendingDir)) {
              for (const file of readdirSync(pendingDir)) {
                if (!file.endsWith('.json')) continue;
                try {
                  const data = JSON.parse(readFileSync(join(pendingDir, file), 'utf8'));
                  data.id = file.replace('.json', '');
                  pendingPackets.push(data);
                } catch { /* skip malformed */ }
              }
            }
          } catch { /* intake dir not available */ }

          const snapshotWithIntake = this.#lastSnapshot
            ? { ...this.#lastSnapshot, intakePackets: pendingPackets }
            : null;

          const result = await runDocsLifecycle({
            config: this.#config,
            providerRegistry: this.#registry,
            snapshot: snapshotWithIntake,
            authorityGuard: this.#authorityGuard,
            signals: { rootDir: this.#rootDir },
          });
          const autoFixed = result.actions.filter((a) => a.action === 'auto-fix').length;
          const queued = result.actions.filter((a) => a.action === 'queued').length;
          if (result.gaps.length > 0 || result.conflicts?.length) {
            process.stderr.write(
              `[embed] Docs lifecycle: ${result.gaps.length} gap(s), ${result.conflicts?.length || 0} conflict(s), ${result.recommendations?.length || 0} recommendation(s), ${autoFixed} auto-fixed, ${queued} queued\n`,
            );
            emitEmbedNotification({
              type: queued > 0 || result.conflicts?.length > 0 ? 'warning' : 'info',
              source: 'docs-lifecycle',
              message: `${result.gaps.length} gap(s), ${result.recommendations?.length || 0} active recommendation(s)`,
              meta: { gaps: result.gaps.length, conflicts: result.conflicts?.length || 0, recommendations: result.recommendations?.length || 0, autoFixed, queued },
            });
          }
          try {
            emitTraceEvent({
              rootDir: this.#rootDir,
              eventType: 'lifecycle.completed',
              traceId: this.#daemonTraceId,
              spanId: newSpanId(),
              env: this.#env,
              metadata: {
                gaps: result.gaps.length,
                conflicts: result.conflicts?.length || 0,
                recommendations: result.recommendations?.length || 0,
                autoFixed,
                queued,
                targets: result.targets,
              },
            });
          } catch { /* observability must not break the caller */ }
        } catch (err) {
          process.stderr.write(`[embed] Docs lifecycle error: ${err.message}\n`);
        }
      },
    );

    // ── Job 12: execution-gap ──────────────────────────────────────
    // Every 2 hours — compare strategy/PRDs/RFCs with Jira tickets,
    // identify execution gaps, create补缺 tickets via operator role (TPM function).
    this.#scheduler.register(
      'execution-gap',
      2 * 60 * 60_000,
       async () => {
        try {
          const result = await this.#runExecutionGapAnalysis();
          // Store gaps in the last snapshot for reporting
          if (this.#lastSnapshot) {
            this.#lastSnapshot.executionGaps = result.gaps;
          }
          if (result.gaps.length > 0) {
            process.stderr.write(
              `[embed] Execution gap: ${result.gaps.length} gap(s) found, ${result.ticketsCreated} ticket(s) created\n`,
            );
            emitEmbedNotification({
              type: result.highRiskCount > 0 ? 'warning' : 'info',
              source: 'execution-gap',
              message: `${result.gaps.length} execution gap(s): ${result.ticketsCreated} ticket(s) created`,
              meta: { gaps: result.gaps.length, ticketsCreated: result.ticketsCreated, highRisk: result.highRiskCount },
            });
          } else {
            process.stderr.write(`[embed] Execution gap: no gaps detected\n`);
          }
        } catch (err) {
          process.stderr.write(`[embed] Execution gap error: ${err.message}\n`);
        }
      },
      { runImmediately: true },
    );

    // ── Job 13: telemetry-heartbeat ──────────────────────────────────────
    // Every 5 min — emit a daemon.heartbeat trace event so telemetry backends
    // always have recent data, even when no agent/worker activity has occurred.
    this.#scheduler.register(
      'telemetry-heartbeat',
      5 * 60_000,
      async () => {
        try {
          const daemonId = this.#daemonTraceId || `daemon-${process.pid}`;
          emitTraceEvent({
            rootDir: this.#rootDir,
            eventType: 'daemon.heartbeat',
            traceId: this.#daemonTraceId,
            spanId: newSpanId(),
            env: this.#env,
            metadata: {
              pid: process.pid,
              uptimeMs: process.uptime() * 1000,
              schedulerTasks: this.#scheduler?.status()?.length ?? 0,
            },
          });
        } catch (err) {
          process.stderr.write(`[embed] Telemetry heartbeat: ${err.message}\n`);
        }
      },
      { runImmediately: true },
    );

    // ── Job 14: telemetry-generation ─────────────────────────────────────────
    // Every 5 min — make a tiny LLM call and record it as a telemetry generation
    // observation so external telemetry backends always have recent data to display,
    // even when no agent sessions are active.
    this.#scheduler.register(
      'telemetry-generation',
      5 * 60_000,
      async () => {
        try {
          const { randomUUID } = await import('node:crypto');
          const { readCurrentModels } = await import('../../lib/model-router.mjs');
          const { createIngestClient } = await import('../../lib/telemetry/ingest.mjs');
          const env = this.#env;

          // Pick the cheapest configured model (fast tier) for the probe call
          let modelId = null;
          try {
            const models = readCurrentModels(null, {});
            modelId = models.fast || models.standard || null;
          } catch { /* no models configured */ }

          // Multi-source credential resolution — env → config.env → shell rc → 1Password
          const orKey = await resolveLLMKey('OPENROUTER_API_KEY', env)
            || await resolveLLMKey('OPEN_ROUTER_API_KEY', env)
            || process.env.OPENROUTER_API_KEY;
          const anthKey = await resolveLLMKey('ANTHROPIC_API_KEY', env) || process.env.ANTHROPIC_API_KEY;
          if (!modelId || !(orKey || anthKey)) return; // no LLM available — skip

          // construct-95phc.3: nothing spends unattended without a configured
          // budget. An unconfigured 'embed-telemetry-probe' cap resolves to
          // {tokens: 0} (fail closed) — this tick is skipped, not run unbounded.
          const budgetCheck = checkUnattendedSpend(this.#rootDir, 'embed-telemetry-probe', 32, { env });
          if (!budgetCheck.allowed) {
            process.stderr.write(`[embed] Telemetry probe skipped: ${budgetCheck.reason} (spent ${budgetCheck.spent}/${budgetCheck.cap ?? 0} tokens today)\n`);
            return;
          }

          const traceId = randomUUID();
          const genId = randomUUID();
          const startTime = Date.now();

          // Build the ingest client to write generation observations to telemetry backend
          const ingest = createIngestClient({
            publicKey: env.CONSTRUCT_TELEMETRY_PUBLIC_KEY || process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY,
            secretKey: env.CONSTRUCT_TELEMETRY_SECRET_KEY || process.env.CONSTRUCT_TELEMETRY_SECRET_KEY,
            baseUrl: env.CONSTRUCT_TELEMETRY_URL || process.env.CONSTRUCT_TELEMETRY_URL,
            onError: () => {},
          });

          if (!ingest.available) return;

          const isAnthropic = modelId.startsWith('anthropic/');
          const stripped = modelId.replace(/^(openrouter\/)?/, '');
          const probePrompt = 'Respond with exactly one word: ping.';
          let output = '';
          let inputTokens = 0;
          let outputTokens = 0;

          ingest.trace({
            id: traceId,
            name: 'telemetry.probe',
            input: probePrompt,
            metadata: { source: 'daemon', model: modelId },
            timestamp: new Date(startTime).toISOString(),
          });

          ingest.generation({
            id: genId,
            traceId,
            name: 'llm.probe',
            model: modelId,
            modelParameters: { maxOutputTokens: 16 },
            startTime: new Date(startTime).toISOString(),
            input: probePrompt,
          });

          try {
            if (isAnthropic && anthKey) {
              const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'x-api-key': anthKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
                },
                body: JSON.stringify({
                  model: stripped, max_tokens: 16,
                  messages: [{ role: 'user', content: probePrompt }],
                }),
              });
              if (res.ok) {
                const data = await res.json();
                output = data.content?.[0]?.text || '';
                inputTokens = data.usage?.input_tokens || 0;
                outputTokens = data.usage?.output_tokens || 0;
              }
            } else if (orKey) {
              const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${orKey}`, 'content-type': 'application/json',
                  'HTTP-Referer': 'https://github.com/geraldmaron/construct',
                },
                body: JSON.stringify({
                  model: modelId.replace(/^openrouter\//, ''),
                  max_tokens: 16,
                  messages: [
                    { role: 'system', content: 'You are a health check probe.' },
                    { role: 'user', content: probePrompt },
                  ],
                }),
              });
              if (res.ok) {
                const data = await res.json();
                output = data.choices?.[0]?.message?.content || '';
                inputTokens = data.usage?.prompt_tokens || 0;
                outputTokens = data.usage?.completion_tokens || 0;
              }
            }
          } catch (probeErr) {
            // Probe call failed; record the timing entry but surface the
            // failure to the daemon log so operators can distinguish a 0ms
            // success from a hard error. Don't crash the daemon.
            process.stderr.write(`[embed] Probe call failed: ${probeErr.message}\n`);
          }

          const endTime = Date.now();

          if (inputTokens + outputTokens > 0) {
            recordUnattendedSpend(this.#rootDir, 'embed-telemetry-probe', inputTokens + outputTokens, { env });
          }

          ingest.generationUpdate({
            id: genId,
            traceId,
            endTime: new Date(endTime).toISOString(),
            output: output || '(empty)',
            usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, unit: 'TOKENS' },
            metadata: { latencyMs: endTime - startTime },
          });

          await ingest.flush();
        } catch (err) {
          process.stderr.write(`[embed] Telemetry generation probe: ${err.message}\n`);
        }
      },
      { runImmediately: false }, // first run after 5 min delay
    );

    // ── Job 15: auto-backup ──────────────────────────────────────────
    // Opt-in via CONSTRUCT_AUTO_BACKUP_DAYS=N (interval in days). Off by
    // default. Runs `createBackup` then `pruneBackups` to keep the most
    // recent CONSTRUCT_BACKUP_RETAIN archives (default 10).
    const autoBackupDays = Number(process.env.CONSTRUCT_AUTO_BACKUP_DAYS || 0);
    if (autoBackupDays > 0) {
      const intervalMs = autoBackupDays * 24 * 60 * 60_000;
      const keep = Number(process.env.CONSTRUCT_BACKUP_RETAIN || 10);
      this.#scheduler.register(
        'auto-backup',
        intervalMs,
        async () => {
          try {
            const { createBackup, pruneBackups } = await import('../storage/backup.mjs');
            const result = await createBackup({});
            const pruned = pruneBackups({ keep });
            process.stderr.write(
              `[embed] Auto-backup: ${result.path} (${pruned.removed.length} pruned, ${pruned.kept} kept)\n`,
            );
            emitEmbedNotification({
              type: 'info',
              source: 'auto-backup',
              message: `Backup created${pruned.removed.length ? `, ${pruned.removed.length} pruned` : ''}`,
              meta: { path: result.path, kept: pruned.kept, pruned: pruned.removed.length },
            });
          } catch (err) {
            process.stderr.write(`[embed] Auto-backup error: ${err.message}\n`);
          }
        },
      );
    }

    // ── Job 16: embed-capabilities (ADR-0061 / LMCP-P2/F5) ───────────────────
    // One scheduled job per enabled embed-capability manifest — exactly the
    // enabled set, read fresh at startup so `construct embed enable/disable`
    // takes effect on the next daemon restart. The job body (capability-jobs.mjs
    // runCapabilityTick) composes the bound provider slice off this daemon's
    // own last snapshot, asks workflow-invoke.mjs for the plan, and enqueues
    // any resulting proposals into this same approval queue — never through
    // a provider write adapter. reasoning-executor.mjs (construct-jvjow.2) is
    // opt-in and off by default (CONSTRUCT_EMBED_REASONING_EXECUTOR=1 or
    // construct.config.json daemon.embedReasoning.enabled); createReasoningExecutor
    // returns null unless enabled, so registerEmbedCapabilityJobs receives
    // undefined and every tick keeps recording the honest
    // skipped-with-reason(reasoning-executor-not-available) status, per
    // ADR-0061 §3, exactly as before this bead landed.
    this.#capabilityIds = registerEmbedCapabilityJobs(this.#scheduler, {
      rootDir: this.#rootDir,
      env: this.#env,
      getSnapshot: () => this.#lastSnapshot,
      approvalQueue: this.#approvalQueue,
      reasoningExecutor: createReasoningExecutor({ rootDir: this.#rootDir, env: this.#env }) ?? undefined,
    });

    this.#scheduler.start();

    // Reactive inbox watching: low-latency trigger backed by the scheduler
    // poll for correctness on platforms where fs.watch silently misses
    // events (network mounts, certain Docker volume drivers).
    // Opt out with CX_INBOX_LIVE_WATCH=off.

    if (this.#env.CX_INBOX_LIVE_WATCH !== 'off') {
      try {
        this.#inboxLiveWatcher = new InboxLiveWatcher({
          inboxWatcher: this.#inboxWatcher,
          onPoll: (result) => {
            if (result?.processed?.length) {
              process.stderr.write(`[embed] Inbox (live): ingested ${result.processed.length} file(s)\n`);
            }
          },
          onError: (err, dir) => {
            process.stderr.write(`[embed] Inbox live watcher error on ${dir || 'unknown'}: ${err.message}\n`);
          },
        });
        const startInfo = this.#inboxLiveWatcher.start();
        process.stderr.write(`[embed] Inbox live watcher: watching ${startInfo.watched} dir(s)\n`);
      } catch (err) {
        process.stderr.write(`[embed] Inbox live watcher failed to start (${err.message}); falling back to 2m poll only\n`);
        this.#inboxLiveWatcher = null;
      }
    }

    this.#status = 'running';
    this.#daemonTraceId = newTraceId();
    try {
      emitTraceEvent({
        rootDir: this.#rootDir,
        eventType: 'daemon.started',
        traceId: this.#daemonTraceId,
        spanId: newSpanId(),
        env: this.#env,
        metadata: {
          pid: process.pid,
          configSnapshotIntervalMs: this.#config.snapshot.intervalMs,
          version: process.env.CONSTRUCT_VERSION || '0.0.0',
        },
      });
    } catch { /* observability must not break the caller */ }
    process.stderr.write(`[embed] Daemon started. Snapshot interval: ${this.#config.snapshot.intervalMs}ms\n`);
  }

  stop() {
    this.#inboxLiveWatcher?.stop?.();
    this.#inboxLiveWatcher = null;
    this.#scheduler?.stop();
    this.#status = 'stopped';
    try {
      emitTraceEvent({
        rootDir: this.#rootDir,
        eventType: 'daemon.stopped',
        traceId: this.#daemonTraceId,
        spanId: newSpanId(),
        env: this.#env,
        metadata: { pid: process.pid, uptimeMs: process.uptime() * 1000 },
      });
    } catch { /* observability must not break the caller */ }
    process.stderr.write('[embed] Daemon stopped.\n');
  }

  status() {
    return {
      status: this.#status,
      lastSnapshot: this.#lastSnapshot
        ? { generatedAt: this.#lastSnapshot.generatedAt, summary: this.#lastSnapshot.summary }
        : null,
      pendingApprovals: this.#approvalQueue?.list('pending').length ?? 0,
      schedulerTasks: this.#scheduler?.status() ?? [],
      providerHealth: this.#providerHealth.summary(),
      inboxDirs: this.#inboxWatcher?.dirs() ?? [],
      embedCapabilities: this.#capabilityIds,
    };
  }

  approvalQueue() {
    return this.#approvalQueue;
  }

  authorityGuard() {
    return this.#authorityGuard;
  }

  lastSnapshot() {
    return this.#lastSnapshot;
  }

  /**
   * Run execution gap analysis: compare strategy/PRDs/RFCs with Jira tickets.
   * Returns { gaps, ticketsCreated, highRiskCount }.
   */
  async #runExecutionGapAnalysis() {
    const gaps = [];
    let ticketsCreated = 0;
     let highRiskCount = 0;
    
     try {
       // Query strategy/PRDs/RFCs from knowledge base
       
        const strategyDocs = searchObservations(this.#rootDir, 'PRD RFC strategy', {
          category: 'insight',
          limit: 50,
        });
       
       // Query existing Jira tickets via Atlassian provider
       
       const jiraProvider = this.#registry?.get('jira');
       if (!jiraProvider) {
         process.stderr.write('[embed] Execution gap: Jira provider not available\n');
         return { gaps, ticketsCreated, highRiskCount };
       }

      // Get project key from config or use default
      const projectKey = this.#config?.providers?.jira?.projectKey ?? 'PLATFORM';
      
      // Search for open issues
      let existingTickets = [];
      try {
        const jql = `project = ${projectKey} AND status != Done ORDER BY created DESC`;
        existingTickets = await jiraProvider.search(jql, { maxResults: 100 });
      } catch (err) {
        process.stderr.write(`[embed] Execution gap: Jira query failed: ${err.message}\n`);
        return { gaps, ticketsCreated, highRiskCount };
      }

     // Compare strategy docs with tickets to identify gaps
     for (const doc of strategyDocs) {
        if (!doc.content) continue;

        // Extract requirements/key points from the document
        const docText = doc.content.toLowerCase();
        const docSummary = doc.summary?.toLowerCase() ?? '';

        // Check if there's a corresponding Jira ticket
        const hasMatchingTicket = existingTickets.some((ticket) => {
          const ticketText = `${ticket.summary ?? ''} ${ticket.description ?? ''}`.toLowerCase();
          // Simple matching: check if key terms from doc appear in ticket
          const docWords = [...new Set([...docSummary.split(/\W+/).filter(w => w.length > 4)])];
          return docWords.some(word => ticketText.includes(word));
        });

        if (!hasMatchingTicket) {
          const severity = doc.tags?.includes('high-priority') ? 'high' : 'medium';
          gaps.push({
            severity,
            kind: 'missing-ticket',
            summary: `No Jira ticket found for: ${doc.summary?.slice(0, 80) ?? 'Unknown document'}`,
            docId: doc.id,
            source: doc.source,
          });
          if (severity === 'high') highRiskCount++;
        }
      }

      // Create Jira tickets for gaps (or queue for approval)
    for (const gap of gaps) {
        try {
          const authorityResult = await this.#authorityGuard.check('externalPost', {
            description: `Create Jira ticket for execution gap: ${gap.summary}`,
          });

          if (authorityResult.allowed) {
            // Create the Jira ticket
            const newTicket = await jiraProvider.write({
              type: 'issue',
              project: projectKey,
              issueType: 'Story',
              summary: `[Auto] Execution gap: ${gap.summary}`,
              description: [
                `This ticket was auto-created by Construct's TPM gap analysis.`,
                ``,
                `**Source document**: ${gap.docId ?? 'Unknown'}`,
                `**Gap type**: ${gap.kind}`,
                `**Severity**: ${gap.severity}`,
                ``,
                `Please review the source document and break this into actionable work items.`,
              ].join('\n'),
              labels: ['auto-generated', 'execution-gap', gap.severity],
            });

            if (newTicket?.key) {
              ticketsCreated++;
              process.stderr.write(`[embed] Execution gap: created ticket ${newTicket.key} for: ${gap.summary}\n`);
              
              // Record observation about the created ticket
              addObservation(this.#rootDir, {
                role: 'operator',
                category: 'insight',
                summary: `Auto-created Jira ticket ${newTicket.key} for execution gap`,
                content: `Ticket: ${newTicket.key}\nGap: ${gap.summary}\nSeverity: ${gap.severity}`,
                tags: ['execution-gap', 'auto-ticket', gap.severity, `ticket:${newTicket.key}`],
                confidence: 0.9,
                source: 'execution-gap-job',
              });
            }
          } else {
            // Queue for approval
            process.stderr.write(`[embed] Execution gap: ticket creation queued for approval (gap: ${gap.summary})\n`);
          }
        } catch (err) {
          process.stderr.write(`[embed] Execution gap: failed to create ticket: ${err.message}\n`);
        }
      }

      // Record observation about the gap analysis run
      if (gaps.length > 0) {
        addObservation(this.#rootDir, {
          role: 'operator',
          category: gaps.some(g => g.severity === 'high') ? 'anti-pattern' : 'insight',
          summary: `Execution gap analysis: ${gaps.length} gap(s) found, ${ticketsCreated} ticket(s) created`,
          content: `Gaps: ${gaps.length}\nTickets created: ${ticketsCreated}\nHigh risk: ${highRiskCount}`,
          tags: ['execution-gap', 'tpm-analysis', `gaps:${gaps.length}`],
          confidence: 0.85,
          source: 'execution-gap-job',
        });
      }

    } catch (err) {
      process.stderr.write(`[embed] Execution gap analysis error: ${err.message}\n`);
    }

    return { gaps, ticketsCreated, highRiskCount };
  }
}
