/**
 * tests/functional/first-run-readiness-line.functional.test.mjs
 *
 * construct-vzg2i.1: `construct init` and `construct doctor` must print a
 * plain first-run honesty line — EXECUTE when the config-resolved worker
 * backend is `provider` and a materialized key is present for the resolved
 * provider family, PLAN otherwise — reusing buildOrchestrationReadiness (the
 * same resolution orchestration_run itself calls) via the shared
 * formatFirstRunExecutionReadiness helper in lib/orchestration/readiness.mjs.
 * Spawns the real binary in isolated tmpdirs for both states so a divergence
 * between the two call sites (init vs doctor) or a helper regression shows up
 * here, not only in a unit test of the formatter.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { rmTmpDir } from '../helpers/cleanup.mjs';
import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'construct');

const PLAN_LINE = 'specialists will only PLAN (fix: set orchestration.workerBackend=provider + a key)';
const EXECUTE_LINE = 'specialists will EXECUTE (provider anthropic + key found)';

const dirs = [];
function freshProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-firstrun-readiness-'));
  dirs.push(dir);
  spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'firstrun@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Firstrun Test'], { cwd: dir });
  return dir;
}
test.after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

function baseEnv(dir, overrides = {}) {
  return sterileSpawnEnv({
    HOME: dir,
    CX_HOME_OVERRIDE: dir,
    CONSTRUCT_SKIP_BOOTSTRAP_PROBE: '1',
    BOOTSTRAP_CHECKED: '1',
    ...overrides,
  });
}

function writeProviderConfig(dir) {
  fs.writeFileSync(
    path.join(dir, 'construct.config.json'),
    JSON.stringify({ version: 1, orchestration: { workerBackend: 'provider' } }),
  );
}

// construct doctor's exit code reflects unrelated repo-health checks (e.g.
// git hooks wiring) that a bare `git init` tmpdir never satisfies, so these
// assertions only care about the printed readiness line, not the process
// exit code.

test('construct doctor prints the PLAN line on an env with no configured provider backend/key', () => {
  const dir = freshProject();
  const res = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: baseEnv(dir),
  });
  assert.ok(res.stdout.includes(PLAN_LINE), `expected PLAN line in doctor output:\n${res.stdout}\n${res.stderr}`);
});

test('construct doctor prints the EXECUTE line when workerBackend=provider and a materialized key is present', () => {
  const dir = freshProject();
  writeProviderConfig(dir);
  const res = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: baseEnv(dir, { ANTHROPIC_API_KEY: 'sk-test-canary' }),
  });
  assert.ok(res.stdout.includes(EXECUTE_LINE), `expected EXECUTE line in doctor output:\n${res.stdout}\n${res.stderr}`);
});

test('construct init prints the PLAN line on a fresh project with no configured provider backend/key', () => {
  const dir = freshProject();
  const res = spawnSync(process.execPath, [BIN, 'init', '--yes', '--no-start', '--no-beads'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: baseEnv(dir),
  });
  assert.equal(res.status, 0, `init failed: ${res.stderr}`);
  assert.ok(res.stdout.includes(PLAN_LINE), `expected PLAN line in init output:\n${res.stdout}`);
});

test('construct init prints the EXECUTE line when workerBackend=provider and a materialized key is present', () => {
  const dir = freshProject();
  writeProviderConfig(dir);
  const res = spawnSync(process.execPath, [BIN, 'init', '--yes', '--no-start', '--no-beads'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: baseEnv(dir, { ANTHROPIC_API_KEY: 'sk-test-canary' }),
  });
  assert.equal(res.status, 0, `init failed: ${res.stderr}`);
  assert.ok(res.stdout.includes(EXECUTE_LINE), `expected EXECUTE line in init output:\n${res.stdout}`);
});
