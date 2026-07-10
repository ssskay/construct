/**
 * tests/functional/orchestration-prepare-only-user-facing.functional.test.mjs
 *
 * construct-vzg2i.2: orchestration-truth-negative.functional.test.mjs already pins
 * the metadata honesty for a prepare-only run (prepareOnly/degraded fields, no
 * fabricated output). This suite pins the lift of that same honesty onto the two
 * USER-FACING surfaces a caller actually reads without knowing to check metadata:
 *   - the MCP tool result (orchestrationRun's shaped return, which server.mjs
 *     serializes verbatim as the tool's text content — see
 *     lib/mcp/dispatch-envelope.mjs's `JSON.stringify(toolResult, null, 2)`);
 *   - the CLI's `construct orchestrate run` stdout (bin/construct's cmdOrchestrate).
 *
 * Both must state "PREPARE-ONLY" and the exact remediation next step, not just
 * carry prepareOnly:true / a status enum a caller has to already know to check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { orchestrationRun } from '../../lib/mcp/tools/orchestration-run.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'construct');
const MODEL = 'anthropic/claude-sonnet-4-6';
const REQUEST = 'refactor the auth module and review for security';

const homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-prepare-only-home-'));
const prevHomeOverride = process.env.CX_HOME_OVERRIDE;
process.env.CX_HOME_OVERRIDE = homeOverride;

const dirs = [];
function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-prepare-only-'));
  dirs.push(cwd);
  return cwd;
}

test.after(() => {
  for (const d of dirs) { try { rmTmpDir(d); } catch {} }
  try { rmTmpDir(homeOverride); } catch {}
  if (prevHomeOverride === undefined) delete process.env.CX_HOME_OVERRIDE;
  else process.env.CX_HOME_OVERRIDE = prevHomeOverride;
});

test('MCP tool result states PREPARE-ONLY plus the exact next step, not just prepareOnly:true', async () => {
  const env = { CX_MODEL_REASONING: MODEL, CX_MODEL_STANDARD: MODEL, CX_MODEL_FAST: MODEL };
  const res = await orchestrationRun(
    { request: REQUEST, requested_strategy: 'orchestrated', host_model: MODEL, file_count: 4, module_count: 2, worker_backend: 'inline' },
    { env, cwd: project() },
  );
  assert.equal(res.status, 'completed-prepare-only');
  assert.equal(res.prepareOnly, true);

  // The MCP wire format is JSON.stringify(toolResult, null, 2) verbatim
  // (lib/mcp/dispatch-envelope.mjs) — assert against that exact serialized
  // text, not the object, so this pins what the calling agent actually reads.
  const wireText = JSON.stringify(res, null, 2);
  assert.match(wireText, /PREPARE-ONLY/, 'the loud statement must be in the serialized tool result text');
  assert.match(wireText, /no specialist executed/i);
  assert.match(wireText, /workerBackend=provider/, 'the exact remediation next step must be in the tool result text');
  assert.match(wireText, /worker_backend=host/, 'the alternate host-execution remediation must also be named');
});

test('a real provider-executed run carries no PREPARE-ONLY message (no false positive)', async () => {
  const env = { CX_MODEL_REASONING: MODEL, CX_MODEL_STANDARD: MODEL, CX_MODEL_FAST: MODEL, ANTHROPIC_API_KEY: 'sk-test' };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'real specialist output' }] }),
  });
  const res = await orchestrationRun(
    { request: REQUEST, requested_strategy: 'orchestrated', host_model: MODEL, file_count: 4, module_count: 2, worker_backend: 'provider' },
    { env, cwd: project(), fetchImpl },
  );
  assert.notEqual(res.status, 'completed-prepare-only');
  assert.equal(res.message, undefined, 'a real-execution run must not carry the prepare-only notice');
});

test('CLI `orchestrate run` stdout states PREPARE-ONLY plus the exact next step', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-prepare-only-cli-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-prepare-only-cli-cwd-'));
  dirs.push(home, cwd);
  try {
    const result = spawnSync(process.execPath, [
      BIN, 'orchestrate', 'run', REQUEST,
      '--strategy', 'orchestrated', '--host-model', MODEL,
      '--file-count', '4', '--module-count', '2',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        CX_HOME_OVERRIDE: home,
        CX_MODEL_REASONING: MODEL,
        CX_MODEL_STANDARD: MODEL,
        CX_MODEL_FAST: MODEL,
        CONSTRUCT_SKIP_BOOTSTRAP_PROBE: '1',
        BOOTSTRAP_CHECKED: '1',
        CONSTRUCT_DISABLE_AUTO_CLEANUP: '1',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /completed-prepare-only/);
    assert.match(result.stdout, /PREPARE-ONLY/, `CLI stdout must state PREPARE-ONLY.\nstdout: ${result.stdout.slice(0, 1000)}`);
    assert.match(result.stdout, /no specialist executed/i);
    assert.match(result.stdout, /workerBackend=provider/, 'CLI stdout must name the exact remediation next step');
    assert.match(result.stdout, /worker_backend=host/);
  } finally {
    rmTmpDir(home);
    rmTmpDir(cwd);
  }
});
