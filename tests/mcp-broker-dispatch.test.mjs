/**
 * tests/mcp-broker-dispatch.test.mjs — unit tests for broker-gated dispatch in
 * the CallToolRequestSchema handler.
 *
 * Verifies: solo mode calls dispatchToolByName directly; team/enterprise mode
 * routes through Broker.invoke(); a broker denial prevents the underlying
 * dispatch from running.
 */

import { describe, it, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { Broker, PolicyDenied, isBrokered } from '../lib/mcp/broker.mjs';
import { pinDoctorRoot } from './helpers/doctor-root.mjs';

// The broker's default auditRecorder appends to the audit trail under
// CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs); pinned to a tmpdir so brokered
// calls in the suite never write the real user's audit chain.

const doctorPin = pinDoctorRoot('cx-broker-dispatch-doctor-');
after(() => doctorPin.restore());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBroker({ allowed = true, approvalRequired = false } = {}) {
  const decision = { allowed, approvalRequired, reason: allowed ? 'policy ok' : 'denied by policy', source: 'test' };
  return new Broker({
    rootDir: '/tmp/test-root',
    policy: () => decision,
    emit: () => {},
  });
}

async function simulateDispatch({ env, broker, dispatchFn }) {
  // Mirrors the dispatch block in server.mjs CallToolRequestSchema handler.
  const auditedTool = 'some_tool';
  const name = 'some_tool';
  const args = {};

  let result;
  try {
    if (isBrokered(env)) {
      const brokered = await broker.invoke({
        role: env.CONSTRUCT_ROLE || 'member',
        tool: auditedTool,
        action: auditedTool,
        execute: () => dispatchFn(name, args),
      });
      result = brokered.result;
    } else {
      result = await dispatchFn(name, args);
    }
  } catch (err) {
    result = { error: err.message ?? String(err) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('broker dispatch routing', () => {
  it('solo mode: calls dispatchToolByName directly, no broker', async () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'solo' };
    let directCalled = false;
    const dispatch = async () => { directCalled = true; return { ok: true }; };

    const result = await simulateDispatch({ env, broker: null, dispatchFn: dispatch });
    assert.equal(directCalled, true, 'dispatch must be called directly in solo mode');
    assert.deepEqual(result, { ok: true });
  });

  it('team mode + broker deny: dispatchToolByName is NOT called and result contains error', async () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'team' };
    let dispatchCalled = false;
    const dispatch = async () => { dispatchCalled = true; return { ok: true }; };
    const broker = makeBroker({ allowed: false });

    const result = await simulateDispatch({ env, broker, dispatchFn: dispatch });
    assert.equal(dispatchCalled, false, 'dispatch must NOT be called when broker denies');
    assert.ok(result && typeof result.error === 'string', 'denied result must have error string');
    assert.ok(result.error.includes('policy denied'), `expected "policy denied" in error, got: ${result.error}`);
  });

  it('team mode + broker approve: dispatchToolByName IS called and result is returned', async () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'team' };
    let dispatchCalled = false;
    const dispatch = async () => { dispatchCalled = true; return { value: 42 }; };
    const broker = makeBroker({ allowed: true });

    const result = await simulateDispatch({ env, broker, dispatchFn: dispatch });
    assert.equal(dispatchCalled, true, 'dispatch must be called when broker approves');
    assert.deepEqual(result, { value: 42 });
  });

  it('enterprise mode + broker approve: dispatch is called', async () => {
    const env = { CONSTRUCT_DEPLOYMENT_MODE: 'enterprise' };
    let dispatchCalled = false;
    const dispatch = async () => { dispatchCalled = true; return { ok: true }; };
    const broker = makeBroker({ allowed: true });

    const result = await simulateDispatch({ env, broker, dispatchFn: dispatch });
    assert.equal(dispatchCalled, true, 'dispatch must be called for enterprise mode when approved');
    assert.deepEqual(result, { ok: true });
  });

  it('CONSTRUCT_MCP_BROKER=on forces brokered path regardless of deployment mode', async () => {
    const env = { CONSTRUCT_MCP_BROKER: 'on', CONSTRUCT_DEPLOYMENT_MODE: 'solo' };
    let dispatchCalled = false;
    const dispatch = async () => { dispatchCalled = true; return { brokered: true }; };
    const broker = makeBroker({ allowed: true });

    const result = await simulateDispatch({ env, broker, dispatchFn: dispatch });
    assert.equal(dispatchCalled, true, 'dispatch must be called when broker approves via env override');
    assert.deepEqual(result, { brokered: true });
  });
});
