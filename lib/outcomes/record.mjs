/**
 * lib/outcomes/record.mjs — Specialist outcome recorder.
 *
 * Records the result of every dispatched specialist into
 * `.construct/outcomes/<role>.jsonl`. The aggregator (lib/outcomes/aggregate.mjs)
 * reads these files to produce per-role rolling success rates, which the
 * classifier consumes as a soft tiebreaker.
 *
 * Schema (one JSONL line per outcome):
 *   { ts, role, intakeId, profile, success, escalated, durationMs, notes,
 *     source: 'agent-tracker' | 'feedback' | 'manual', sessionId? }
 *
 * When a sessionId is present, the outcome is also attributed to every skill
 * loaded during that session (lib/telemetry/skill-outcomes.mjs joins on the
 * sessionId column of skill-calls.jsonl). Attribution is best-effort and
 * never affects the role outcome write.
 *
 * Files rotate at 10k lines per role to keep disk bounded. The rotated file
 * is named `<role>.<yyyymm>.jsonl`. Current is always `<role>.jsonl`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '../storage/file-lock.mjs';
import { ensureCxDir } from '../project-init-shared.mjs';
import { configPath } from '../config-dir.mjs';
import { attributeOutcomeToSkills } from '../telemetry/skill-outcomes.mjs';

const ROTATE_AT = 10_000;
const MAX_NOTES = 500;

function safeRole(role) {
  return String(role || 'unknown').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 60) || 'unknown';
}

function outcomesDir(cwd) {
  return configPath(cwd, 'outcomes');
}

function activeFile(cwd, role) {
  return path.join(outcomesDir(cwd), `${safeRole(role)}.jsonl`);
}

function rotatedFile(cwd, role) {
  const stamp = new Date().toISOString().slice(0, 7).replace('-', ''); // yyyymm
  return path.join(outcomesDir(cwd), `${safeRole(role)}.${stamp}.jsonl`);
}

function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return n;
  } catch { return 0; }
}

/**
 * Record a specialist outcome. Best-effort: any IO failure is swallowed and
 * the caller proceeds. Outcomes are telemetry, never on the critical path.
 *
 * @param {string} cwd - project root
 * @param {object} payload
 * @param {string} payload.role - specialist id (cx-engineer → 'engineer')
 * @param {string} [payload.intakeId]
 * @param {string} [payload.profile] - active profile id
 * @param {boolean} payload.success
 * @param {boolean} [payload.escalated]
 * @param {number} [payload.durationMs]
 * @param {string} [payload.notes]
 * @param {string} [payload.source='manual']
 * @param {string} [payload.sessionId] - session the outcome belongs to; enables skill attribution
 * @returns {string|null} path to the file written, or null on failure
 */
export function recordOutcome(cwd, payload) {
  if (!cwd || !payload || typeof payload.success !== 'boolean') return null;
  try {
    ensureCxDir(cwd);
    fs.mkdirSync(outcomesDir(cwd), { recursive: true });
    const file = activeFile(cwd, payload.role);

    if (countLines(file) >= ROTATE_AT) {
      try { fs.renameSync(file, rotatedFile(cwd, payload.role)); } catch { /* race */ }
    }

    const entry = {
      ts: new Date().toISOString(),
      role: safeRole(payload.role),
      intakeId: payload.intakeId || null,
      profile: payload.profile || null,
      success: !!payload.success,
      escalated: !!payload.escalated,
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
      notes: payload.notes ? String(payload.notes).slice(0, MAX_NOTES) : null,
      source: payload.source || 'manual',
      ...(payload.sessionId ? { sessionId: String(payload.sessionId) } : {}),
    };

    withFileLockSync(file, () => {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    });

    if (entry.sessionId) {
      attributeOutcomeToSkills({
        sessionId: entry.sessionId,
        success: entry.success,
        role: entry.role,
        source: entry.source,
        cwd,
      });
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Read every outcome line for a role across active + rotated files.
 * Returns oldest-first.
 */
export function listOutcomes(cwd, role) {
  const dir = outcomesDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const safe = safeRole(role);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${safe}.`) && f.endsWith('.jsonl'));
  const out = [];
  for (const f of files.sort()) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return out;
}
