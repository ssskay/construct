/**
 * tests/functional/mcp-broker-enforcement.functional.test.mjs — functional tests
 * for broker enforcement at the module level.
 *
 * Imports real Broker + isBrokered. Runs the dispatch simulation (mirrors the
 * CallToolRequestSchema handler in lib/mcp/server.mjs) with controlled policy
 * functions and isolated tmpdir rootDirs. Does NOT duplicate the unit-level
 * routing tests in tests/mcp-broker-dispatch.test.mjs — those cover the
 * isBrokered/routing logic; these cover end-to-end broker behavior including
 * the audit trail (trace events) emitted per invocation.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Broker, isBrokered } from '../../lib/mcp/broker.mjs';
import { traceDir as resolveTraceDir } from '../../lib/worker/trace.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';
import { pinDoctorRoot } from '../helpers/doctor-root.mjs';

// Broker trace writes resolve through the machine-scoped state root
// (ADR-0066) via lib/worker/trace.mjs#traceDir, keyed off process.env.CX_HOME_OVERRIDE
// directly rather than any per-call env option, so CX_HOME_OVERRIDE is pinned
// for the whole file to keep them off the real developer machine's $HOME.
// The broker's default auditRecorder writes a second durable artifact — the
// audit-trail JSONL under CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs) — so
// that axis is pinned too; the deny/approve tests assert the records land
// under the pinned root, never the real ~/.local/state/construct.

const homeOverride = mkdtempSync(join(tmpdir(), 'cx-broker-enforcement-home-'));
const prevHomeOverride = process.env.CX_HOME_OVERRIDE;
process.env.CX_HOME_OVERRIDE = homeOverride;
const doctorPin = pinDoctorRoot('cx-broker-enforcement-doctor-');
after(() => {
  doctorPin.restore();
  try { rmTmpDir(homeOverride); } catch {}
  if (prevHomeOverride === undefined) delete process.env.CX_HOME_OVERRIDE;
  else process.env.CX_HOME_OVERRIDE = prevHomeOverride;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Read the audit-trail records the broker's default auditRecorder appended
// under the pinned doctor root.
function readAuditLines() {
  const file = join(doctorPin.root, 'audit-trail.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Collect all trace lines written for an isolated rootDir, resolved through
// the same machine-scoped state root the broker itself writes to.
function readTraceLines(root) {
  const dir = resolveTraceDir(root);
  if (!existsSync(dir)) return [];
  const shards = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const lines = [];
  for (const shard of shards) {
    const text = readFileSync(join(dir, shard), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

// Build a Broker with a canned policy function and a fresh isolated rootDir.
function makeBroker({ root, allowed = true, approvalRequired = false }) {
  const decision = {
    allowed,
    approvalRequired,
    reason: allowed ? 'approved by test policy' : 'denied by test policy',
    source: 'test-policy',
  };
  return new Broker({
    rootDir: root,
    // Real emitTraceEvent — writes to root/.cx/traces/ so we can verify the audit trail.
    policy: () => decision,
  });
}

// Simulate the dispatch block from lib/mcp/server.mjs CallToolRequestSchema handler.
async function runDispatch({ env, broker, executeFn }) {
  const toolName = 'agent_health';
  let result;
  try {
    if (isBrokered(env)) {
      const brokered = await broker.invoke({
        role: env.CONSTRUCT_ROLE || 'member',
        tool: toolName,
        action: toolName,
        execute: executeFn,
      });
      result = brokered.result;
    } else {
      result = await executeFn();
    }
  } catch (err) {
    result = { error: err.message ?? String(err) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('broker enforcement — deny', () => {
  it('policy deny: execute is NOT called and result contains policy error', async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'cx-broker-deny-'));
    try {
      const env = { CONSTRUCT_DEPLOYMENT_MODE: 'team' };
      const broker = makeBroker({ root: localRoot, allowed: false });

      let executeCalled = false;
      const execute = async () => { executeCalled = true; return { ok: true }; };

      const result = await runDispatch({ env, broker, executeFn: execute });

      assert.equal(executeCalled, false, 'execute must NOT be called when broker denies');
      assert.ok(result && typeof result.error === 'string', 'denied result must carry error string');
      assert.ok(
        result.error.includes('policy denied'),
        `expected "policy denied" in error message, got: ${result.error}`,
      );

      // Audit trail: broker emits tool.called even on denial (for observability).
      const traces = readTraceLines(localRoot);
      const toolCalled = traces.filter((e) => e.eventType === 'tool.called');
      assert.ok(toolCalled.length >= 1, 'broker must emit a tool.called trace event on denial');
      assert.equal(toolCalled[0].metadata.allowed, false, 'trace event must record allowed=false');
      assert.ok(
        toolCalled[0].metadata.reason.includes('denied'),
        `trace reason should mention "denied", got: ${toolCalled[0].metadata.reason}`,
      );

      // The default auditRecorder's durable record must land under the pinned
      // doctor root, never the real user state dir.
      const audits = readAuditLines().filter((r) => r.agent === 'mcp-broker' && r.outcome === 'denied');
      assert.ok(audits.length >= 1, 'broker must append a denied audit-trail record under the pinned doctor root');
      assert.equal(audits[0].source, 'test-policy');
    } finally {
      rmTmpDir(localRoot);
    }
  });
});

describe('broker enforcement — approve', () => {
  it('policy approve: execute IS called and result is returned', async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'cx-broker-approve-'));
    try {
      const env = { CONSTRUCT_DEPLOYMENT_MODE: 'team' };
      const broker = makeBroker({ root: localRoot, allowed: true });

      let executeCalled = false;
      const execute = async () => { executeCalled = true; return { answer: 42 }; };

      const result = await runDispatch({ env, broker, executeFn: execute });

      assert.equal(executeCalled, true, 'execute must be called when broker approves');
      assert.deepEqual(result, { answer: 42 }, 'approved result must be the execute return value');

      // Audit trail: tool.called event with allowed=true.
      const traces = readTraceLines(localRoot);
      const toolCalled = traces.filter((e) => e.eventType === 'tool.called');
      assert.ok(toolCalled.length >= 1, 'broker must emit a tool.called trace event on approval');
      assert.equal(toolCalled[0].metadata.allowed, true, 'trace event must record allowed=true');

      const audits = readAuditLines().filter((r) => r.agent === 'mcp-broker' && r.outcome === 'allowed');
      assert.ok(audits.length >= 1, 'broker must append an allowed audit-trail record under the pinned doctor root');
    } finally {
      rmTmpDir(localRoot);
    }
  });
});

describe('broker enforcement — isBrokered status for team env', () => {
  it('isBrokered returns true for CONSTRUCT_DEPLOYMENT_MODE=team', () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'team' };
    assert.equal(isBrokered(env), true, 'isBrokered must return true in team mode');
  });

  it('isBrokered returns true for CONSTRUCT_DEPLOYMENT_MODE=enterprise', () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'enterprise' };
    assert.equal(isBrokered(env), true, 'isBrokered must return true in enterprise mode');
  });

  it('isBrokered returns false for CONSTRUCT_DEPLOYMENT_MODE=solo', () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'solo' };
    assert.equal(isBrokered(env), false, 'isBrokered must return false in solo mode');
  });

  it('CONSTRUCT_MCP_BROKER=on overrides solo to brokered', () => {
    const env = { CONSTRUCT_MCP_BROKER: 'on', CONSTRUCT_DEPLOYMENT_MODE: 'solo' };
    assert.equal(isBrokered(env), true, 'CONSTRUCT_MCP_BROKER=on must force brokered path');
  });
});

describe('broker enforcement — solo bypass', () => {
  it('solo mode: execute is called directly without broker instantiation', async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'cx-broker-solo-'));
    try {
      const env = { CONSTRUCT_DEPLOYMENT_MODE: 'solo' };

      // broker is null — proves the dispatch path never touches the broker object.
      let executeCalled = false;
      const execute = async () => { executeCalled = true; return { solo: true }; };

      const result = await runDispatch({ env, broker: null, executeFn: execute });

      assert.equal(executeCalled, true, 'execute must be called directly in solo mode');
      assert.deepEqual(result, { solo: true }, 'solo result must be the raw execute return value');

      // No trace events — broker was never instantiated, so no tool.called events.
      const traces = readTraceLines(localRoot);
      const toolCalled = traces.filter((e) => e.eventType === 'tool.called');
      assert.equal(toolCalled.length, 0, 'solo mode must not emit broker tool.called trace events');
    } finally {
      rmTmpDir(localRoot);
    }
  });
});
