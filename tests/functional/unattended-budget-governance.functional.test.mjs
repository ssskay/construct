/**
 * tests/functional/unattended-budget-governance.functional.test.mjs
 *
 * construct-95phc.3: cost governance for autonomous reasoning. Exercises the
 * real daemon-side LLM judge path (lib/telemetry/llm-judge.mjs, the job the
 * embed daemon schedules every 3h) end-to-end in an isolated tmpdir, and the
 * real `construct doctor` binary, to prove:
 *
 *   1. An unconfigured capability refuses to spend unattended — the durable
 *      ledger records zero real tokens and the upstream (mocked) LLM
 *      endpoint is never called.
 *   2. A capability with a configured token cap spends up to that cap, then
 *      hard-stops the rest of the tick's batch rather than running unbounded.
 *   3. `construct doctor` surfaces cumulative spend read from the real
 *      durable ledgers (cost-ledger.mjs + unattended-budget.mjs), not a
 *      placeholder.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { rmTmpDir } from '../helpers/cleanup.mjs';
import { runLLMJudgeEvaluations } from '../../lib/telemetry/llm-judge.mjs';
import { checkUnattendedSpend, recordUnattendedSpend } from '../../lib/policy/unattended-budget.mjs';
import { recordSpend } from '../../lib/cost-ledger.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'construct');

function fakeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cx-unattended-daemon-'));
}

function fakeTraces(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `trace-${i}`, name: 'test-trace', input: 'do the thing', output: 'did the thing' }));
}

/**
 * Builds a fetch double that answers the three endpoints the LLM-judge path
 * calls: telemetry traces/scores (via the injected fetchImpl) and the
 * Anthropic messages endpoint (via a temporarily-installed global fetch,
 * since lib/telemetry/llm-judge.mjs's callLLMJudge — matching the same
 * pattern as lib/embed/daemon.mjs's telemetry-generation job — calls the
 * real global fetch rather than an injectable one).
 */
