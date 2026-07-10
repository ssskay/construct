/**
 * lib/contracts/violation-log.mjs — tamper-evident append-only log for
 * specialist-contract violations.
 *
 * Each record carries:
 *   ts                  — ISO timestamp
 *   sequence            — monotonic per-log counter, gap-detects truncation
 *   prev_line_hash      — sha256 of the prior line, gap-detects modification
 *   agent               — last-known active agent (from ~/.cx/last-agent.json)
 *   contractId          — the contract that fired the violation
 *   direction           — 'input' | 'output'
 *   missing             — field names that failed shape validation
 *   packet_keys         — Object.keys(packet) when packet is an object
 *   verdict             — 'CONTRACT_VIOLATION' (default) or 'BLOCKED_CONTRACT'
 *                         (binary postcondition failures)
 *   postconditionFailures — [{id, reason}] when verdict is BLOCKED_CONTRACT
 *
 * The hash chain spans rotation: when the active file is empty (post-rotate),
 * the tail is read from the most recent segment (gzipped or plain) via
 * readLastLineAcrossSegments. The sequence counter follows the same path.
 *
 * Single owner of the file. All readers go through recentViolations or
 * verifyChain; all writers go through logViolation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { appendBounded, readLastLineAcrossSegments } from '../logging/rotate.mjs';
import { resolveProjectScopedPath } from '../project-root.mjs';
import { doctorRoot } from '../config/xdg.mjs';

const CX_DIR = doctorRoot();
const LAST_AGENT = join(CX_DIR, 'last-agent.json');

// contract-violations are PROJECT-SCOPED: resolves to
// <project>/.cx/contract-violations.jsonl when inside a project, falling
// back to ~/.cx for standalone invocations. Resolved on every call so
// cwd/HOME changes inside the same process (tests, harness reuse) route
// correctly.

function logFile(repoRoot) {
  // Explicit repoRoot bypasses the marker-walk in resolveProjectScope: the
  // caller has already decided the scope (test fixture, sandbox, embedded
  // worktree). Without this, a fixture without a `.cx/` marker falls back
  // to ~/.cx/ and pollutes the developer's home log.
  if (repoRoot) return join(repoRoot, '.cx', 'contract-violations.jsonl');
  return resolveProjectScopedPath('contract-violations.jsonl', { ensureDir: false });
}

// Exposed for diagnostic surfaces (e.g. doctor) that need to print the
// real path. Resolves on every call so cwd/HOME changes inside the same
// process route correctly. `repoRoot` overrides cwd-based resolution so
// callers running against a fixture (tests, sandboxes) can isolate their
// log writes from the developer's project log.
export function violationLogPath(repoRoot) { return logFile(repoRoot); }

function supersedeMarkerFile(repoRoot) {
  if (repoRoot) return join(repoRoot, '.cx', 'contract-violations-superseded.json');
  return resolveProjectScopedPath('contract-violations-superseded.json', { ensureDir: false });
}

/**
 * Read ISO timestamp before which violations are ignored for oracle/doctor counts.
 */
