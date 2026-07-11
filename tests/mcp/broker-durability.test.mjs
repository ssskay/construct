/**
 * tests/mcp/broker-durability.test.mjs — LMCP-I1.
 *
 * Verifies that the Broker's rate-limit state persists across instances
 * pointing at the same rootDir via BrokerStore file-backed storage.
 *
 * Scenarios:
 *   1. A broker that hits its rate limit writes state to disk.
 *   2. A second broker instance pointing at the same rootDir loads that
 *      state and the rate limit is still in effect.
 *   3. A broker pointing at a different rootDir starts with a clean slate.
 *   4. BrokerStore.load/save round-trips correctly.
 *   5. Solo-mode works with file-backed BrokerStore state.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Broker, BrokerStore, RateLimited } from '../../lib/mcp/broker.mjs';
import { pinDoctorRoot } from '../helpers/doctor-root.mjs';

// The broker's default auditRecorder appends to the audit trail under
// CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs); pinned to a tmpdir so brokered
// calls in the suite never write the real user's audit chain.

const doctorPin = pinDoctorRoot('cx-durability-doctor-');
after(() => doctorPin.restore());

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-broker-dur-'));
  tmpDirs.push(dir);
  return dir;
}

function allowingPolicy() {
  return () => ({ allowed: true, reason: 'ok', approvalRequired: false, source: 'test' });
}

describe('BrokerStore', () => {
  it('load/save round-trips rate-limit state', () => {
    const rootDir = fakeRoot();
    const storePath = path.join(rootDir, '.cx', 'broker-state.json');

    const store1 = new BrokerStore();
    store1.incrementRateLimitState('engineer', 'fs', 60_000);
    store1.incrementRateLimitState('engineer', 'fs', 60_000);
    store1.save(storePath);

    const store2 = new BrokerStore();
    store2.load(storePath);
    const state = store2.getRateLimitState('engineer', 'fs', 60_000);
    assert.equal(state.length, 2, `Expected 2 entries after load, got ${state.length}`);
  });

  it('load is a no-op when file does not exist', () => {
    const store = new BrokerStore();
    // Should not throw
    store.load('/tmp/cx-nonexistent-broker-state-zzz.json');
    const state = store.getRateLimitState('engineer', 'fs', 60_000);
    assert.equal(state.length, 0);
  });

  it('getRateLimitState trims stale entries', () => {
    const store = new BrokerStore();
    // Inject a past timestamp directly
    const pastTs = Date.now() - 120_000; // 2 minutes ago
    store._data['engineer::fs'] = [pastTs];
    const state = store.getRateLimitState('engineer', 'fs', 60_000); // 1 minute window
    assert.equal(state.length, 0, 'Stale entry must be trimmed');
  });
});

describe('Broker rate-limit durability', () => {
  it('rate limit state persists across broker instances pointing at same rootDir', async () => {
    const rootDir = fakeRoot();
    const policy = allowingPolicy();
    const emit = () => {};

    // First broker with budget=2; exhaust the rate limit
    const broker1 = new Broker({ rootDir, policy, emit, rateBudget: 2, rateWindowMs: 60_000 });
    await broker1.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 1 });
    await broker1.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 2 });

    // Third call from broker1 must be rate-limited
    await assert.rejects(
      () => broker1.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 3 }),
      (err) => err instanceof RateLimited,
    );

    // Second broker instance pointing at the same rootDir — must load persisted state
    const broker2 = new Broker({ rootDir, policy, emit, rateBudget: 2, rateWindowMs: 60_000 });

    // Rate limit must still be in effect on the new instance
    await assert.rejects(
      () => broker2.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 4 }),
      (err) => {
        assert.ok(err instanceof RateLimited, `Expected RateLimited, got ${err.constructor.name}: ${err.message}`);
        return true;
      },
    );
  });

  it('broker at a different rootDir starts with a clean slate', async () => {
    const rootDir1 = fakeRoot();
    const rootDir2 = fakeRoot();
    const policy = allowingPolicy();
    const emit = () => {};

    // Exhaust rate limit on rootDir1
    const broker1 = new Broker({ rootDir: rootDir1, policy, emit, rateBudget: 1, rateWindowMs: 60_000 });
    await broker1.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 1 });
    await assert.rejects(
      () => broker1.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 2 }),
      (err) => err instanceof RateLimited,
    );

    // Broker at rootDir2 must succeed — independent state
    const broker2 = new Broker({ rootDir: rootDir2, policy, emit, rateBudget: 1, rateWindowMs: 60_000 });
    const { result } = await broker2.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 'ok' });
    assert.equal(result, 'ok');
  });

  it('BrokerStore injected via constructor is used for rate decisions', async () => {
    const rootDir = fakeRoot();
    const policy = allowingPolicy();
    const emit = () => {};

    // Pre-seed a store as if two calls already happened
    const store = new BrokerStore();
    store.incrementRateLimitState('engineer', 'fs', 60_000);
    store.incrementRateLimitState('engineer', 'fs', 60_000);

    // Broker that receives the pre-seeded store directly must see the seeded state
    const broker = new Broker({ rootDir, policy, emit, rateBudget: 2, rateWindowMs: 60_000, store });
    await assert.rejects(
      () => broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 'x' }),
      (err) => err instanceof RateLimited,
    );
  });

  it('solo mode works with file-backed BrokerStore state', async () => {
    const rootDir = fakeRoot();
    const policy = allowingPolicy();
    const emit = () => {};

    const broker1 = new Broker({ rootDir, policy, emit, rateBudget: 3, rateWindowMs: 60_000 });
    await broker1.invoke({ role: 'member', tool: 'fs', action: 'read', execute: async () => 'a' });

    // State file must exist
    const storePath = path.join(rootDir, '.cx', 'broker-state.json');
    assert.ok(fs.existsSync(storePath), 'broker-state.json must be written after invoke');

    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.ok(Array.isArray(raw['member::fs']), 'State must contain member::fs timestamps');
    assert.equal(raw['member::fs'].length, 1);

    // New broker reads back the persisted count
    const broker2 = new Broker({ rootDir, policy, emit, rateBudget: 3, rateWindowMs: 60_000 });
    await broker2.invoke({ role: 'member', tool: 'fs', action: 'read', execute: async () => 'b' });
    await broker2.invoke({ role: 'member', tool: 'fs', action: 'read', execute: async () => 'c' });

    // Budget was 3, broker1 used 1, broker2 used 2 → total 3, next call must be rate-limited
    await assert.rejects(
      () => broker2.invoke({ role: 'member', tool: 'fs', action: 'read', execute: async () => 'd' }),
      (err) => err instanceof RateLimited,
    );
  });
});