function buildFetchDouble({ traces, usagePerCall }) {
  let anthropicCalls = 0;
  const fn = async (url, opts) => {
    const href = String(url);
    if (href.includes('/api/public/traces')) {
      return { ok: true, json: async () => ({ data: traces }) };
    }
    if (href.includes('/api/public/scores') && (!opts || opts.method !== 'POST')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (href.includes('/api/public/scores') && opts?.method === 'POST') {
      return { ok: true, json: async () => ({ id: 'score-1' }) };
    }
    if (href.includes('api.anthropic.com')) {
      anthropicCalls += 1;
      return {
        ok: true,
        json: async () => ({
          content: [{ text: JSON.stringify({ score: 0.9, comment: 'fine', category: 'quality' }) }],
          usage: { input_tokens: usagePerCall.input, output_tokens: usagePerCall.output },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return { fn, anthropicCalls: () => anthropicCalls };
}

test('llm-judge refuses to spend unattended without a configured budget', async () => {
  const rootDir = fakeRoot();
  try {
    const double = buildFetchDouble({ traces: fakeTraces(2), usagePerCall: { input: 1000, output: 500 } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = double.fn;
    // telemetryHeaders() reads CONSTRUCT_TELEMETRY_PUBLIC_KEY/SECRET_KEY from
    // process.env directly (not from the publicKey/secretKey call args), so
    // these must be set for the duration of the call.
    const savedPk = process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY;
    const savedSk = process.env.CONSTRUCT_TELEMETRY_SECRET_KEY;
    process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY = 'pk';
    process.env.CONSTRUCT_TELEMETRY_SECRET_KEY = 'sk';
    try {
      const result = await runLLMJudgeEvaluations({
        publicKey: 'pk', secretKey: 'sk', llmApiKey: 'ak',
        rootDir, env: {}, fetchImpl: double.fn, bestEffort: true, limit: 5,
      });
      assert.equal(result.evaluated, 0, 'no unconfigured capability may evaluate any trace');
      assert.ok(
        result.errors.some((e) => e.includes('unattended-budget-not-configured')),
        `expected a budget-denied error, got: ${JSON.stringify(result.errors)}`,
      );
      assert.equal(double.anthropicCalls(), 0, 'the LLM must never be called before a budget check passes');
    } finally {
      globalThis.fetch = originalFetch;
      if (savedPk === undefined) delete process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY; else process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY = savedPk;
      if (savedSk === undefined) delete process.env.CONSTRUCT_TELEMETRY_SECRET_KEY; else process.env.CONSTRUCT_TELEMETRY_SECRET_KEY = savedSk;
    }

    const spendCheck = checkUnattendedSpend(rootDir, 'embed-llm-judge', 1, { env: {} });
    assert.equal(spendCheck.spent, 0, 'a refused tick must not pollute the durable ledger with spend that never happened');
  } finally {
    rmTmpDir(rootDir);
  }
});

test('llm-judge spends up to its configured cap then hard-stops the rest of the batch', async () => {
  const rootDir = fakeRoot();
  try {
    // Each judged trace actually costs 1500 tokens (1000 in + 500 out). A
    // 2000-token cap admits exactly one trace: the first check's estimate
    // (1500) is within the empty-ledger cap, but the second check projects
    // the first trace's *real* recorded spend (1500) plus the next
    // estimate (1500) = 3000 > 2000, so it is denied before any second call.
    const env = { CONSTRUCT_UNATTENDED_BUDGET_EMBED_LLM_JUDGE: '2000' };
    const double = buildFetchDouble({ traces: fakeTraces(3), usagePerCall: { input: 1000, output: 500 } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = double.fn;
    const savedPk = process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY;
    const savedSk = process.env.CONSTRUCT_TELEMETRY_SECRET_KEY;
    process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY = 'pk';
    process.env.CONSTRUCT_TELEMETRY_SECRET_KEY = 'sk';
    try {
      const result = await runLLMJudgeEvaluations({
        publicKey: 'pk', secretKey: 'sk', llmApiKey: 'ak',
        rootDir, env, fetchImpl: double.fn, bestEffort: true, limit: 5,
      });
      assert.equal(result.evaluated, 1, 'exactly one trace fits under the 2000-token cap');
      assert.equal(double.anthropicCalls(), 1, 'the LLM endpoint must not be called once the cap is projected to be exceeded');
      assert.ok(
        result.errors.some((e) => e.includes('unattended-budget-exhausted')),
        `expected the remaining traces to hard-stop on exhaustion, got: ${JSON.stringify(result.errors)}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (savedPk === undefined) delete process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY; else process.env.CONSTRUCT_TELEMETRY_PUBLIC_KEY = savedPk;
      if (savedSk === undefined) delete process.env.CONSTRUCT_TELEMETRY_SECRET_KEY; else process.env.CONSTRUCT_TELEMETRY_SECRET_KEY = savedSk;
    }

    const spendCheck = checkUnattendedSpend(rootDir, 'embed-llm-judge', 0, { env });
    assert.equal(spendCheck.spent, 1500, 'the durable ledger must reflect the real recorded spend of the one call that ran');

    const consumptionFile = path.join(rootDir, '.cx', 'consumption-budgets.json');
    assert.ok(fs.existsSync(consumptionFile), 'spend must persist to the durable consumption-budgets store');
    const persisted = JSON.parse(fs.readFileSync(consumptionFile, 'utf8'));
    const key = Object.keys(persisted).find((k) => k.startsWith('unattended:embed-llm-judge::'));
    assert.ok(key, 'expected an unattended:embed-llm-judge:: row in the persisted store');
    assert.equal(persisted[key].tokens, 1500);
  } finally {
    rmTmpDir(rootDir);
  }
});

test('construct doctor surfaces cumulative spend from the real ledgers', () => {
  const rootDir = fakeRoot();
  try {
    process.env.CONSTRUCT_DOCTOR_ROOT = rootDir;
    try {
      recordSpend({ personaId: 'sre', tokens: 1200, costUsd: 0.25 });
    } finally {
      delete process.env.CONSTRUCT_DOCTOR_ROOT;
    }
    recordUnattendedSpend(rootDir, 'embed-telemetry-probe', 48, { env: {} });

    const result = spawnSync(process.execPath, [BIN, 'doctor'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HOME: rootDir,
        CX_HOME_OVERRIDE: rootDir,
        CONSTRUCT_DOCTOR_ROOT: rootDir,
        CONSTRUCT_SKIP_BOOTSTRAP_PROBE: '1',
        BOOTSTRAP_CHECKED: '1',
        CONSTRUCT_DISABLE_AUTO_CLEANUP: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });

    const spendLine = result.stdout.split('\n').find((l) => l.includes('Cumulative spend today'));
    assert.ok(spendLine, `doctor output should include a cumulative spend line.\nstdout: ${result.stdout.slice(0, 2000)}`);
    assert.match(spendLine, /\$0\.2500/);

    const unattendedLine = result.stdout.split('\n').find((l) => l.includes('Unattended spend') && l.includes('embed-telemetry-probe'));
    assert.ok(unattendedLine, `doctor output should include the unattended capability's spend.\nstdout: ${result.stdout.slice(0, 2000)}`);
    assert.match(unattendedLine, /48/);
  } finally {
    rmTmpDir(rootDir);
  }
});
