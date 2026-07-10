/**
 * lib/telemetry/llm-judge.mjs — LLM-as-a-judge evaluation system.
 *
 * Automatically evaluates agent work by:
 * 1. Sampling traces that lack scores
 * 2. Using an LLM to score quality based on the task and output
 * 3. Recording scores back to the telemetry backend for continuous improvement
 *
 * Evaluation criteria includes:
 * - Task completion accuracy (did it solve the problem?)
 * - Code quality (if applicable)
 * - Adherence to requirements
 * - Best practices followed
 * - Documentation completeness
 * - Error handling robustness
 */

import { homedir } from 'node:os';
import { addObservation } from '../observation-store.mjs';
import { loadConstructEnv } from '../env-config.mjs';
import { checkUnattendedSpend, recordUnattendedSpend } from '../policy/unattended-budget.mjs';

const UNATTENDED_CAPABILITY = 'embed-llm-judge';

const CONF_ENV = loadConstructEnv({ warn: false });

function telemetryHeaders() {
  const key = CONF_ENV.CONSTRUCT_TELEMETRY_PUBLIC_KEY ?? process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY;
  const secret = CONF_ENV.CONSTRUCT_TELEMETRY_SECRET_KEY ?? process.env.CONSTRUCT_TELEMETRY_SECRET_KEY;
  if (!key || !secret) throw new Error('CONSTRUCT_TELEMETRY_PUBLIC_KEY and CONSTRUCT_TELEMETRY_SECRET_KEY must be set.');
  return {
    Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function telemetryBaseUrl() {
  return (CONF_ENV.CONSTRUCT_TELEMETRY_URL ?? process.env.CONSTRUCT_TELEMETRY_URL ?? '').replace(/\/$/, '');
}

/**
 * Fetch recent traces that have no scores yet
 */
async function fetchUnscoredTraces({ url, headers, limit = 50, fetchImpl = globalThis.fetch }) {
  // First get recent traces
  const recentRes = await fetchImpl(`${url}/api/public/traces?limit=${limit * 2}&orderBy=timestamp.desc`, { headers });
  if (!recentRes.ok) throw new Error(`Telemetry traces fetch ${recentRes.status}`);
  const recentJson = await recentRes.json().catch(() => ({}));
  const recentTraces = Array.isArray(recentJson.data) ? recentJson.data : [];
  
  // Get scores to filter out already-scored traces
  const scoresRes = await fetchImpl(`${url}/api/public/scores?name=quality&limit=100`, { headers });
  if (!scoresRes.ok) throw new Error(`Telemetry scores fetch ${scoresRes.status}`);
  const scoresJson = await scoresRes.json().catch(() => ({}));
  const scoredTraceIds = new Set((Array.isArray(scoresJson.data) ? scoresJson.data : [])
    .map(s => s.traceId)
    .filter(Boolean));
  
  // Filter to traces without scores
  const unscored = recentTraces
    .filter(trace => !scoredTraceIds.has(trace.id))
    .slice(0, limit);
  
  return unscored;
}

/**
 * Build evaluation prompt for the LLM judge
 */
function buildEvaluationPrompt(trace, metadata = {}) {
  const agentName = trace?.metadata?.agentName || trace?.name || 'unknown';
  const task = typeof trace.input === 'string' ? trace.input : JSON.stringify(trace.input || '');
  const output = typeof trace.output === 'string' ? trace.output : JSON.stringify(trace.output || '');
  
  const isCodeTask = task.toLowerCase().includes('code') || 
                    task.toLowerCase().includes('implement') ||
                    task.toLowerCase().includes('fix') ||
                    task.toLowerCase().includes('write');
  
  const criteria = isCodeTask ? `
Rate this code implementation on a scale of 0.0 (complete failure) to 1.0 (perfect):
1. **Task Completion (0.3 weight)**: Did it solve the exact problem stated?
2. **Code Quality (0.25 weight)**: Clean, readable, follows best practices?
3. **Requirements Adherence (0.2 weight)**: Followed all specifications/constraints?
4. **Robustness (0.15 weight)**: Handles edge cases, proper error handling?
5. **Documentation (0.1 weight)**: Comments, clarity, maintainability?
` : `
Rate this agent work on a scale of 0.0 (complete failure) to 1.0 (perfect):
1. **Task Completion (0.4 weight)**: Did it solve the exact problem stated?
2. **Requirements Adherence (0.3 weight)**: Followed all specifications/constraints?
3. **Clarity & Quality (0.2 weight)**: Clear, well-structured, professional?
4. **Thoroughness (0.1 weight)**: Complete, covers all aspects needed?
`;

  const responseFormat = `Return ONLY a JSON object with:
{
  "score": 0.85,  // numeric score 0.0-1.0
  "comment": "Brief explanation of the score",
  "category": "quality",
  "breakdown": {
    "task_completion": 0.9,
    "code_quality": 0.8,
    "requirements_adherence": 0.9,
    "robustness": 0.7,
    "documentation": 0.8
  }
}`;

  return {
    system: `You are an expert quality evaluator for AI agent work. Evaluate the work objectively based on the criteria.`,
    user: `# Agent Task
Agent: ${agentName}
Task: ${task}

# Agent Output
${output}

# Evaluation Criteria
${criteria}

# Instructions
${responseFormat}

# Additional Context
${metadata?.workCategory ? `Work category: ${metadata.workCategory}` : ''}
${metadata?.routeIntent ? `Intent: ${metadata.routeIntent}` : ''}
${trace?.metadata?.goal ? `Goal: ${trace.metadata.goal}` : ''}`,
  };
}

/**
 * Call LLM for evaluation
 */
async function callLLMJudge(prompt, { model = 'claude-3-5-sonnet-20241022', apiKey, baseUrl = 'https://api.anthropic.com' }) {
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  
  const body = {
    model,
    max_tokens: 1000,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.1,
  };
  
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${errorText.slice(0, 200)}`);
  }
  
  const data = await res.json();
  const content = data.content?.[0]?.text || '';
  const usage = {
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };

  // Parse JSON from response
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return { ...JSON.parse(jsonMatch[0]), usage };
    }
    // Fallback: try to extract score
    const scoreMatch = content.match(/"score":\s*([0-9.]+)/);
    const commentMatch = content.match(/"comment":\s*"([^"]+)"/);
    return {
      score: scoreMatch ? parseFloat(scoreMatch[1]) : 0.5,
      comment: commentMatch ? commentMatch[1] : 'Could not parse evaluation',
      category: 'quality',
      usage,
    };
  } catch (err) {
    return {
      score: 0.5,
      comment: `Failed to parse LLM response: ${err.message}`,
      category: 'quality',
      usage,
    };
  }
}

/**
 * Score a trace using LLM judge
 */
async function scoreTraceWithLLM(trace, { llmApiKey, llmModel, fetchImpl = globalThis.fetch }) {
  if (!llmApiKey) {
    throw new Error('LLM API key required for judge evaluations');
  }
  
  const prompt = buildEvaluationPrompt(trace, trace.metadata);
  const evaluation = await callLLMJudge(prompt, {
    model: llmModel || 'claude-3-5-sonnet-20241022',
    apiKey: llmApiKey,
  });
  
  return {
    traceId: trace.id,
    score: evaluation.score,
    comment: evaluation.comment,
    breakdown: evaluation.breakdown,
    usage: evaluation.usage ?? { inputTokens: 0, outputTokens: 0 },
    metadata: {
      evaluatedAt: new Date().toISOString(),
      evaluatorModel: llmModel || 'claude-3-5-sonnet-20241022',
      source: 'llm-judge',
    },
  };
}

/**
 * Post score to telemetry backend
 */
async function postScoreToTelemetry({ url, headers, scoreData, fetchImpl = globalThis.fetch }) {
  const body = {
    id: crypto.randomUUID(),
    traceId: scoreData.traceId,
    name: 'quality',
    value: scoreData.score,
    dataType: 'NUMERIC',
    comment: scoreData.comment,
    metadata: scoreData.metadata,
  };
  
  const res = await fetchImpl(`${url}/api/public/scores`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Telemetry score post ${res.status}: ${text.slice(0, 200)}`);
  }
  
  return res.json().catch(() => ({}));
}

