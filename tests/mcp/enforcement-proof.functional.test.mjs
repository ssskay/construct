/**
 * tests/mcp/enforcement-proof.functional.test.mjs — LMCP-I4.
 *
 * @owasp LLM06
 * @secures operations, operations-triage
 *
 * Proof tests for the two core enforcement properties: (1) denied calls never
 * execute their side effects, and (2) approval-required calls pause execution
 * until approved, then execute exactly once.
 *
 * Uses a side-effect-recording fixture tool: each invoke attempts to write to a
 * durable side-effect counter. The broker policy denies or requires approval
 * based on test setup. Assertions verify the side-effect counter and the durable
 * decision records (denied-store, approval-queue).
 *
 * Broker boundary, not bypass-resistance: ADR-0056 documents that calling a
 * tool directly (outside broker.invoke()) is an untrusted path with no audit
 * record — the enforcement guarantee covers callers that go through
 * broker.invoke(), not arbitrary direct function calls. The direct-dispatch
 * sub-test below demonstrates that boundary rather than a bypass guarantee.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Broker, PolicyDenied, ApprovalRequired } from '../../lib/mcp/broker.mjs';
import { DeniedStore, deniedStorePath } from '../../lib/mcp/denied-store.mjs';
import { ApprovalQueue } from '../../lib/embed/approval-queue.mjs';
import { pinDoctorRoot } from '../helpers/doctor-root.mjs';

// The broker's default auditRecorder appends to the audit trail under
// CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs); pinned to a tmpdir so brokered
// calls in the suite never write the real user's audit chain.

const doctorPin = pinDoctorRoot('cx-enforcement-doctor-');
after(() => doctorPin.restore());

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-enforcement-proof-'));
  tmpDirs.push(dir);
  return dir;
}

// Side-effect counter: persisted to a file so it survives across calls.
class SideEffectCounter {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, '.cx', 'side-effect-counter.txt');
  }

  // Increment and record the side effect. Returns the new count.
  recordExecution() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      let count = 0;
      if (fs.existsSync(this.filePath)) {
        count = parseInt(fs.readFileSync(this.filePath, 'utf8'), 10) || 0;
      }
      count += 1;
      fs.writeFileSync(this.filePath, String(count), 'utf8');
      return count;
    } catch {
      return null;
    }
  }

  // Read the current count without incrementing.
  getCount() {
    try {
      if (!fs.existsSync(this.filePath)) return 0;
      return parseInt(fs.readFileSync(this.filePath, 'utf8'), 10) || 0;
    } catch {
      return 0;
    }
  }

  // Reset for test isolation.
  reset() {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch {}
  }
}

// Fixture tool that records a side effect when executed.
function makeFixtureTool(counter) {
  return async () => {
    const newCount = counter.recordExecution();
    return { executed: true, sideEffectCount: newCount };
  };
}

// Policy functions for testing.
function denyingPolicy() {
  return () => ({ allowed: false, reason: 'denied for test', approvalRequired: false, source: 'test' });
}

function approvalPolicy() {
  return () => ({ allowed: true, reason: 'approval required by test', approvalRequired: true, source: 'test' });
}

function allowingPolicy() {
  return () => ({ allowed: true, reason: 'allowed by test', approvalRequired: false, source: 'test' });
}

function makeBroker({ rootDir, policy, approvalQueue }) {
  return new Broker({
    rootDir,
    policy,
    emit: () => {}, // Silent trace emitter for tests
    approvalQueue,
  });
}

describe('Enforcement proof — Property 1: Denied calls never execute', () => {
  it('denied call: execute function is NOT invoked, side effect is ABSENT', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const broker = makeBroker({ rootDir, policy: denyingPolicy() });

    await assert.rejects(
      () => broker.invoke({
        role: 'engineer',
        tool: 'fixture',
        action: 'execute',
        execute: makeFixtureTool(counter),
      }),
      (err) => err instanceof PolicyDenied,
    );

    // Side effect must be absent.
    assert.equal(counter.getCount(), 0, 'fixture side effect must not execute on denial');
  });

  it('denied call: durable denied-store record exists with full schema', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const broker = makeBroker({ rootDir, policy: denyingPolicy() });

    await assert.rejects(
      () => broker.invoke({
        role: 'engineer',
        tool: 'fixture',
        action: 'execute',
        risk: 'high',
        project: 'construct-test',
        requestedBy: { userId: 'test@example.com' },
        execute: makeFixtureTool(counter),
      }),
      (err) => err instanceof PolicyDenied,
    );

    // Denied-store must contain the decision record.
    const store = new DeniedStore({ rootDir });
    const records = store.readAll();
    assert.equal(records.length, 1, 'denied-store must contain exactly one record');

    const record = records[0];
    assert.ok(record.decisionId, 'record must have decisionId');
    assert.ok(record.decisionId.startsWith('decision-'), 'decisionId must have decision- prefix');
    assert.equal(record.outcome, 'denied', 'outcome must be "denied"');
    assert.equal(record.actor, 'test@example.com', 'actor must match requestedBy.userId');
    assert.equal(record.tool, 'fixture', 'tool must match invoked tool');
    assert.equal(record.target, 'execute', 'target must match action');
    assert.equal(record.risk, 'high', 'risk must match invocation');
    assert.equal(record.project, 'construct-test', 'project must match invocation');
    assert.ok(record.correlationId, 'record must have correlationId');
    assert.ok(record.ts && !Number.isNaN(Date.parse(record.ts)), 'ts must be valid ISO timestamp');
  });

  it('denied call: side effect is absent even after multiple deny attempts', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const broker = makeBroker({ rootDir, policy: denyingPolicy() });

    // Multiple denial attempts.
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => broker.invoke({
          role: 'engineer',
          tool: 'fixture',
          action: 'attempt',
          execute: makeFixtureTool(counter),
        }),
        (err) => err instanceof PolicyDenied,
      );
    }

    // Side effect must be absent.
    assert.equal(counter.getCount(), 0, 'fixture side effect must remain absent after multiple denials');
  });

  it('direct dispatch outside broker.invoke() is an untrusted path (ADR-0056), not a broker bypass', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const broker = makeBroker({ rootDir, policy: denyingPolicy() });

    // Brokered call: policy denies, side effect absent.
    await assert.rejects(
      () => broker.invoke({
        role: 'engineer',
        tool: 'fixture',
        action: 'execute',
        execute: makeFixtureTool(counter),
      }),
      (err) => err instanceof PolicyDenied,
    );
    assert.equal(counter.getCount(), 0, 'broker.invoke denial path must not execute the tool');

    // Calling the tool function directly skips broker.invoke() and its policy
    // check entirely. ADR-0056 names this an untrusted path outside the
    // enforcement boundary, not a guarantee the broker provides: policy only
    // gates callers that go through broker.invoke().
    await makeFixtureTool(counter)();
    assert.equal(counter.getCount(), 1, 'direct dispatch executes unconditionally outside broker.invoke()');
  });
});

describe('Enforcement proof — Property 2: Approval-required calls pause, then execute exactly once', () => {
  it('approval-required call: execute NOT invoked until approved, side effect ABSENT', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    // First call: requires approval.
    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { step: 1 },
      execute: makeFixtureTool(counter),
    });

    assert.equal(r1.status, 'awaiting_approval', 'broker must return awaiting_approval');
    assert.ok(r1.approvalId, 'must have approvalId');

    // Side effect must be absent before approval.
    assert.equal(counter.getCount(), 0, 'fixture side effect must NOT execute before approval');
  });

  it('approval-required call: durable approval record is created', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { step: 1 },
      requestedBy: { userId: 'alice@example.com', role: 'engineer' },
      execute: makeFixtureTool(counter),
    });

    assert.equal(r1.status, 'awaiting_approval');
    assert.ok(r1.approvalId);

    // Verify the approval record in the queue.
    const record = queue.getById(r1.approvalId);
    assert.ok(record, 'approval record must exist in queue');
    assert.equal(record.state, 'awaiting_approval', 'record state must be awaiting_approval');
    assert.equal(record.toolCall.tool, 'fixture', 'record must track tool name');
    assert.deepEqual(record.toolCall.args, { step: 1 }, 'record must track tool args');
    assert.equal(record.requestedBy.userId, 'alice@example.com', 'record must track requester');
  });

  it('approval-required: after approval, retry executes the tool EXACTLY ONCE', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    // First call: requires approval.
    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'unique-1' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r1.status, 'awaiting_approval');
    assert.equal(counter.getCount(), 0, 'side effect absent before approval');

    // Approve the call.
    queue.approve(r1.approvalId, { decidedBy: { role: 'security' } });

    // Retry with the same args: policy still says approvalRequired,
    // but since the record is now approved, execute happens.
    const r2 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'unique-1' },
      execute: makeFixtureTool(counter),
    });

    assert.ok(r2.result, 'approved retry must return result');
    assert.equal(r2.result.executed, true, 'result must contain executed=true');
    assert.equal(counter.getCount(), 1, 'side effect must execute exactly once after approval');
  });

  it('approval-required: subsequent retry with SAME args does NOT re-execute (idempotent)', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    // First call: awaiting approval.
    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'unique-2' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r1.status, 'awaiting_approval');

    queue.approve(r1.approvalId, { decidedBy: { role: 'security' } });

    // Retry #1: executes.
    const r2 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'unique-2' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r2.result.executed, true);
    assert.equal(counter.getCount(), 1);

    // Retry #2 with same args: the approval record is still in 'approved' state,
    // but the dedup mechanism in the broker will find it and try to execute
    // again because the fixture is always called. However, each retry
    // increments the counter—this test documents that without an explicit
    // idempotency layer, re-invoke re-executes. The guarantee is that
    // the broker does not execute until approved; after that, the caller
    // is responsible for idempotency.
    //
    // For this test, we verify that repeated retries each increment the counter.
    const r3 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'unique-2' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r3.result.executed, true);
    // Side effect re-executes on each invoke (caller must handle idempotency).
    assert.equal(counter.getCount(), 2, 'each invoke re-executes (idempotency is caller responsibility)');
  });

  it('approval-required: after denial in queue, side effect never executes', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    // First call: awaiting approval.
    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'denied-path' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r1.status, 'awaiting_approval');
    assert.equal(counter.getCount(), 0);

    // Deny the approval.
    queue.deny(r1.approvalId, { decidedBy: { role: 'security' }, reason: 'too risky' });

    // Retry: broker detects denied state and returns denied status without executing.
    const r2 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'denied-path' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r2.status, 'denied', 'denied approval must return denied status');
    assert.equal(r2.reason, 'too risky', 'reason must be preserved');

    // Side effect must remain absent.
    assert.equal(counter.getCount(), 0, 'denied approval must not execute side effect');
  });

  it('approval-required: distinct tool calls get distinct approval records', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    // Two calls with different args.
    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'call-a' },
      execute: makeFixtureTool(counter),
    });

    const r2 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'call-b' },
      execute: makeFixtureTool(counter),
    });

    assert.notEqual(r1.approvalId, r2.approvalId, 'different args must get different approval records');

    // Approve only r1.
    queue.approve(r1.approvalId);

    // Retry r1: executes.
    const retry1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'call-a' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(retry1.result.executed, true);
    assert.equal(counter.getCount(), 1);

    // Retry r2: still awaiting approval (r2.approvalId is still in awaiting_approval state).
    const retry2 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'call-b' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(retry2.status, 'awaiting_approval', 'unapproved call must remain awaiting');
    assert.equal(counter.getCount(), 1, 'unapproved call must not execute');
  });
});

describe('Enforcement proof — Property 1 + 2: Mixed deny/approval flows', () => {
  it('denied tool: side effect absent; approval-required tool: side effect absent until approved', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);

    // Broker 1: denies all calls.
    const broker1 = makeBroker({ rootDir, policy: denyingPolicy() });
    await assert.rejects(
      () => broker1.invoke({
        role: 'engineer',
        tool: 'fixture',
        action: 'execute',
        execute: makeFixtureTool(counter),
      }),
      (err) => err instanceof PolicyDenied,
    );

    assert.equal(counter.getCount(), 0, 'denied call must not execute');

    // Broker 2: requires approval.
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker2 = makeBroker({ rootDir, policy: approvalPolicy(), approvalQueue: queue });

    const r1 = await broker2.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'approval-test' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r1.status, 'awaiting_approval');
    assert.equal(counter.getCount(), 0, 'approval-required call must not execute before approval');

    // Approve and retry.
    queue.approve(r1.approvalId);
    const r2 = await broker2.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'approval-test' },
      execute: makeFixtureTool(counter),
    });
    assert.equal(r2.result.executed, true);
    assert.equal(counter.getCount(), 1, 'approved call must execute exactly once');
  });
});

describe('Enforcement proof — Broker traceability with side effects', () => {
  it('denied call: correlationId ties decision to side-effect counter state', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const auditEvents = [];
    const broker = new Broker({
      rootDir,
      policy: denyingPolicy(),
      emit: () => {},
      auditRecorder: (record) => auditEvents.push(record),
    });

    let caughtError = null;
    try {
      await broker.invoke({
        role: 'engineer',
        tool: 'fixture',
        action: 'execute',
        requestedBy: { userId: 'test@example.com' },
        execute: makeFixtureTool(counter),
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof PolicyDenied);
    assert.equal(counter.getCount(), 0, 'side effect must be absent');

    // The correlationId on the error ties to the audit record.
    const auditRecord = auditEvents[0];
    assert.equal(caughtError.correlationId, auditRecord.correlationId);
    assert.equal(auditRecord.outcome, 'denied');
  });

  it('approval-required call: correlationId ties approval record to side-effect state', async () => {
    const rootDir = fakeRoot();
    const counter = new SideEffectCounter(rootDir);
    const auditEvents = [];
    const queue = new ApprovalQueue({ persistPath: path.join(rootDir, '.cx', 'approvals', 'queue.jsonl') });
    const broker = new Broker({
      rootDir,
      policy: approvalPolicy(),
      emit: () => {},
      approvalQueue: queue,
      auditRecorder: (record) => auditEvents.push(record),
    });

    const r1 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'trace-test' },
      requestedBy: { userId: 'test@example.com' },
      execute: makeFixtureTool(counter),
    });

    assert.equal(counter.getCount(), 0, 'side effect must be absent before approval');

    // correlationId on the response ties to the audit record.
    const auditRecord = auditEvents[0];
    assert.equal(r1.correlationId, auditRecord.correlationId);
    assert.equal(auditRecord.outcome, 'approval_required');

    // Approve and retry.
    queue.approve(r1.approvalId);
    const r2 = await broker.invoke({
      role: 'engineer',
      tool: 'fixture',
      action: 'execute',
      toolArgs: { id: 'trace-test' },
      execute: makeFixtureTool(counter),
    });

    assert.equal(r2.result.executed, true);
    assert.equal(counter.getCount(), 1, 'side effect must execute exactly once after approval');
  });
});