export function readViolationSupersedeCutoff(repoRoot) {
  const file = supersedeMarkerFile(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const ts = data?.supersededBefore;
    const parsed = Date.parse(String(ts ?? ''));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Mark pre-fix contract violations as superseded for hygiene surfaces.
 * Forensic log is preserved; oracle read model ignores older entries.
 */
export function markContractViolationsSuperseded({ repoRoot, reason = 'superseded by contract hygiene repair' } = {}) {
  const file = supersedeMarkerFile(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  const payload = {
    supersededBefore: new Date().toISOString(),
    reason,
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function violationMatchesTail(tail, contractId, direction, missing, packet) {
  if (!tail) return false;
  if (tail.contractId !== contractId || tail.direction !== direction) return false;
  const keys = packet && typeof packet === 'object' ? Object.keys(packet).sort() : null;
  const tailKeys = Array.isArray(tail.packet_keys) ? [...tail.packet_keys].sort() : null;
  return JSON.stringify(tail.missing) === JSON.stringify(missing)
    && JSON.stringify(tailKeys) === JSON.stringify(keys);
}

const BARE_GOAL_FIELD_LABELS = ['intent', 'workCategory', 'riskFlags', 'acceptanceCriteria'];

const RESEARCHER_PROBE_MISSING = [
  'artifact missing required field: question',
  'artifact missing required field: method',
  'artifact missing required field: sources',
  'artifact missing required field: findings',
  'artifact missing required field: confidence',
];

const A11Y_PROBE_MISSING = [
  'artifact missing required field: findings',
  'artifact missing required field: wcagCriterion',
  'artifact missing required field: userImpact',
];

function missingBareGoalConstructFields(missing) {
  if (!Array.isArray(missing) || missing.length !== BARE_GOAL_FIELD_LABELS.length) return false;
  return BARE_GOAL_FIELD_LABELS.every((field) =>
    missing.some((entry) => String(entry).includes(field)),
  );
}

function isBareGoalConstructViolation(row) {
  if (row?.contractId !== 'construct-to-orchestrator') return false;
  if (!missingBareGoalConstructFields(row.missing)) return false;
  const keys = row.packet_keys ?? row.packetKeys;
  return Array.isArray(keys) && keys.length === 1 && keys[0] === 'goal';
}

function isEmptyProbeViolation(row, contractId, expectedMissing) {
  if (row?.contractId !== contractId) return false;
  const keys = row.packet_keys ?? row.packetKeys;
  if (!Array.isArray(keys) || keys.length !== 0) return false;
  return JSON.stringify(row.missing) === JSON.stringify(expectedMissing);
}

export function isDevSessionContractNoise(row) {
  return isBareGoalConstructViolation(row)
    || isEmptyProbeViolation(row, 'researcher-to-architect', RESEARCHER_PROBE_MISSING)
    || isEmptyProbeViolation(row, 'accessibility-to-qa', A11Y_PROBE_MISSING);
}

function sha256(input) { return createHash('sha256').update(input).digest('hex'); }

function readLastAgent() {
  try { return JSON.parse(readFileSync(LAST_AGENT, 'utf8'))?.agent || 'construct'; }
  catch { return 'construct'; }
}

function readTailRecord(repoRoot) {
  const file = logFile(repoRoot);
  const lastLine = readLastLineAcrossSegments(file);
  if (!lastLine) return null;
  try { return JSON.parse(lastLine); }
  catch { return null; }
}

function readPrevLineHash(repoRoot) {
  const file = logFile(repoRoot);
  const lastLine = readLastLineAcrossSegments(file);
  return lastLine ? sha256(lastLine) : null;
}

function nextSequence(repoRoot) {
  const tail = readTailRecord(repoRoot);
  const prior = Number.isInteger(tail?.sequence) ? tail.sequence : 0;
  return prior + 1;
}

/**
 * Append a violation record. Best-effort: file I/O failures are swallowed
 * so logging never crashes the caller. `extra.repoRoot` (extracted, not
 * persisted) routes the write to a fixture log when callers run against
 * a tmpdir — required for test isolation.
 */
export function logViolation(contractId, direction, missing, packet, extra = {}) {
  try {
    const { repoRoot, ...persistedExtra } = extra || {};
    const tail = readTailRecord(repoRoot);
    if (violationMatchesTail(tail, contractId, direction, missing, packet)) return;
    const file = logFile(repoRoot);
    mkdirSync(dirname(file), { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      sequence: nextSequence(repoRoot),
      agent: readLastAgent(),
      contractId,
      direction,
      missing,
      packet_keys: packet && typeof packet === 'object' ? Object.keys(packet) : null,
      prev_line_hash: readPrevLineHash(repoRoot),
      ...persistedExtra,
    };
    appendBounded('contract-violations', file, JSON.stringify(record) + '\n');
  } catch { /* logging is best-effort */ }
}

/**
 * Read recent violations from the active log segment. Returns oldest-first.
 * Rotated segments are intentionally not included — this is the doctor
 * surface, scoped to the active window. `runId` (construct-ifwhw.1) filters
 * to violations tagged with that run — pass `windowMs: Infinity` alongside it
 * when the run may be older than the default 24h doctor window.
 */
export function recentViolations({ windowMs = 24 * 60 * 60 * 1000, repoRoot, excludeDevNoise = false, limit = Infinity, now = Date.now(), runId = null } = {}) {
  const file = logFile(repoRoot);
  if (!existsSync(file)) return [];
  const supersedeCutoff = readViolationSupersedeCutoff(repoRoot);
  try {
    const windowCutoff = now - windowMs;
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => {
        if (!r) return false;
        const ts = new Date(r.ts).getTime();
        if (supersedeCutoff != null && ts <= supersedeCutoff) return false;
        if (ts < windowCutoff) return false;
        if (excludeDevNoise && isDevSessionContractNoise(r)) return false;
        if (runId != null && r.runId !== runId) return false;
        return true;
      })
      .slice(-limit);
  } catch { return []; }
}

/**
 * Walk the active log segment, asserting:
 *   - each record's prev_line_hash matches sha256 of the prior line
 *   - sequence numbers are monotonic with no gaps
 *
 * Returns { ok, brokenAt? } where brokenAt is { index, reason } on first
 * failure. An empty / missing log is `{ ok: true }` (nothing to break).
 */
export function verifyChain() {
  const file = logFile();
  if (!existsSync(file)) return { ok: true };
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    let priorLine = null;
    let priorSeq = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let record;
      try { record = JSON.parse(line); }
      catch { return { ok: false, brokenAt: { index: i, reason: 'unparseable JSON' } }; }

      if (priorLine !== null) {
        const expectedHash = sha256(priorLine);
        if (record.prev_line_hash !== expectedHash) {
          return { ok: false, brokenAt: { index: i, reason: 'prev_line_hash mismatch' } };
        }
      }
      if (Number.isInteger(record.sequence)) {
        if (priorSeq !== null && record.sequence !== priorSeq + 1) {
          return { ok: false, brokenAt: { index: i, reason: `sequence gap (expected ${priorSeq + 1}, got ${record.sequence})` } };
        }
        priorSeq = record.sequence;
      }
      priorLine = line;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, brokenAt: { index: -1, reason: err.message } };
  }
}
