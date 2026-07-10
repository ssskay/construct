/**
 * tests/functional/embed-reasoning-executor.functional.test.mjs
 *
 * construct-jvjow.2: opt-in, budget-capped reasoning executor for embed
 * capability ticks. Drives the real `runCapabilityTick`
 * (lib/embed/capability-jobs.mjs) with a real `createReasoningExecutor`
 * (lib/embed/reasoning-executor.mjs) and a fake/injected provider call
 * against an isolated tmpdir, proving the three required states:
 *
 *   1. disabled (default) — createReasoningExecutor returns null and the
 *      tick keeps the exact pre-existing honest
 *      skipped-with-reason(reasoning-executor-not-available) status.
 *   2. enabled + provider key + budget — a real (fake-provider) call
 *      happens, its output lands as a `ran` tick, and spend is durably
 *      recorded in lib/policy/unattended-budget.mjs's ledger.
 *   3. enabled + budget already exhausted — the fake provider is never
 *      called, the tick records an honest skipped-with-reason, and the
 *      deterministic snapshot/plan pipeline that already ran is untouched
 *      (no crash, no blocked tick, no writeIntents enqueued).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { runCapabilityTick, SKIP_REASON_NO_EXECUTOR } from '../../lib/embed/capability-jobs.mjs';
import { createReasoningExecutor, reasoningExecutorEnabled } from '../../lib/embed/reasoning-executor.mjs';
import { checkUnattendedSpend } from '../../lib/policy/unattended-budget.mjs';
import { ApprovalQueue } from '../../lib/embed/approval-queue.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const tmpDirs = [];
function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-reasoning-executor-fn-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { rmTmpDir(dir); } catch { /* best-effort cleanup */ }
  }
});

function opsManifest(overrides = {}) {
  return {
    id: 'operations',
    embed: {
      specialist: 'cx-operations',
      providerBindings: ['jira'],
      framework: 'cx-ops-dependency-sequencing',
      outputContract: 'architect-to-operations',
      proposalAuthority: 'propose-only',
      runtime: 'in-process',
      ...overrides,
    },
  };
}

function fakeSnapshot() {
  return {
    sections: [
      {
        provider: 'jira',
        items: [
          { id: 'PLATFORM-1', project: 'PLATFORM', statusCategory: 'to-do', summary: 'Migrate queue' },
        ],
      },
    ],
    errors: [],
  };
}

const conformingOutputPacket = {
  sequencedTasks: ['migrate-queue'],
  dependencyGraph: { 'migrate-queue': [] },
  ownershipMatrix: { 'migrate-queue': 'cx-operations' },
  verificationGates: { 'migrate-queue': 'queue drained, zero errors' },
  slippageRisk: 'low',
};

const grantedBindings = {
  operations: {
    providers: [{ id: 'jira', capabilities: ['read'] }],
    proposals: ['jira.createIssue'],
  },
};

test('disabled by default: no env/config opt-in produces the exact pre-existing honest skip', async () => {
  const rootDir = freshRoot();

  assert.equal(reasoningExecutorEnabled({ env: {}, cwd: rootDir }), false);

  const executor = createReasoningExecutor({ rootDir, env: {} });
  assert.equal(executor, null, 'createReasoningExecutor must return null when not opted in');

  const manifest = opsManifest();
  const approvalQueue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });

  const tick = await runCapabilityTick(manifest, {
    rootDir,
    env: {},
    getSnapshot: () => fakeSnapshot(),
    approvalQueue,
    embedBindings: grantedBindings,
    reasoningExecutor: executor ?? undefined,
  });

  assert.equal(tick.status, 'skipped-with-reason');
  assert.equal(tick.reason, SKIP_REASON_NO_EXECUTOR);
  assert.deepEqual(approvalQueue.list(), []);
});

