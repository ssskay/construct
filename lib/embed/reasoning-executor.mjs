/**
 * lib/embed/reasoning-executor.mjs — opt-in, budget-capped reasoning
 * executor for embed-capability ticks (construct-jvjow.2).
 *
 * Off by default. `reasoningExecutorEnabled` resolves the opt-in flag —
 * `CONSTRUCT_EMBED_REASONING_EXECUTOR=1` env var, or
 * `daemon.embedReasoning.enabled: true` in construct.config.json — and
 * `createReasoningExecutor` returns `null` unless it is set, so
 * lib/embed/daemon.mjs's wiring stays a no-op reasoningExecutor by default
 * and lib/embed/capability-jobs.mjs's `runCapabilityTick` keeps recording
 * the exact honest `skipped-with-reason(reasoning-executor-not-available)`
 * tick it already does with no injected executor (ADR-0061 §3) — this
 * module changes nothing about that default path.
 *
 * When enabled, the returned function matches capability-jobs.mjs's
 * `(plan, ctx) -> {outputPacket, writeProposals}` injection point exactly,
 * so wiring it in at the daemon is a one-line change. Before every provider
 * call it gates through lib/policy/unattended-budget.mjs's
 * checkUnattendedSpend/recordUnattendedSpend (construct-95phc.3's
 * fail-closed ConsumptionBudgetStore extension for daemon-originated LLM
 * spend) under actor key `embed-reasoning-<capabilityId>` — the same
 * mechanism lib/telemetry/llm-judge.mjs already uses for its own daemon LLM
 * calls, not a parallel budget. A denied check returns `{ skippedReason }`
 * instead of calling the provider or throwing; capability-jobs.mjs turns
 * that into an honest skipped-with-reason tick without ever touching the
 * deterministic snapshot/plan pipeline that already ran ahead of this call
 * — reasoning is additive, never a hard dependency of the tick succeeding.
 *
 * The provider call is a bare fetch to Anthropic's Messages API — the same
 * daemon-side request/parse shape lib/telemetry/llm-judge.mjs's
 * callLLMJudge (lib/telemetry/llm-judge.mjs:134) already uses for
 * unattended Anthropic calls, with the correct top-level `system` field
 * (llm-judge's `messages:[{role:'system',...}]` shape is not replicated
 * here). `fetchImpl` and `callProvider` are injectable so tests never hit
 * a real network.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkUnattendedSpend, recordUnattendedSpend } from '../policy/unattended-budget.mjs';

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 1000;
const DEFAULT_TOKEN_ESTIMATE = 1500;

/** Reserved reason recorded when the enabled executor has no provider key configured. */
export const SKIP_REASON_NO_PROVIDER_KEY = 'reasoning-executor-no-provider-key';

/** Reserved reason recorded when the provider call itself fails. */
export const SKIP_REASON_PROVIDER_ERROR_PREFIX = 'reasoning-executor-provider-error';

function envFlag(env, name) {
  const raw = env?.[name];
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return undefined;
}

/**
 * True only when explicitly opted in — env var wins over
 * construct.config.json's `daemon.embedReasoning.enabled`, else off.
 */
