/**
 * lib/telemetry/skill-outcomes-aggregate.mjs — per-skill rolling success-rate
 * summary, mirroring lib/outcomes/aggregate.mjs at the skill level.
 *
 * Reads <doctorRoot>/skill-outcomes.jsonl and produces
 * <doctorRoot>/skill-outcomes-summary.json:
 *
 *   { generatedAt, totalOutcomes, skills: { <skillId>: {
 *       count, success, successRate, sessions,
 *       last30: { count, successRate }, trend } } }
 *
 * `trend` is last30.successRate minus lifetime successRate (null until the
 * 30-day window has data), so a consumer can see a skill improving or
 * decaying without re-deriving windows. Phase 1 is capture-only: no router
 * or classifier reads this summary yet.
 */

import fs from 'node:fs';
import path from 'node:path';
import { doctorRoot } from '../config/xdg.mjs';
import { listSkillOutcomes, DEFAULT_LOG_PATH } from './skill-outcomes.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_WINDOW_DAYS = 30;

export const DEFAULT_SUMMARY_PATH = path.join(doctorRoot(), 'skill-outcomes-summary.json');

function rollupSkill(entries) {
  const total = entries.length;
  if (total === 0) return null;
  const success = entries.filter((e) => e.success === true).length;
  const successRate = Number((success / total).toFixed(3));

  const cutoff = Date.now() - LAST_WINDOW_DAYS * DAY_MS;
  const recent = entries.filter((e) => Date.parse(e.ts) >= cutoff);
  const recentSuccess = recent.filter((e) => e.success === true).length;
  const recentRate = recent.length > 0 ? Number((recentSuccess / recent.length).toFixed(3)) : null;

  const sessions = new Set(entries.map((e) => e.sessionId).filter(Boolean)).size;

  return {
    count: total,
    success,
    successRate,
    sessions,
    last30: {
      count: recent.length,
      successRate: recent.length > 0 ? recentRate : 0,
    },
    trend: recentRate != null ? Number((recentRate - successRate).toFixed(3)) : null,
  };
}

/**
 * Rebuild the per-skill summary from skill-outcomes.jsonl. Idempotent; writes
 * the summary JSON and returns it.
 */
export function aggregateSkillOutcomes({ logPath = DEFAULT_LOG_PATH, summaryPath = DEFAULT_SUMMARY_PATH } = {}) {
  const entries = listSkillOutcomes({ logPath });
  const bySkill = {};
  for (const entry of entries) {
    (bySkill[entry.skillId] ||= []).push(entry);
  }

  const out = { generatedAt: new Date().toISOString(), totalOutcomes: entries.length, skills: {} };
  for (const skillId of Object.keys(bySkill).sort()) {
    const rollup = rollupSkill(bySkill[skillId]);
    if (rollup) out.skills[skillId] = rollup;
  }

  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(out, null, 2) + '\n');
  return out;
}

/**
 * Read the cached summary without recomputing. Returns null when absent or
 * unparsable, matching lib/outcomes/aggregate.mjs readSummary.
 */
export function readSkillOutcomeSummary({ summaryPath = DEFAULT_SUMMARY_PATH } = {}) {
  if (!fs.existsSync(summaryPath)) return null;
  try { return JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { return null; }
}
