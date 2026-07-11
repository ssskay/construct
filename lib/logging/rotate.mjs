/**
 * lib/logging/rotate.mjs — shared file-rotation primitive.
 *
 * Two consumers need bounded log files: the trace writer
 * (state-root `traces/<date>.jsonl` — ADR-0066, machine-scoped, not
 * project-local — capped to avoid >100MB single-file commits that GitHub
 * would reject if ever committed) and the embed daemon stdout log
 * (`~/.cx/runtime/embed-daemon.log`, capped so a stuck "Telemetry skipped"
 * message can't fill the disk).
 *
 * `appendWithRotation` is for code paths that own the writes (the trace
 * writer). `rotateIfOversized` is for externally-written files where Construct
 * code only polls (the OS-supervisor stdout redirect — Construct never writes
 * the embed log directly).
 *
 * Rotated segments are named `<base>.<n><ext>` where `n` starts at 1 and
 * counts upward; with `gzip: true` segments get a `.gz` suffix and are
 * compressed lazily on rotation. `maxSegments` (when set) drops the oldest
 * `n>=maxSegments` segments on every rotation so the directory stays bounded.
 */

import { existsSync, statSync, renameSync, readdirSync, readFileSync, unlinkSync, appendFileSync, createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * Parse `<base>.<ext>` from a full path. `app.log` → base=app, ext=.log.
 * `2026-05-28.jsonl` → base=2026-05-28, ext=.jsonl.
 */
function splitBase(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return { dir, base, ext };
}

/**
 * Enumerate existing rotated segments for a given file, sorted ascending by
 * segment index. Includes both compressed and uncompressed forms.
 */
function listSegments(filePath) {
  const { dir, base, ext } = splitBase(filePath);
  if (!existsSync(dir)) return [];

  // Pattern: <base>.<n>[<ext>][.gz]. Match any segment that starts with base
  // and a digit suffix; tolerate both `.1.jsonl` and `.1.jsonl.gz`.

  const pattern = new RegExp(`^${escapeRegex(base)}\\.(\\d+)${escapeRegex(ext)}(\\.gz)?$`);
  const entries = readdirSync(dir)
    .map((name) => {
      const m = name.match(pattern);
      return m ? { name, index: Number(m[1]), gzipped: !!m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  return entries.map((e) => ({ ...e, fullPath: path.join(dir, e.name) }));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rename current → next-segment, optionally gzipping the previous tail. Old
 * segments past `maxSegments` are deleted. Returns the new segment path or
 * null when no rotation happened.
 */
export async function rotateIfOversized(filePath, { maxBytes, maxSegments = 0, gzip = false } = {}) {
  if (!maxBytes || maxBytes <= 0) return null;
  if (!existsSync(filePath)) return null;

  let stat;
  try { stat = statSync(filePath); }
  catch { return null; }
  if (!stat.isFile() || stat.size < maxBytes) return null;

  const { dir, base, ext } = splitBase(filePath);
  const existing = listSegments(filePath);
  const nextIndex = (existing[existing.length - 1]?.index ?? 0) + 1;

  // Move current → <base>.<nextIndex><ext>. Then optionally gzip the rotated
  // file. Doing the rename first means a concurrent writer that reopens the
  // path lands on a fresh file with no data loss.

  const rotatedPlain = path.join(dir, `${base}.${nextIndex}${ext}`);
  renameSync(filePath, rotatedPlain);

  let finalPath = rotatedPlain;
  if (gzip) {
    finalPath = `${rotatedPlain}.gz`;
    try {
      await pipeline(createReadStream(rotatedPlain), createGzip(), createWriteStream(finalPath));
      try { unlinkSync(rotatedPlain); } catch { /* already cleaned up */ }
    } catch {
      // Compression failed; leave the plain rotated segment in place rather
      // than losing data.

      finalPath = rotatedPlain;
    }
  }

  pruneSegments(filePath, maxSegments);
  return finalPath;
}

/**
 * Drop oldest segments past `maxSegments`. With maxSegments=0, keep every
 * segment (no pruning). Always preserves the active file (which has no
 * numeric suffix and is therefore not in the segment list).
 */
export function pruneSegments(filePath, maxSegments = 0) {
  if (!maxSegments || maxSegments <= 0) return [];
  const segments = listSegments(filePath);
  if (segments.length <= maxSegments) return [];
  const drop = segments.slice(0, segments.length - maxSegments);
  for (const seg of drop) {
    try { unlinkSync(seg.fullPath); } catch { /* already gone */ }
  }
  return drop.map((s) => s.fullPath);
}

/**
 * Append `line` to `filePath`, rotating beforehand if the file would exceed
 * `maxBytes`. Creates the parent directory on first append.
 *
 * Synchronous + best-effort gzip. The cost of compressing on rotation is
 * amortized over `maxBytes` worth of writes, so the rotation tail rarely
 * blocks the calling code path. When gzip:false rotation is just a rename.
 */
export async function appendWithRotation(filePath, line, { maxBytes, maxSegments = 0, gzip = false } = {}) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (maxBytes && maxBytes > 0 && existsSync(filePath)) {
    try {
      const stat = statSync(filePath);
      // Rotate when this append would cross the cap, not after — keeps every
      // single segment strictly under `maxBytes`.

      if (stat.isFile() && stat.size + Buffer.byteLength(line) >= maxBytes) {
        await rotateIfOversized(filePath, { maxBytes: 0, maxSegments, gzip });
      }
    } catch { /* fall through to plain append */ }
  }

  appendFileSync(filePath, line);
}

/**
 * Sync variant for hot paths that can't `await` rotation. Skips gzip (which
 * requires streams) but still renames + prunes. Use this in trace writers and
 * other latency-sensitive append loops.
 */
export function appendWithRotationSync(filePath, line, { maxBytes, maxSegments = 0 } = {}) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (maxBytes && maxBytes > 0 && existsSync(filePath)) {
    try {
      const stat = statSync(filePath);
      if (stat.isFile() && stat.size + Buffer.byteLength(line) >= maxBytes) {
        const { dir: d, base, ext } = splitBase(filePath);
        const existing = listSegments(filePath);
        const nextIndex = (existing[existing.length - 1]?.index ?? 0) + 1;
        renameSync(filePath, path.join(d, `${base}.${nextIndex}${ext}`));
        pruneSegments(filePath, maxSegments);
      }
    } catch { /* fall through */ }
  }

  appendFileSync(filePath, line);
}

/**
 * Per-channel resource limits. Every Construct logger has a documented
 * cap here so disk usage is bounded by design, not by hope. New loggers
 * MUST be registered; the `appendBounded` helper refuses to write to an
 * unregistered channel.
 *
 * Sizes are conservative defaults chosen for a single-developer machine.
 * Override via env var on a per-channel basis when the workload genuinely
 * exceeds these (CI runners, multi-tenant team installs, long-lived
 * background daemons).
 */
export const LIMITS = {
  // Trace shards under the state-root's traces/<date>.jsonl — capped below
  // GitHub's 100 MB single-file ceiling. Bead construct-1vv5.

  trace: {
    maxBytes: 100 * 1024 * 1024,
    maxSegments: 0,                    // keep all history; rotation is for the size cap, not retention
    gzip: false,
    envOverride: 'CONSTRUCT_TRACE_MAX_MB',
  },

  // OS-supervised stdout log at ~/.cx/runtime/embed-daemon.log. Bead
  // construct-88i. Rotation is poll-style via the daemon scheduler.

  'embed-daemon-log': {
    maxBytes: 50 * 1024 * 1024,
    maxSegments: 5,
    gzip: true,
    envOverride: 'CONSTRUCT_EMBED_LOG_MAX_MB',
  },

  // Per-edit audit of file reads. High traffic in active sessions.
  // ~/.cx/audit-reads.jsonl.

  'audit-reads': {
    maxBytes: 25 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_AUDIT_READS_MAX_MB',
  },

  // Per-skill-call telemetry. ~/.cx/skill-calls.jsonl.

  'skill-calls': {
    maxBytes: 25 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_SKILL_CALLS_MAX_MB',
  },

  // Per-skill outcome attribution. ~/.cx/skill-outcomes.jsonl.

  'skill-outcomes': {
    maxBytes: 25 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_SKILL_OUTCOMES_MAX_MB',
  },

  // Per-hook fire/block/error telemetry. ~/.cx/hook-calls.jsonl.

  'hook-calls': {
    maxBytes: 25 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_HOOK_CALLS_MAX_MB',
  },

  // Rule path reference telemetry. ~/.cx/rule-calls.jsonl.

  'rule-calls': {
    maxBytes: 10 * 1024 * 1024,
    maxSegments: 2,
    gzip: true,
    envOverride: 'CONSTRUCT_RULE_CALLS_MAX_MB',
  },

  // Legacy-lock fallback firings on the beads write path. ~/.cx/beads-fallback.jsonl.

  'beads-fallback': {
    maxBytes: 5 * 1024 * 1024,
    maxSegments: 2,
    gzip: true,
    envOverride: 'CONSTRUCT_BEADS_FALLBACK_MAX_MB',
  },

  // Agent-dispatch log written by `lib/hooks/agent-tracker.mjs`. Path: ~/.cx/agent-log.jsonl.

  'agent-log': {
    maxBytes: 25 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_AGENT_LOG_MAX_MB',
  },

  // Pending role invocations across all projects. ~/.cx/role-pending.jsonl.

  'role-pending': {
    maxBytes: 10 * 1024 * 1024,
    maxSegments: 2,
    gzip: true,
    envOverride: 'CONSTRUCT_ROLE_PENDING_MAX_MB',
  },

  // Intent verifications. ~/.cx/intent-verifications.jsonl.

  'intent-verifications': {
    maxBytes: 10 * 1024 * 1024,
    maxSegments: 2,
    gzip: true,
    envOverride: 'CONSTRUCT_INTENT_VERIFICATIONS_MAX_MB',
  },

  // Contract postcondition violations. ~/.cx/contract-violations.jsonl.

  'contract-violations': {
    maxBytes: 10 * 1024 * 1024,
    maxSegments: 2,
    gzip: true,
    envOverride: 'CONSTRUCT_CONTRACT_VIOLATIONS_MAX_MB',
  },

  // Bash-output warning flags appended by the bash-output-logger hook on
  // every Bash tool use over the size threshold. ~/.cx/warn-flags.txt.

  'bash-warn-flags': {
    maxBytes: 5 * 1024 * 1024,
    maxSegments: 2,
    gzip: false,
    envOverride: 'CONSTRUCT_BASH_WARN_FLAGS_MAX_MB',
  },

  // Per-turn cost ledger written by the Stop hook. Cross-project (so the
  // user has one place to see spend across every project) — each entry
  // carries a projectId tag so readers can split by project. Path:
  // ~/.cx/session-cost.jsonl.

  'session-cost': {
    maxBytes: 25 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_SESSION_COST_MAX_MB',
  },

  // Tamper-evident audit trail of every mutation Construct (or a dispatched
  // subagent) makes. Project-scoped. Path: <project>/.construct/audit-trail.jsonl.

  'audit-trail': {
    maxBytes: 50 * 1024 * 1024,
    maxSegments: 4,
    gzip: true,
    envOverride: 'CONSTRUCT_AUDIT_TRAIL_MAX_MB',
  },

  // Pending typecheck queue written by the edit-accumulator hook on every
  // Edit/Write of a TS/JS file. Path: ~/.cx/pending-typecheck.txt.

  'edit-accumulator': {
    maxBytes: 5 * 1024 * 1024,
    maxSegments: 2,
    gzip: false,
    envOverride: 'CONSTRUCT_EDIT_ACCUMULATOR_MAX_MB',
  },
};

/**
 * Resolve the effective cap for a channel, honoring env-var overrides
 * (interpreted as megabytes). Returns the byte budget; 0 disables rotation.
 */
function resolveCap(channel, env = process.env) {
  const def = LIMITS[channel];
  if (!def) throw new Error(`appendBounded: unknown channel "${channel}". Register it in lib/logging/rotate.mjs#LIMITS.`);
  const raw = def.envOverride ? env[def.envOverride] : undefined;
  if (raw === undefined) return def.maxBytes;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return def.maxBytes;
  return Math.floor(mb * 1024 * 1024);
}

/**
 * Append a line to `filePath` with rotation governed by the named channel's
 * registered limit. Synchronous; renames the active file on overflow and
 * prunes oldest segments past the channel's maxSegments. The registry
 * guarantees nothing grows unbounded — every logger appending to a known
 * channel inherits its documented disk budget.
 */
export function appendBounded(channel, filePath, line, env = process.env) {
  const def = LIMITS[channel];
  if (!def) throw new Error(`appendBounded: unknown channel "${channel}". Register it in lib/logging/rotate.mjs#LIMITS.`);
  const maxBytes = resolveCap(channel, env);
  return appendWithRotationSync(filePath, line, {
    maxBytes,
    maxSegments: def.maxSegments,
  });
}

/**
 * Last non-empty line written under the channel, looking across the active
 * file and the rotated segments. Resolves the right value for chain-hash
 * fields (`prev_line_hash`) on the first write after a rotation, where the
 * active file is empty but the chain head lives at the tail of the most
 * recent rotated segment (`<base>.<n><ext>` with the highest `n`, possibly
 * `.gz`-suffixed).
 *
 * Sync. Reads the WHOLE most-recent gzipped segment in memory when it has
 * to fall back to one; segment caps in LIMITS keep the worst case bounded
 * (audit-trail tops out at 50 MB raw, ~5–10 MB gzipped).
 *
 * Returns the line WITHOUT its trailing newline, or null when no data has
 * ever been written for the channel.
 */
export function readLastLineAcrossSegments(filePath) {
  if (existsSync(filePath)) {
    const lastFromActive = readLastLineOfFile(filePath);
    if (lastFromActive !== null) return lastFromActive;
  }
  const segments = listSegments(filePath);
  if (segments.length === 0) return null;
  const newest = segments[segments.length - 1];
  try {
    const raw = readFileSync(newest.fullPath);
    const decoded = newest.gzipped ? gunzipSync(raw) : raw;
    return lastLineOfBuffer(decoded);
  } catch {
    return null;
  }
}

function lastLineOfBuffer(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0x0a) end -= 1;
  if (end === 0) return null;
  let start = end - 1;
  while (start > 0 && buf[start - 1] !== 0x0a) start -= 1;
  return buf.slice(start, end).toString('utf8');
}

function readLastLineOfFile(filePath) {
  try {
    if (statSync(filePath).size === 0) return null;

    // Read the whole file and walk back to the last newline boundary. A
    // bounded tail read (e.g. last 8 KB) would truncate JSONL records that
    // exceed the window — the audit-trail's `content_hash` field can put a
    // record over 50 KB — and a truncated string would break the
    // prev_line_hash chain it feeds. Per-channel size caps in LIMITS bound
    // the worst-case allocation here.

    return lastLineOfBuffer(readFileSync(filePath));
  } catch {
    return null;
  }
}

/** Re-export for convenient testing. */
export const __test = { listSegments, splitBase, resolveCap, readLastLineOfFile };
