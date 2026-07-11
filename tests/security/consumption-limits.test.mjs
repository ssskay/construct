/**
 * tests/security/consumption-limits.test.mjs — LMCP-N5: durable consumption
 * limits per actor/run.
 *
 * @owasp LLM10
 * @secures architecture-review, data-structure, memo-draft, prd-draft, proposal-review, risk-review, structure-notes, transcript-process, triage
 *
 * Covers lib/policy/consumption-budget.mjs standalone (defaults per
 * deployment mode, check/record semantics, restart durability) and its
 * wiring into lib/mcp/broker.mjs's Broker.invoke (a run exceeding its token
 * or tool-call budget halts with a durable budget-denied record instead of
 * executing; a caller with no runId is unaffected). Broker.invoke is a
 * generic actor/tool dispatch wrapper, not scoped to one workflow type, so
 * the budget-denied guarantee (LLM10 — unbounded consumption) covers every
 * one of the 9 executable workflows named above the same way it covers any
 * other MCP-dispatched tool call (construct-9oi4.14.9 N8 gap-closure).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Broker, BudgetExceeded } from '../../lib/mcp/broker.mjs';
import {
  ConsumptionBudgetStore, resolveDefaultBudget, DEFAULT_BUDGETS_BY_MODE,
} from '../../lib/policy/consumption-budget.mjs';
import { pinDoctorRoot } from '../helpers/doctor-root.mjs';

// The broker's default auditRecorder appends to the audit trail under
// CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs); pinned to a tmpdir so brokered
// calls in the suite never write the real user's audit chain.

const doctorPin = pinDoctorRoot('cx-consumption-doctor-');
after(() => doctorPin.restore());

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-consumption-limits-'));
  tmpDirs.push(dir);
  return dir;
}

function allowingPolicy() {
  return () => ({ allowed: true, reason: 'ok', approvalRequired: false, source: 'test' });
}

describe('resolveDefaultBudget', () => {
  it('solo mode is unbounded (null) — budgets default-off in solo', () => {
    assert.equal(resolveDefaultBudget('solo'), null);
  });
  it('team and enterprise modes have real per-kind caps', () => {
    assert.ok(DEFAULT_BUDGETS_BY_MODE.team.tokens > 0);
    assert.ok(DEFAULT_BUDGETS_BY_MODE.enterprise.tokens > DEFAULT_BUDGETS_BY_MODE.team.tokens);
  });
  it('an unknown mode falls back to the team default', () => {
    assert.deepEqual(resolveDefaultBudget('nonsense'), DEFAULT_BUDGETS_BY_MODE.team);
  });
});

describe('ConsumptionBudgetStore', () => {
  it('check() reports allowed=true and does not mutate state', () => {
    const rootDir = fakeRoot();
    const store = new ConsumptionBudgetStore({ rootDir, env: { CONSTRUCT_DEPLOYMENT_MODE: 'team' } });
    const result = store.check('alice', 'run-1', 'toolCalls', 1);
    assert.equal(result.allowed, true);
    assert.equal(store.consumptionFor('alice', 'run-1').toolCalls, 0);
  });

  it('record() accumulates consumption per actor+run and check() reflects it', () => {
    const rootDir = fakeRoot();
    const store = new ConsumptionBudgetStore({ rootDir, env: { CONSTRUCT_DEPLOYMENT_MODE: 'team' } });
    store.record('alice', 'run-1', 'toolCalls', 1);
    store.record('alice', 'run-1', 'toolCalls', 1);
    assert.equal(store.consumptionFor('alice', 'run-1').toolCalls, 2);
    // A different run for the same actor is a distinct budget bucket.
    assert.equal(store.consumptionFor('alice', 'run-2').toolCalls, 0);
  });

  it('check() denies once projected consumption would exceed an explicit budget', () => {
    const rootDir = fakeRoot();
    const store = new ConsumptionBudgetStore({ rootDir, env: {} });
    store.record('alice', 'run-1', 'tokens', 95);
    const withinBudget = store.check('alice', 'run-1', 'tokens', 5, { budget: { tokens: 100 } });
    assert.equal(withinBudget.allowed, true);
    const overBudget = store.check('alice', 'run-1', 'tokens', 6, { budget: { tokens: 100 } });
    assert.equal(overBudget.allowed, false);
    assert.equal(overBudget.cap, 100);
    assert.equal(overBudget.projected, 101);
  });

  it('solo mode (no explicit budget) never denies regardless of consumption', () => {
    const rootDir = fakeRoot();
    const store = new ConsumptionBudgetStore({ rootDir, env: { CONSTRUCT_DEPLOYMENT_MODE: 'solo' } });
    store.record('alice', 'run-1', 'tokens', 10_000_000);
    const result = store.check('alice', 'run-1', 'tokens', 1);
    assert.equal(result.allowed, true);
    assert.equal(result.cap, null);
  });

  it('budgets survive restart: a new store instance reading the same file sees prior consumption', () => {
    const rootDir = fakeRoot();
    const first = new ConsumptionBudgetStore({ rootDir, env: {} });
    first.record('alice', 'run-1', 'toolCalls', 3);
    first.record('alice', 'run-1', 'tokens', 500);

    const second = new ConsumptionBudgetStore({ rootDir, env: {} });
    const consumption = second.consumptionFor('alice', 'run-1');
    assert.equal(consumption.toolCalls, 3);
    assert.equal(consumption.tokens, 500);
  });

  it('allEntries() lists every actor+run row with its resolved budget', () => {
    const rootDir = fakeRoot();
    const store = new ConsumptionBudgetStore({ rootDir, env: { CONSTRUCT_DEPLOYMENT_MODE: 'team' } });
    store.record('alice', 'run-1', 'toolCalls', 2);
    store.record('bob', 'run-2', 'toolCalls', 1);
    const entries = store.allEntries();
    assert.equal(entries.length, 2);
    const alice = entries.find((e) => e.actor === 'alice' && e.runId === 'run-1');
    assert.ok(alice);
    assert.equal(alice.consumption.toolCalls, 2);
    assert.ok(alice.budget);
  });
});

describe('Broker.invoke consumption budgets', () => {
  it('a run exceeding its token budget halts before execute() and leaves a durable budget-denied record', async () => {
    const rootDir = fakeRoot();
    const broker = new Broker({ rootDir, policy: allowingPolicy(), emit: () => {} });
    let executed = false;

    await broker.invoke({
      role: 'engineer', tool: 'fs', action: 'read', runId: 'run-1', tokenEstimate: 900,
      budget: { tokens: 1000, toolCalls: 1000, externalWrites: 1000, queueSubmissions: 1000 },
      execute: async () => { executed = true; return 'ok'; },
    });
    assert.equal(executed, true, 'first call is within budget and must execute');

    executed = false;
    await assert.rejects(
      () => broker.invoke({
        role: 'engineer', tool: 'fs', action: 'read', runId: 'run-1', tokenEstimate: 200,
        budget: { tokens: 1000, toolCalls: 1000, externalWrites: 1000, queueSubmissions: 1000 },
        execute: async () => { executed = true; },
      }),
      (err) => err instanceof BudgetExceeded && err.kind === 'tokens',
    );
    assert.equal(executed, false, 'the tool must never execute once the run token budget would be exceeded');

    const { DeniedStore } = await import('../../lib/mcp/denied-store.mjs');
    const denied = new DeniedStore({ rootDir }).readAll();
    assert.ok(denied.some((d) => d.outcome === 'budget_denied' && d.actor === 'engineer'));
  });

  it('a run exceeding its tool-call budget halts before execute()', async () => {
    const rootDir = fakeRoot();
    const broker = new Broker({ rootDir, policy: allowingPolicy(), emit: () => {} });
    const budget = { tokens: 1_000_000, toolCalls: 2, externalWrites: 1000, queueSubmissions: 1000 };

    await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', runId: 'run-2', budget, execute: async () => 1 });
    await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', runId: 'run-2', budget, execute: async () => 2 });

    let executed = false;
    await assert.rejects(
      () => broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', runId: 'run-2', budget, execute: async () => { executed = true; } }),
      (err) => err instanceof BudgetExceeded && err.kind === 'toolCalls',
    );
    assert.equal(executed, false);
  });

  it('a caller that never passes runId is completely unaffected by consumption budgets', async () => {
    const rootDir = fakeRoot();
    // rateBudget raised well past the default 30/window so this exercises
    // only the consumption-budget path, not the pre-existing per-actor/tool
    // rate limiter (LMCP-I1), which is a separate, already-tested gate.
    const broker = new Broker({ rootDir, policy: allowingPolicy(), emit: () => {}, rateBudget: 1000 });
    for (let i = 0; i < 50; i++) {
      const { result } = await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => i });
      assert.equal(result, i);
    }
  });

  it('status-shaped consumption is queryable per run after brokered calls', async () => {
    const rootDir = fakeRoot();
    const broker = new Broker({ rootDir, policy: allowingPolicy(), emit: () => {} });
    await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', runId: 'run-3', tokenEstimate: 42, execute: async () => 1 });
    await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', runId: 'run-3', tokenEstimate: 8, execute: async () => 2 });

    const store = new ConsumptionBudgetStore({ rootDir, env: {} });
    const consumption = store.consumptionFor('engineer', 'run-3');
    assert.equal(consumption.toolCalls, 2);
    assert.equal(consumption.tokens, 50);
  });
});
