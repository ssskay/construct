/**
 * lib/policy/unattended-budget.mjs — fail-closed token budget gate for
 * daemon-originated (unattended) LLM spend (construct-95phc.3).
 *
 * Reuses lib/policy/consumption-budget.mjs's durable ConsumptionBudgetStore
 * (per-actor/run cumulative token consumption, persisted to
 * `.cx/consumption-budgets.json`, survives daemon restarts) rather than a
 * parallel ledger. The one gap that store's own defaults cannot close: its
 * `DEFAULT_BUDGETS_BY_MODE.solo` is deliberately `null` (unbounded) so an
 * interactive solo operator never hits a wall — but a daemon tick has no
 * operator present to notice runaway spend, even in solo mode. So an
 * unconfigured capability here resolves to `{tokens: 0}` — the first token
 * requested is denied — instead of falling through to the deployment-mode
 * default. A capability only spends once an operator has configured a real
 * cap for it.
 *
 * Actor key: `unattended:<capabilityId>`. Run key: UTC day (lib/cost-ledger.mjs's
 * `dayKey`), so spend accumulates through a day's recurring ticks and a
 * fresh budget opens the next day — the same per-tick-accumulates-to-a-cap
 * shape lib/cost-ledger.mjs already uses for USD spend.
 *
 * Config precedence (highest wins): `CONSTRUCT_UNATTENDED_BUDGET_<ID>` env
 * var (tokens/day) > `construct.config.json` →
 * `daemon.unattendedBudgets.<capabilityId>.tokensPerDay` > fail-closed (0).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConsumptionBudgetStore } from './consumption-budget.mjs';
import { dayKey } from '../cost-ledger.mjs';

const ACTOR_PREFIX = 'unattended:';

function envBudgetName(capabilityId) {
  return `CONSTRUCT_UNATTENDED_BUDGET_${String(capabilityId || '').toUpperCase().replace(/-/g, '_')}`;
}

function configuredTokensPerDay(capabilityId, { env = process.env, cwd = process.cwd() } = {}) {
  const envVal = parseFloat(env[envBudgetName(capabilityId)]);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;

  try {
    const cfgPath = join(cwd, 'construct.config.json');
    if (!existsSync(cfgPath)) return null;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const n = Number(cfg?.daemon?.unattendedBudgets?.[capabilityId]?.tokensPerDay);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function actorFor(capabilityId) {
  return `${ACTOR_PREFIX}${capabilityId}`;
}

/**
 * Resolve the effective per-day token budget object consumption-budget.mjs
 * expects. A capability with no configured cap resolves to `{tokens: 0,
 * configured: false}` — fail closed — never the deployment-mode default.
 */
export function resolveUnattendedBudget(capabilityId, { env = process.env, cwd = process.cwd() } = {}) {
  const tokensPerDay = configuredTokensPerDay(capabilityId, { env, cwd });
  if (tokensPerDay == null) {
    return { tokens: 0, toolCalls: Infinity, externalWrites: Infinity, queueSubmissions: Infinity, configured: false };
  }
  return { tokens: tokensPerDay, toolCalls: Infinity, externalWrites: Infinity, queueSubmissions: Infinity, configured: true };
}

/**
 * Would spending `tokensEstimate` more tokens for `capabilityId` today
 * exceed its budget? Read-only — no state mutated. `rootDir` selects the
 * durable store file (`<rootDir>/.cx/consumption-budgets.json`) and also
 * doubles as the `construct.config.json` lookup cwd.
 */
export function checkUnattendedSpend(rootDir, capabilityId, tokensEstimate = 1, { env = process.env } = {}) {
  const store = new ConsumptionBudgetStore({ rootDir, env });
  const budget = resolveUnattendedBudget(capabilityId, { env, cwd: rootDir });
  const runId = dayKey();
  const result = store.check(actorFor(capabilityId), runId, 'tokens', tokensEstimate, { budget });
  return {
    allowed: result.allowed,
    reason: result.allowed ? null : (budget.configured ? 'unattended-budget-exhausted' : 'unattended-budget-not-configured'),
    cap: result.cap,
    projected: result.projected,
    spent: result.consumption.tokens,
    configured: budget.configured,
  };
}

/**
 * Durably record `tokens` more spend for `capabilityId` today. Call only
 * after a real LLM call completes with its actual usage — never before a
 * denied check, so a refused tick never pollutes the ledger with spend
 * that did not happen.
 */
export function recordUnattendedSpend(rootDir, capabilityId, tokens, { env = process.env } = {}) {
  const store = new ConsumptionBudgetStore({ rootDir, env });
  const runId = dayKey();
  return store.record(actorFor(capabilityId), runId, 'tokens', tokens);
}

/**
 * Every unattended capability with recorded spend today, for doctor/status
 * surfacing. Filters the shared consumption-budget store down to today's
 * `unattended:` rows so callers don't need to know the internal key format.
 */
export function unattendedSpendSummary(rootDir, { env = process.env } = {}) {
  const store = new ConsumptionBudgetStore({ rootDir, env });
  const runId = dayKey();
  return store.allEntries()
    .filter((e) => e.runId === runId && e.actor.startsWith(ACTOR_PREFIX))
    .map((e) => {
      const capabilityId = e.actor.slice(ACTOR_PREFIX.length);
      return {
        capability: capabilityId,
        tokensSpent: e.consumption.tokens,
        cap: resolveUnattendedBudget(capabilityId, { env, cwd: rootDir }).tokens,
      };
    });
}