export function reasoningExecutorEnabled({ env = process.env, cwd = process.cwd() } = {}) {
  const envVal = envFlag(env, 'CONSTRUCT_EMBED_REASONING_EXECUTOR');
  if (envVal !== undefined) return envVal;

  try {
    const cfgPath = join(cwd, 'construct.config.json');
    if (!existsSync(cfgPath)) return false;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return cfg?.daemon?.embedReasoning?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Budget actor id for a capability's reasoning spend — kept in its own
 * `embed-reasoning-` namespace so it never collides with any other
 * unattended-budget.mjs consumer keyed on the bare capability id.
 */
function capabilityBudgetId(manifestId) {
  return `embed-reasoning-${String(manifestId || 'unknown')}`;
}

/**
 * Compose the reasoning prompt from the workflow-invoke.mjs plan and the
 * capability's bound snapshot slice. `plan.outputs.requiredOutputFields`
 * (framework `emits` tokens, in order — ADR-0062 §3) becomes the exact set
 * of JSON keys the model must return; a role with no bound framework falls
 * back to a single `result` field rather than failing the tick.
 */
function buildReasoningPrompt(plan, ctx) {
  const fields = plan?.outputs?.requiredOutputFields ?? [];
  const fieldList = fields.length ? fields.join(', ') : 'result';
  const steps = plan?.framework?.available ? (plan.framework.steps ?? []) : [];
  const stepsText = steps.length
    ? steps.map((step, i) => `${i + 1}. ${step.description || step.id || step.emits}`).join('\n')
    : 'Reason directly about the evidence below and produce the requested fields.';
  const sectionsText = (ctx?.sections ?? [])
    .map((section) => `${section.provider}: ${JSON.stringify(section.items ?? [])}`)
    .join('\n') || '(no bound evidence)';

  return {
    system: `You are the ${ctx?.specialistId || 'specialist'} role reasoning for an unattended embed-capability tick. Follow the reasoning steps, then return ONLY a JSON object with exactly these fields: ${fieldList}. You may optionally include a "writeProposals" array of {providerId, writeKind, payload} objects for external writes you believe should be proposed — every proposal is still checked against the specialist's own authority grant before anything happens.`,
    user: `# Reasoning steps\n${stepsText}\n\n# Bound evidence\n${sectionsText}\n\n# Required output fields\n${fieldList}`,
  };
}

/**
 * Call Anthropic's Messages API directly — the same daemon-side call shape
 * lib/telemetry/llm-judge.mjs's callLLMJudge (lib/telemetry/llm-judge.mjs:134)
 * uses, with the system prompt on the top-level `system` field rather than
 * a `role:'system'` message. Returns the parsed JSON output packet, any
 * `writeProposals` the model included, and real token usage.
 */
async function callAnthropicMessages(prompt, { model, maxTokens, apiKey, fetchImpl, baseUrl = 'https://api.anthropic.com' }) {
  const res = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text || '';
  const usage = {
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  const { writeProposals, ...outputPacket } = parsed;

  return {
    outputPacket,
    writeProposals: Array.isArray(writeProposals) ? writeProposals : [],
    usage,
  };
}

/**
 * Build the `(plan, ctx) -> {outputPacket, writeProposals}` function
 * lib/embed/capability-jobs.mjs's `runCapabilityTick` accepts as
 * `opts.reasoningExecutor`. Returns `null` when the opt-in flag is off —
 * the caller (lib/embed/daemon.mjs) should pass that straight through as
 * `reasoningExecutor: undefined`, preserving the exact pre-existing
 * no-executor skip path.
 *
 * @param {object} [opts]
 * @param {string} opts.rootDir                    daemon rootDir; also the unattended-budget ledger location
 * @param {object} [opts.env]
 * @param {string} [opts.apiKey]                    provider key; defaults to env.ANTHROPIC_API_KEY
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.tokenEstimate]              pre-call budget estimate (prompt + response headroom)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(prompt: object, callOpts: object) => Promise<object>} [opts.callProvider]  test seam for the provider call
 * @returns {null | ((plan: object, ctx: object) => Promise<object>)}
 */
export function createReasoningExecutor({
  rootDir,
  env = process.env,
  apiKey = env.ANTHROPIC_API_KEY,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  tokenEstimate = DEFAULT_TOKEN_ESTIMATE,
  fetchImpl = globalThis.fetch,
  callProvider = callAnthropicMessages,
} = {}) {
  if (!reasoningExecutorEnabled({ env, cwd: rootDir })) return null;

  return async function reasoningExecutor(plan, ctx) {
    if (!apiKey) return { skippedReason: SKIP_REASON_NO_PROVIDER_KEY };

    const capabilityId = capabilityBudgetId(ctx?.manifest?.id);
    const budgetCheck = checkUnattendedSpend(rootDir, capabilityId, tokenEstimate, { env });
    if (!budgetCheck.allowed) {
      return { skippedReason: budgetCheck.reason };
    }

    const prompt = buildReasoningPrompt(plan, ctx);

    let result;
    try {
      result = await callProvider(prompt, { model, maxTokens, apiKey, fetchImpl });
    } catch (err) {
      return { skippedReason: `${SKIP_REASON_PROVIDER_ERROR_PREFIX}: ${err.message}` };
    }

    const spentTokens = (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);
    if (spentTokens > 0) recordUnattendedSpend(rootDir, capabilityId, spentTokens, { env });

    return { outputPacket: result.outputPacket, writeProposals: result.writeProposals };
  };
}
