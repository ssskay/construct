/**
 * tests/policy/unattended-budget.test.mjs — construct-95phc.3: fail-closed
 * token budget gate for daemon-originated (unattended) LLM spend.
 *
 * Covers lib/policy/unattended-budget.mjs standalone: an unconfigured
 * capability refuses to spend (fail closed, even in solo mode); an env- or
 * config-configured capability spends up to its cap then hard-stops;
 * spend is durable across a fresh store instance (process-restart safe);
 * unattendedSpendSummary surfaces today's rows for doctor.
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkUnattendedSpend, recordUnattendedSpend, resolveUnattendedBudget, unattendedSpendSummary,
} from '../../lib/policy/unattended-budget.mjs';

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-unattended-budget-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CONSTRUCT_UNATTENDED_BUDGET_')) delete process.env[k];
  }
});

describe('resolveUnattendedBudget', () => {
  it('an unconfigured capability resolves to {tokens: 0, configured: false} — fail closed', () => {
    const rootDir = fakeRoot();
    const budget = resolveUnattendedBudget('some-capability', { env: { CONSTRUCT_DEPLOYMENT_MODE: 'solo' }, cwd: rootDir });
    assert.equal(budget.tokens, 0);
    assert.equal(budget.configured, false);
  });

  it('an env override configures a real cap', () => {
    const rootDir = fakeRoot();
    const env = { CONSTRUCT_UNATTENDED_BUDGET_MY_CAP: '5000' };
    const budget = resolveUnattendedBudget('my-cap', { env, cwd: rootDir });
    assert.equal(budget.tokens, 5000);
    assert.equal(budget.configured, true);
  });

  it('a construct.config.json override configures a real cap', () => {
    const rootDir = fakeRoot();
    fs.writeFileSync(
      path.join(rootDir, 'construct.config.json'),
      JSON.stringify({ daemon: { unattendedBudgets: { 'my-cap': { tokensPerDay: 3000 } } } }),
    );
    const budget = resolveUnattendedBudget('my-cap', { env: {}, cwd: rootDir });
    assert.equal(budget.tokens, 3000);
    assert.equal(budget.configured, true);
  });
});

describe('checkUnattendedSpend', () => {
  it('denies an unconfigured capability even in solo mode', () => {
    const rootDir = fakeRoot();
    const result = checkUnattendedSpend(rootDir, 'unconfigured-cap', 10, { env: { CONSTRUCT_DEPLOYMENT_MODE: 'solo' } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'unattended-budget-not-configured');
  });

  it('allows spend up to a configured cap, then hard-stops', () => {
    const rootDir = fakeRoot();
    const env = { CONSTRUCT_UNATTENDED_BUDGET_CAPPED: '100' };

    const first = checkUnattendedSpend(rootDir, 'capped', 60, { env });
    assert.equal(first.allowed, true);
    recordUnattendedSpend(rootDir, 'capped', 60, { env });

    const second = checkUnattendedSpend(rootDir, 'capped', 60, { env });
    assert.equal(second.allowed, false, 'projected 120 > cap 100 must be denied');
    assert.equal(second.reason, 'unattended-budget-exhausted');
    assert.equal(second.spent, 60);
  });

  it('check() does not mutate recorded consumption', () => {
    const rootDir = fakeRoot();
    const env = { CONSTRUCT_UNATTENDED_BUDGET_READONLY: '1000' };
    checkUnattendedSpend(rootDir, 'readonly', 500, { env });
    const result = checkUnattendedSpend(rootDir, 'readonly', 500, { env });
    assert.equal(result.spent, 0, 'check() must never record spend on its own');
  });
});

describe('recordUnattendedSpend durability', () => {
  it('spend recorded by one store instance is visible to a fresh instance (restart-safe)', () => {
    const rootDir = fakeRoot();
    const env = { CONSTRUCT_UNATTENDED_BUDGET_DURABLE: '1000' };
    recordUnattendedSpend(rootDir, 'durable', 250, { env });

    const result = checkUnattendedSpend(rootDir, 'durable', 1, { env });
    assert.equal(result.spent, 250);
  });
});

describe('unattendedSpendSummary', () => {
  it('surfaces today\'s recorded capabilities with spend and cap', () => {
    const rootDir = fakeRoot();
    const env = { CONSTRUCT_UNATTENDED_BUDGET_SURFACED: '2000' };
    recordUnattendedSpend(rootDir, 'surfaced', 400, { env });

    const summary = unattendedSpendSummary(rootDir, { env });
    const row = summary.find((r) => r.capability === 'surfaced');
    assert.ok(row, 'expected a row for the "surfaced" capability');
    assert.equal(row.tokensSpent, 400);
    assert.equal(row.cap, 2000);
  });

  it('returns an empty list when nothing has spent today', () => {
    const rootDir = fakeRoot();
    const summary = unattendedSpendSummary(rootDir, { env: {} });
    assert.deepEqual(summary, []);
  });
});
