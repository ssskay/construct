/**
 * tests/mcp/approval-flow.test.mjs — LMCP-I2 durable awaiting_approval state.
 *
 * Verifies that when the broker's policy returns approvalRequired, a durable
 * approval record is created and the broker returns a structured
 * `{ status: 'awaiting_approval' }` response instead of throwing. Also
 * verifies approve/deny/expire flows and JSONL persistence.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Broker, ApprovalRequired } from '../../lib/mcp/broker.mjs';
import { ApprovalQueue } from '../../lib/embed/approval-queue.mjs';
import { pinDoctorRoot } from '../helpers/doctor-root.mjs';

// The broker's default auditRecorder appends to the audit trail under
// CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs); pinned to a tmpdir so brokered
// calls in the suite never write the real user's audit chain.

const doctorPin = pinDoctorRoot('cx-approval-doctor-');
after(() => doctorPin.restore());

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-approval-'));
  tmpDirs.push(dir);
  return dir;
}

function approvalPolicy() {
  return () => ({ allowed: true, reason: 'needs approval', approvalRequired: true, source: 'test' });
}

function allowingPolicy() {
  return () => ({ allowed: true, reason: 'ok', approvalRequired: false, source: 'test' });
}

function denyingPolicy() {
  return () => ({ allowed: false, reason: 'denied by policy', approvalRequired: false, source: 'test' });
}

describe('ApprovalQueue — A6 schema and basic operations', () => {
  it('enqueue creates a record with the full A6 schema', () => {
    const queue = new ApprovalQueue();
    const record = queue.enqueue({
      tool: 'fs',
      args: { path: '/tmp/test' },
      surface: 'test',
      requestedBy: { role: 'engineer' },
    });

    assert.ok(record.approvalId, 'must have approvalId');
    assert.ok(record.approvalId.startsWith('appr-'), 'approvalId must start with appr-');
    assert.equal(record.toolCall.tool, 'fs');
    assert.deepEqual(record.toolCall.args, { path: '/tmp/test' });
    assert.equal(record.toolCall.surface, 'test');
    assert.ok(record.toolCall.argsHash, 'must have argsHash');
    assert.equal(record.state, 'awaiting_approval');
    assert.equal(record.decidedAt, null);
    assert.equal(record.decidedBy, null);
    assert.equal(record.reason, null);
    assert.ok(record.resumeToken, 'must have resumeToken');
    assert.ok(record.expiresAt, 'must have expiresAt');
    assert.ok(record.requestedAt, 'must have requestedAt');
    assert.equal(record.requestedBy.role, 'engineer');
  });

  it('getById returns the correct record', () => {
    const queue = new ApprovalQueue();
    const record = queue.enqueue({ tool: 'fs', args: { path: 'x' }, surface: 'test' });
    const found = queue.getById(record.approvalId);
    assert.ok(found);
    assert.equal(found.approvalId, record.approvalId);
  });

  it('getPending returns only awaiting_approval records', () => {
    const queue = new ApprovalQueue();
    queue.enqueue({ tool: 'fs', args: { a: 1 }, surface: 'test' });
    const r2 = queue.enqueue({ tool: 'git', args: { b: 2 }, surface: 'test' });
    queue.approve(r2.approvalId);

    const pending = queue.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolCall.tool, 'fs');
  });

  it('getByResumeToken finds records by resume token', () => {
    const queue = new ApprovalQueue();
    const record = queue.enqueue({ tool: 'fs', args: { path: '/x' }, surface: 'test' });
    const found = queue.getByResumeToken(record.resumeToken);
    assert.ok(found);
    assert.equal(found.approvalId, record.approvalId);
  });

  it('enqueue dedup returns same record for identical tool call', () => {
    const queue = new ApprovalQueue();
    const r1 = queue.enqueue({ tool: 'fs', args: { path: '/dup' }, surface: 'test' });
    const r2 = queue.enqueue({ tool: 'fs', args: { path: '/dup' }, surface: 'test' });
    assert.equal(r1.approvalId, r2.approvalId, 'duplicate call must return same record');
  });

  it('enqueue creates separate records for different tool calls', () => {
    const queue = new ApprovalQueue();
    const r1 = queue.enqueue({ tool: 'fs', args: { path: '/a' }, surface: 'test' });
    const r2 = queue.enqueue({ tool: 'git', args: { path: '/a' }, surface: 'test' });
    assert.notEqual(r1.approvalId, r2.approvalId);
  });
});

describe('ApprovalQueue — approve / deny / expire', () => {
  it('approve transitions state and captures decidedAt', () => {
    const queue = new ApprovalQueue();
    const record = queue.enqueue({ tool: 'fs', args: {}, surface: 'test' });
    const resolved = queue.approve(record.approvalId, {
      decidedBy: { role: 'security' },
      reason: 'looks good',
    });
    assert.equal(resolved.state, 'approved');
    assert.ok(resolved.decidedAt);
    assert.equal(resolved.decidedBy.role, 'security');
    assert.equal(resolved.reason, 'looks good');
  });

  it('deny transitions state and captures reason', () => {
    const queue = new ApprovalQueue();
    const record = queue.enqueue({ tool: 'fs', args: {}, surface: 'test' });
    const resolved = queue.deny(record.approvalId, {
      decidedBy: { role: 'security' },
      reason: 'unsafe operation',
    });
    assert.equal(resolved.state, 'denied');
    assert.equal(resolved.reason, 'unsafe operation');
  });

  it('approve on non-existent record throws', () => {
    const queue = new ApprovalQueue();
    assert.throws(() => queue.approve('nonexistent'), /not found/);
  });

  it('double-approve throws', () => {
    const queue = new ApprovalQueue();
    const record = queue.enqueue({ tool: 'fs', args: {}, surface: 'test' });
    queue.approve(record.approvalId);
    assert.throws(() => queue.approve(record.approvalId), /already/);
  });

  it('expireStale marks past-expiry records as expired', () => {
    const queue = new ApprovalQueue({ timeoutMs: -1_000_000 });
    queue.enqueue({ tool: 'fs', args: {}, surface: 'test' });
    const expired = queue.expireStale();
    assert.equal(expired.length, 1);
    assert.equal(expired[0].state, 'expired');

    const pending = queue.getPending();
    assert.equal(pending.length, 0);
  });
});

describe('ApprovalQueue — JSONL persistence', () => {
  it('records survive load/save round-trip via JSONL', () => {
    const rootDir = fakeRoot();
    const persistPath = path.join(rootDir, '.cx', 'approvals', 'queue.jsonl');

    const q1 = new ApprovalQueue({ persistPath });
    const r1 = q1.enqueue({ tool: 'fs', args: { path: '/persist' }, surface: 'test' });
    q1.approve(r1.approvalId, { decidedBy: { role: 'sec' } });

    // New queue instance loads from disk
    const q2 = new ApprovalQueue({ persistPath });
    const loaded = q2.getById(r1.approvalId);
    assert.ok(loaded, 'record must survive reload');
    assert.equal(loaded.state, 'approved');
    assert.equal(loaded.decidedBy.role, 'sec');

    // File must exist and contain valid JSONL
    assert.ok(fs.existsSync(persistPath));
    const raw = fs.readFileSync(persistPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'JSONL must have at least one line');
  });

  it('resolvePersistPath returns team path for team mode', () => {
    const rootDir = '/some/project';
    const p = ApprovalQueue.resolvePersistPath(rootDir, 'team');
    assert.ok(p.endsWith(path.join('.cx', 'approvals', 'queue.jsonl')));
    assert.ok(p.startsWith('/some/project'));
  });

  it('resolvePersistPath returns doctor root path for solo mode', () => {
    const p = ApprovalQueue.resolvePersistPath('/tmp', 'solo');
    assert.ok(p.endsWith(path.join('approvals', 'queue.jsonl')), p);
  });
});

describe('Broker — awaiting_approval flow (no throw)', () => {
  it('approvalRequired returns awaiting_approval instead of throwing', async () => {
    const rootDir = fakeRoot();
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {}, approvalQueue: queue });

    const result = await broker.invoke({
      role: 'engineer', tool: 'fs', action: 'write', toolArgs: { path: '/x' },
      execute: async () => 'should not run',
    });
    assert.equal(result.status, 'awaiting_approval');
    assert.ok(result.approvalId);
    assert.ok(result.resumeToken);
    assert.ok(result.expiresAt);
  });

  it('ApprovalRequired class still exists for backward compat', () => {
    const err = new ApprovalRequired({ reason: 'test' });
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ApprovalRequired');
  });

  it('duplicate call returns same awaiting_approval id', async () => {
    const rootDir = fakeRoot();
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {}, approvalQueue: queue });

    const r1 = await broker.invoke({
      role: 'engineer', tool: 'git', action: 'push', toolArgs: { branch: 'main' },
      execute: async () => 'noop',
    });
    const r2 = await broker.invoke({
      role: 'engineer', tool: 'git', action: 'push', toolArgs: { branch: 'main' },
      execute: async () => 'noop',
    });
    assert.equal(r1.status, 'awaiting_approval');
    assert.equal(r2.status, 'awaiting_approval');
    assert.equal(r1.approvalId, r2.approvalId, 'duplicate call must return same approvalId');
  });

  it('approve then retry executes the tool', async () => {
    const rootDir = fakeRoot();
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {}, approvalQueue: queue });

    // First call: awaiting_approval
    const r1 = await broker.invoke({
      role: 'engineer', tool: 'deploy', action: 'deploy', toolArgs: { env: 'prod' },
      execute: async () => 'deployed!',
    });
    assert.equal(r1.status, 'awaiting_approval');

    // Approve via queue
    queue.approve(r1.approvalId, { decidedBy: { role: 'security' } });

    // Retry with same args: should execute
    const r2 = await broker.invoke({
      role: 'engineer', tool: 'deploy', action: 'deploy', toolArgs: { env: 'prod' },
      execute: async () => 'deployed!',
    });
    assert.equal(r2.result, 'deployed!');
    assert.ok(r2.decision);
  });

  it('deny returns denied status', async () => {
    const rootDir = fakeRoot();
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {}, approvalQueue: queue });

    const r1 = await broker.invoke({
      role: 'engineer', tool: 'delete', action: 'delete', toolArgs: { id: 42 },
      execute: async () => 'nope',
    });
    assert.equal(r1.status, 'awaiting_approval');

    queue.deny(r1.approvalId, { decidedBy: { role: 'security' }, reason: 'too risky' });

    const r2 = await broker.invoke({
      role: 'engineer', tool: 'delete', action: 'delete', toolArgs: { id: 42 },
      execute: async () => 'nope',
    });
    assert.equal(r2.status, 'denied');
    assert.equal(r2.reason, 'too risky');
  });

  it('expired record returns expired status', async () => {
    const rootDir = fakeRoot();
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl'), timeoutMs: 1 });
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {}, approvalQueue: queue });

    const r1 = await broker.invoke({
      role: 'engineer', tool: 'secret', action: 'read', toolArgs: { key: 'x' },
      execute: async () => 'noop',
    });
    assert.equal(r1.status, 'awaiting_approval');

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 5));

    queue.expireStale();

    const r2 = await broker.invoke({
      role: 'engineer', tool: 'secret', action: 'read', toolArgs: { key: 'x' },
      execute: async () => 'noop',
    });
    assert.equal(r2.status, 'expired');
  });

  it('resumeToken param bypasses argsHash dedup', async () => {
    const rootDir = fakeRoot();
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {}, approvalQueue: queue });

    const r1 = await broker.invoke({
      role: 'engineer', tool: 'fs', action: 'write', toolArgs: { path: '/resume' },
      execute: async () => 'noop',
    });

    queue.approve(r1.approvalId, { decidedBy: { role: 'sec' } });

    // Pass explicit resumeToken
    const r2 = await broker.invoke({
      role: 'engineer', tool: 'fs', action: 'write',
      resumeToken: r1.resumeToken,
      execute: async () => 'resumed!',
    });
    assert.equal(r2.result, 'resumed!');
  });

  it('broker without approvalQueue still throws ApprovalRequired', async () => {
    const rootDir = fakeRoot();
    const broker = new Broker({ rootDir, policy: approvalPolicy(), emit: () => {} });

    await assert.rejects(
      () => broker.invoke({ role: 'engineer', tool: 'fs', action: 'write', execute: async () => 'x' }),
      (err) => err instanceof ApprovalRequired,
    );
  });
});

describe('ApprovalQueue — hashToolCall determinism', () => {
  it('same tool + args produces same hash', () => {
    const h1 = ApprovalQueue.hashToolCall('fs', { path: '/a', recursive: true });
    const h2 = ApprovalQueue.hashToolCall('fs', { recursive: true, path: '/a' });
    assert.equal(h1, h2, 'order-independent equality');
  });

  it('different args produce different hashes', () => {
    const h1 = ApprovalQueue.hashToolCall('fs', { path: '/a' });
    const h2 = ApprovalQueue.hashToolCall('fs', { path: '/b' });
    assert.notEqual(h1, h2);
  });
});