/**
 * Record evaluation observation for learning
 */
function recordEvaluationObservation(scoreData, trace) {
  const rootDir = homedir();
  const agentName = trace?.metadata?.agentName || trace?.name || 'construct';
  
  addObservation(rootDir, {
    role: 'llm-judge',
    category: 'evaluation',
    summary: `LLM judge scored ${agentName} work at ${scoreData.score.toFixed(2)}: ${scoreData.comment.slice(0, 100)}`,
    content: `Trace: ${scoreData.traceId}
Score: ${scoreData.score}
Comment: ${scoreData.comment}
Agent: ${agentName}
Task: ${typeof trace.input === 'string' ? trace.input.slice(0, 500) : 'N/A'}
Evaluator: ${scoreData.metadata.evaluatorModel}
Breakdown: ${JSON.stringify(scoreData.breakdown || {}, null, 2)}`,
    tags: ['llm-judge', 'quality-score', agentName, 'auto-evaluated'],
    confidence: 0.9,
    source: 'llm-judge',
  });
}

/**
 * Main entrypoint: Run LLM judge evaluations on unscored traces
 */
export async function runLLMJudgeEvaluations({
  publicKey = CONF_ENV.CONSTRUCT_TELEMETRY_PUBLIC_KEY ?? process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY,
  secretKey = CONF_ENV.CONSTRUCT_TELEMETRY_SECRET_KEY ?? process.env.CONSTRUCT_TELEMETRY_SECRET_KEY,
  llmApiKey = CONF_ENV.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  llmModel = 'claude-3-5-sonnet-20241022',
  limit = 10,
  bestEffort = true,
  fetchImpl = globalThis.fetch,
  rootDir = homedir(),
  env = process.env,
} = {}) {
  if (!publicKey || !secretKey) {
    return { evaluated: 0, errors: ['Telemetry credentials not configured'] };
  }

  if (!llmApiKey) {
    return { evaluated: 0, errors: ['LLM API key (ANTHROPIC_API_KEY) required for judge evaluations'] };
  }

  const url = telemetryBaseUrl();
  const headers = telemetryHeaders();
  const errors = [];
  let evaluated = 0;

  try {
    // Get unscored traces
    const unscoredTraces = await fetchUnscoredTraces({ url, headers, limit, fetchImpl });

    for (const trace of unscoredTraces) {
      try {
        // construct-95phc.3: nothing spends unattended without a configured
        // budget. An unconfigured cap resolves to {tokens: 0} (fail closed),
        // and an exhausted cap hard-stops the rest of this batch rather than
        // skipping trace-by-trace, since the budget cannot recover mid-tick.
        // The estimate (prompt + 1000 max_tokens response) is checked before
        // real usage is known; actual usage is recorded after the call below.
        const estimate = 1500;
        const budgetCheck = checkUnattendedSpend(rootDir, UNATTENDED_CAPABILITY, estimate, { env });
        if (!budgetCheck.allowed) {
          errors.push(`budget-denied: ${budgetCheck.reason} (spent ${budgetCheck.spent}/${budgetCheck.cap ?? 0} tokens today)`);
          break;
        }

        // Score with LLM
        const scoreData = await scoreTraceWithLLM(trace, { llmApiKey, llmModel, fetchImpl });

        const spentTokens = (scoreData.usage?.inputTokens || 0) + (scoreData.usage?.outputTokens || 0);
        if (spentTokens > 0) recordUnattendedSpend(rootDir, UNATTENDED_CAPABILITY, spentTokens, { env });

        // Post score to telemetry backend
        await postScoreToTelemetry({ url, headers, scoreData, fetchImpl });

        // Record observation for learning
        recordEvaluationObservation(scoreData, trace);

        evaluated++;

      } catch (err) {
        if (bestEffort) {
          errors.push(`${trace?.id}: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

  } catch (err) {
    if (bestEffort) {
      errors.push(`Initialization error: ${err.message}`);
    } else {
      throw err;
    }
  }

  return { evaluated, errors };
}

/**
 * CLI entrypoint
 */
export async function runLLMJudgeCli(args = []) {
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 10 : 10;
  
  const modelArg = args.find((a) => a.startsWith('--model='));
  const model = modelArg ? modelArg.split('=')[1] : 'claude-3-5-sonnet-20241022';
  
  process.stdout.write(`Running LLM judge evaluations (limit: ${limit}, model: ${model})…\n`);
  
  const result = await runLLMJudgeEvaluations({
    limit,
    llmModel: model,
    bestEffort: false,
  });
  
  process.stdout.write(`Done. evaluated=${result.evaluated}${result.errors.length ? ` errors=${result.errors.length}` : ''}\n`);
  if (result.errors.length) {
    for (const e of result.errors) process.stderr.write(`  ${e}\n`);
  }
  
  return result;
}