test('enabled + provider key + budget: a real reasoned call runs, output lands, spend is ledgered', async () => {
  const rootDir = freshRoot();
  const env = {
    CONSTRUCT_EMBED_REASONING_EXECUTOR: '1',
    CONSTRUCT_UNATTENDED_BUDGET_EMBED_REASONING_OPERATIONS: '5000',
  };

  assert.equal(reasoningExecutorEnabled({ env, cwd: rootDir }), true);

  let providerCalls = 0;
  const fakeCallProvider = async (prompt, callOpts) => {
    providerCalls += 1;
    assert.equal(callOpts.apiKey, 'fake-key');
    assert.match(prompt.system, /JSON object/);
    return {
      outputPacket: conformingOutputPacket,
      writeProposals: [
        { providerId: 'jira', writeKind: 'createIssue', payload: { project: 'PLATFORM', summary: 'Migrate queue' } },
      ],
      usage: { inputTokens: 800, outputTokens: 400 },
    };
  };

  const executor = createReasoningExecutor({
    rootDir,
    env,
    apiKey: 'fake-key',
    callProvider: fakeCallProvider,
  });
  assert.equal(typeof executor, 'function');

  const manifest = opsManifest();
  const approvalQueue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });

  const tick = await runCapabilityTick(manifest, {
    rootDir,
    env,
    getSnapshot: () => fakeSnapshot(),
    approvalQueue,
    embedBindings: grantedBindings,
    reasoningExecutor: executor,
  });

  assert.equal(providerCalls, 1, 'the fake provider must be called exactly once for a real tick');
  assert.equal(tick.status, 'ran');
  assert.equal(tick.contractStatus, 'ok');
  assert.equal(tick.proposalsEnqueued.length, 1);
  assert.equal(tick.proposalsEnqueued[0].providerId, 'jira');

  const spendCheck = checkUnattendedSpend(rootDir, 'embed-reasoning-operations', 0, { env });
  assert.equal(spendCheck.spent, 1200, 'ledger must reflect the real recorded usage (800 in + 400 out)');

  const consumptionFile = path.join(rootDir, '.cx', 'consumption-budgets.json');
  assert.ok(fs.existsSync(consumptionFile), 'spend must persist to the durable consumption-budgets store');
});

test('enabled + budget exhausted: reasoning halts for the tick, provider is never called, deterministic pipeline is unaffected', async () => {
  const rootDir = freshRoot();
  const env = {
    CONSTRUCT_EMBED_REASONING_EXECUTOR: '1',
    // A budget far smaller than the executor's per-call estimate (1500
    // tokens default) so the pre-call check denies before any provider call.
    CONSTRUCT_UNATTENDED_BUDGET_EMBED_REASONING_OPERATIONS: '10',
  };

  let providerCalls = 0;
  const fakeCallProvider = async () => {
    providerCalls += 1;
    return { outputPacket: conformingOutputPacket, writeProposals: [], usage: { inputTokens: 10, outputTokens: 10 } };
  };

  const executor = createReasoningExecutor({
    rootDir,
    env,
    apiKey: 'fake-key',
    callProvider: fakeCallProvider,
  });

  const manifest = opsManifest();
  const approvalQueue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });

  const tick = await runCapabilityTick(manifest, {
    rootDir,
    env,
    getSnapshot: () => fakeSnapshot(),
    approvalQueue,
    embedBindings: grantedBindings,
    reasoningExecutor: executor,
  });

  assert.equal(providerCalls, 0, 'budget exhaustion must halt reasoning before the provider is ever called');
  assert.equal(tick.status, 'skipped-with-reason');
  assert.equal(tick.reason, 'unattended-budget-exhausted');
  assert.ok(!('proposalsEnqueued' in tick), 'a budget-halted tick must never carry proposal output');
  assert.deepEqual(approvalQueue.list(), [], 'no writeIntent may be enqueued when reasoning did not run');

  const spendCheck = checkUnattendedSpend(rootDir, 'embed-reasoning-operations', 0, { env });
  assert.equal(spendCheck.spent, 0, 'a denied check must never record spend that did not happen');

  // The deterministic pipeline (snapshot slice + workflow-invoke plan) ran
  // to completion ahead of the reasoning call and is not blocked by the
  // budget halt — a second tick, still under the exhausted budget, behaves
  // identically rather than crashing or corrupting state.
  const secondTick = await runCapabilityTick(manifest, {
    rootDir,
    env,
    getSnapshot: () => fakeSnapshot(),
    approvalQueue,
    embedBindings: grantedBindings,
    reasoningExecutor: executor,
  });
  assert.equal(secondTick.status, 'skipped-with-reason');
  assert.equal(secondTick.reason, 'unattended-budget-exhausted');
});
