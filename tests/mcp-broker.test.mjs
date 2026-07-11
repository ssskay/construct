/**
 * tests/mcp-broker.test.mjs — MCP broker contract.
 *
 * Pins: every brokered call emits a tool.called trace event with the
 * policy decision; denied calls throw PolicyDenied (typed); approval-
 * required calls throw ApprovalRequired without invoking execute; rate
 * limiting throws RateLimited after the budget; the isBrokered helper
 * respects CONSTRUCT_MCP_BROKER override and the deployment mode.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Broker, PolicyDenied, ApprovalRequired, RateLimited, isBrokered } from '../lib/mcp/broker.mjs';
import { pinDoctorRoot } from './helpers/doctor-root.mjs';

// The broker's default auditRecorder appends to the audit trail under
// CONSTRUCT_DOCTOR_ROOT (lib/audit-trail.mjs); pinned to a tmpdir so brokered
// calls in the suite never write the real user's audit chain.

const doctorPin = pinDoctorRoot('cx-broker-doctor-');
after(() => doctorPin.restore());

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-broker-'));
  tmpDirs.push(dir);
  return dir;
}

function allowingPolicy() {
  return () => ({ allowed: true, reason: 'ok', approvalRequired: false, source: 'test' });
}

function denyingPolicy() {
  return () => ({ allowed: false, reason: 'denied for test', approvalRequired: false, source: 'test' });
}

function approvalPolicy() {
  return () => ({ allowed: true, reason: 'needs approval for test', approvalRequired: true, source: 'test' });
}

describe('Broker', () => {
  it('emits a tool.called trace event for every brokered call', async () => {
    const events = [];
    const broker = new Broker({ rootDir: fakeRoot(), policy: allowingPolicy(), emit: (e) => events.push(e) });
    const { result } = await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: () => 'ok' });
    assert.equal(result, 'ok');
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'tool.called');
    assert.equal(events[0].metadata.allowed, true);
    assert.equal(events[0].role, 'engineer');
  });

  it('throws PolicyDenied without invoking execute when the policy denies', async () => {
    let executed = false;
    const broker = new Broker({ rootDir: fakeRoot(), policy: denyingPolicy(), emit: () => {} });
    await assert.rejects(
      () => broker.invoke({ role: 'engineer', tool: 'github', action: 'push:main', execute: async () => { executed = true; } }),
      (err) => err instanceof PolicyDenied,
    );
    assert.equal(executed, false);
  });

  it('throws ApprovalRequired without invoking execute when approval is needed', async () => {
    let executed = false;
    const broker = new Broker({ rootDir: fakeRoot(), policy: approvalPolicy(), emit: () => {} });
    await assert.rejects(
      () => broker.invoke({ role: 'engineer', tool: 'github', action: 'create_pr', execute: async () => { executed = true; } }),
      (err) => err instanceof ApprovalRequired,
    );
    assert.equal(executed, false);
  });

  it('rate-limits per (role, tool) per window', async () => {
    const broker = new Broker({
      rootDir: fakeRoot(),
      policy: allowingPolicy(),
      emit: () => {},
      rateBudget: 2,
      rateWindowMs: 60_000,
    });
    await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 1 });
    await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 2 });
    await assert.rejects(
      () => broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => 3 }),
      (err) => err instanceof RateLimited,
    );
  });

  it('reports decision.source alongside the result for telemetry', async () => {
    const broker = new Broker({ rootDir: fakeRoot(), policy: allowingPolicy(), emit: () => {} });
    const { decision } = await broker.invoke({ role: 'engineer', tool: 'fs', action: 'read', execute: async () => null });
    assert.equal(decision.source, 'test');
  });
});

describe('isBrokered', () => {
  it('is off in solo mode by default', () => {
    assert.equal(isBrokered({ CONSTRUCT_DEPLOYMENT_MODE: 'solo' }), false);
    assert.equal(isBrokered({}), false);
  });

  it('is on in team and enterprise mode by default', () => {
    assert.equal(isBrokered({ CONSTRUCT_DEPLOYMENT_MODE: 'team' }), true);
    assert.equal(isBrokered({ CONSTRUCT_DEPLOYMENT_MODE: 'enterprise' }), true);
  });

  it('honors the CONSTRUCT_MCP_BROKER override', () => {
    assert.equal(isBrokered({ CONSTRUCT_DEPLOYMENT_MODE: 'solo', CONSTRUCT_MCP_BROKER: 'on' }), true);
    assert.equal(isBrokered({ CONSTRUCT_DEPLOYMENT_MODE: 'team', CONSTRUCT_MCP_BROKER: 'off' }), false);
  });
});
