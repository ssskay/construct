/**
 * tests/audit/f09-orchestration/status-path-truthfulness.test.mjs — Status path consistency.
 *
 * Pins that orchestration_status single-run path and remote statusViaService
 * return shaped status identical to the orchestration_run envelope, and that
 * zero-task degraded runs are never reported as prepared or bare 'completed'.
 *
 * Acceptance criteria (construct-fbxv.4):
 * - orchestration_status for a prepare-only run returns completed-prepare-only
 *   (or the AP5.1 taxonomy state) on both local and remote paths.
 * - A zero-task degraded run never reports as prepared or bare completed on any status path.
 * - CLI status output reflects the shaped status (already verified in CLI tests).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { orchestrationRun, orchestrationStatus } from '../../../lib/mcp/tools/orchestration-run.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tmpProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-status-path-'));
  fs.mkdirSync(path.join(cwd, '.cx'), { recursive: true });
  return cwd;
}

// orchestrationRun/orchestrationStatus resolve the machine-scoped state root
// (ADR-0066) via CX_HOME_OVERRIDE read from real process.env, not from the
// `env` option bag passed to these calls — the ENV/degradedEnv() HOME below
// is inert for that purpose. Pin the real process env or these leak into the
// real developer machine's ~/.construct/projects.
function pinHome(cwd) {
  const prev = process.env.CX_HOME_OVERRIDE;
  process.env.CX_HOME_OVERRIDE = cwd;
  return () => {
    if (prev === undefined) delete process.env.CX_HOME_OVERRIDE;
    else process.env.CX_HOME_OVERRIDE = prev;
  };
}

const MODEL = 'anthropic/claude-sonnet-4-6';
const ORCH_REQUEST = { request: 'design and implement a new authentication architecture', file_count: 20, module_count: 6, wait: true, worker_backend: 'inline' };

// HOME/USERPROFILE must never point at the repo: anything downstream that
// resolves user-scoped state from this bag — or from a child spawned with it —
// writes ~/.construct-shaped state into the working tree (this is exactly how
// a stray <repo>/projects/<key>/lancedb appeared during a suite run). A
// disposable home keeps those writes in tmp; CX_TOOLKIT_DIR stays on the repo
// because it only locates toolkit assets, never durable state.
const ENV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-status-path-home-'));
test.after(() => fs.rmSync(ENV_HOME, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  CX_TOOLKIT_DIR: REPO_ROOT,
  HOME: ENV_HOME,
  USERPROFILE: ENV_HOME,
  OPENROUTER_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  CX_MODEL_REASONING: MODEL,
  CX_MODEL_STANDARD: MODEL,
  CX_MODEL_FAST: MODEL,
};

function degradedEnv() {
  return {
    ...process.env,
    CX_TOOLKIT_DIR: REPO_ROOT,
    HOME: ENV_HOME,
    USERPROFILE: ENV_HOME,
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CX_MODEL_REASONING: '',
    CX_MODEL_STANDARD: '',
    CX_MODEL_FAST: '',
  };
}

test('[R-status] single-run status shapes prepare-only identically to the run envelope', async () => {
  const cwd = tmpProject();
  const unpinHome = pinHome(cwd);
  try {
    const runEnvelope = await orchestrationRun(ORCH_REQUEST, { env: ENV, cwd });
    assert.equal(runEnvelope.status, 'completed-prepare-only'); // baseline the run path already honors

    // RED before fix: getRun returns the persisted record verbatim,
    // so status === raw 'completed' and prepareOnly is undefined.
    // GREEN after fix: orchestrationStatus applies shapeRun.
    const statusEnvelope = await orchestrationStatus({ run_id: runEnvelope.runId }, { env: ENV, cwd });
    assert.equal(statusEnvelope.status, 'completed-prepare-only',
      `status path leaked raw '${statusEnvelope.status}'; must match the shaped run envelope`);
    assert.equal(statusEnvelope.prepareOnly, true);
  } finally {
    unpinHome();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('[R-status] a zero-task degraded run is never reported as prepared or bare completed', async () => {
  const cwd = tmpProject();
  const unpinHome = pinHome(cwd);
  try {
    // Create a degraded zero-task run via orchestrationRun with no model configured
    const degradedRun = await orchestrationRun(
      { request: 'do something simple', file_count: 1, module_count: 1, wait: true, worker_backend: 'inline' },
      { cwd, env: degradedEnv() },
    );
    assert.equal(degradedRun.degraded, true);
    assert.equal(degradedRun.tasks.length, 0);
    assert.equal(degradedRun.status, 'degraded');

    // Read back via orchestrationStatus
    const statusEnvelope = await orchestrationStatus({ run_id: degradedRun.runId }, { env: degradedEnv(), cwd });
    assert.notEqual(statusEnvelope.status, 'completed',
      'zero-task degraded run must not surface bare completed');
    assert.notEqual(statusEnvelope.prepareOnly, true,
      'zero-task run has nothing prepared; allPrepared must be false');
    assert.equal(statusEnvelope.degraded, true);
    assert.equal(statusEnvelope.status, 'degraded');
  } finally {
    unpinHome();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('[R-status] list runs shapes all entries', async () => {
  const cwd = tmpProject();
  const unpinHome = pinHome(cwd);
  try {
    // Create two runs: one prepare-only, one degraded zero-task
    const prepareRun = await orchestrationRun(ORCH_REQUEST, { env: ENV, cwd });
    const degradedRun = await orchestrationRun(
      { request: 'simple', file_count: 1, module_count: 1, wait: true, worker_backend: 'inline' },
      { cwd, env: degradedEnv() },
    );

    const list = await orchestrationStatus({ limit: 10 }, { env: ENV, cwd });
    assert(Array.isArray(list));
    assert(list.length >= 2);

    const prepareFromList = list.find(r => r.runId === prepareRun.runId);
    const degradedFromList = list.find(r => r.runId === degradedRun.runId);
    assert(prepareFromList, 'prepare-only run should appear in list');
    assert(degradedFromList, 'degraded run should appear in list');

    assert.equal(prepareFromList.status, 'completed-prepare-only');
    assert.equal(prepareFromList.prepareOnly, true);
    assert.equal(degradedFromList.status, 'degraded');
    assert.equal(degradedFromList.degraded, true);
    assert.notEqual(degradedFromList.status, 'completed');
  } finally {
    unpinHome();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Note: remote statusViaService cannot be tested without a real remote service.
// That verification belongs to integration tests.