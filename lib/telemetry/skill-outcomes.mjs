/**
 * lib/telemetry/skill-outcomes.mjs — attribute session outcomes to the skills
 * loaded during that session (phase 1 of the skill effectiveness pipeline).
 *
 * When a specialist outcome carries a sessionId (lib/outcomes/record.mjs),
 * every skill whose load event in <doctorRoot>/skill-calls.jsonl carries the
 * same sessionId receives one attributed line in
 * <doctorRoot>/skill-outcomes.jsonl:
 *
 *   { ts, skillId, sessionId, success, role?, projectId?, source? }
 *
 * The aggregate module (skill-outcomes-aggregate.mjs) rolls these lines into
 * per-skill success rates; `construct skills quality` renders them. Pure
 * capture — nothing here influences routing.
 *
 * Best-effort and off the critical path: every IO failure is swallowed, and
 * `CONSTRUCT_SKILL_TELEMETRY=off` disables writes, matching skill-calls.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendBounded } from '../logging/rotate.mjs';
import { resolveProjectScope } from '../project-root.mjs';
import { doctorRoot } from '../config/xdg.mjs';
import { DEFAULT_LOG_PATH as SKILL_CALLS_LOG_PATH } from './skill-calls.mjs';

// Skill outcomes stay user-scope beside skill-calls.jsonl: the join source is
// user-scope, and a skill's quality signal should accumulate across every
// project the user runs Construct in. Entries carry projectId for attribution.

export const DEFAULT_LOG_PATH = path.join(doctorRoot(), 'skill-outcomes.jsonl');

/**
 * Attribute one session outcome to every skill loaded in that session.
 * Returns the number of skill-outcome lines written (0 when telemetry is
 * off, the payload is incomplete, or no skill loads match the sessionId).
 *
 * @param {object} payload
 * @param {string} payload.sessionId — join key against skill-calls.jsonl entries
 * @param {boolean} payload.success
 * @param {string} [payload.role] — specialist role the outcome was recorded for
 * @param {string} [payload.source] — origin tag (agent-tracker, mcp, manual)
 * @param {string} [payload.cwd] — project root used for projectId attribution
 * @param {object} [opts]
 * @param {string} [opts.callsLogPath] — override skill-calls.jsonl (tests)
 * @param {string} [opts.logPath] — override skill-outcomes.jsonl (tests)
 * @param {NodeJS.ProcessEnv} [opts.env] — override env for the disable check (tests)
 */
export function attributeOutcomeToSkills(payload, opts = {}) {
  const env = opts.env || process.env;
  if (env.CONSTRUCT_SKILL_TELEMETRY === 'off') return 0;
  if (!payload || !payload.sessionId || typeof payload.success !== 'boolean') return 0;

  try {
    const callsLogPath = opts.callsLogPath || SKILL_CALLS_LOG_PATH;
    const logPath = opts.logPath || DEFAULT_LOG_PATH;

    let raw;
    try { raw = fs.readFileSync(callsLogPath, 'utf8'); } catch { return 0; }

    // One attributed line per distinct skill, not per load event — a skill
    // loaded five times in one session still earns exactly one outcome vote.

    const skillIds = new Set();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.skillId && entry.sessionId === payload.sessionId) skillIds.add(entry.skillId);
    }
    if (skillIds.size === 0) return 0;

    const scope = resolveProjectScope(payload.cwd || process.cwd());
    const ts = new Date().toISOString();
    let written = 0;
    for (const skillId of skillIds) {
      const entry = {
        ts,
        skillId,
        sessionId: payload.sessionId,
        success: !!payload.success,
        ...(payload.role ? { role: payload.role } : {}),
        ...(scope?.projectId ? { projectId: scope.projectId } : {}),
        ...(payload.source ? { source: payload.source } : {}),
      };
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      appendBounded('skill-outcomes', logPath, JSON.stringify(entry) + '\n');
      written += 1;
    }
    return written;
  } catch {
    return 0;
  }
}

/**
 * Read every attributed outcome from the log. Skips malformed lines.
 */
export function listSkillOutcomes({ logPath = DEFAULT_LOG_PATH } = {}) {
  if (!fs.existsSync(logPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.skillId && typeof entry.success === 'boolean') out.push(entry);
    } catch { continue; }
  }
  return out;
}
