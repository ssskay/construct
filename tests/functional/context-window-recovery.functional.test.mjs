/**
 * tests/functional/context-window-recovery.functional.test.mjs — end-to-end
 * coverage for the PostToolUseFailure context-window recovery hook.
 *
 * Spawns lib/hooks/context-window-recovery.mjs with hook-input JSON on
 * stdin inside a sterile env (HOME/CX_HOME_OVERRIDE pinned to a fresh
 * tmpdir root), so doctorRoot() resolves under the fixture, never the
 * developer's real state dir. The expected doctor root is computed with
 * the same lib/config/xdg.mjs module the hook imports.
 *
 * Contracts:
 *   1. A context-limit error writes .cx/context.md + context.json in the
 *      project cwd AND under doctorRoot(), plus the cooldown state file
 *      doctorRoot()/context-recovery.json.
 *   2. A second trigger inside the 10-minute cooldown is a no-op: no
 *      files written, no output, cooldown timestamp untouched.
 *   3. An expired cooldown fires again and refreshes the timestamp.
 *   4. A non-matching error writes nothing and prints nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctorRoot } from '../../lib/config/xdg.mjs';
import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const HOOK = join(REPO_ROOT, 'lib', 'hooks', 'context-window-recovery.mjs');

const CONTEXT_LIMIT_ERROR = 'Error: prompt is too long, context window exceeded';

// The child's sterile env carries no XDG_STATE_HOME and no
// CONSTRUCT_DOCTOR_ROOT, so doctorRoot() in the hook falls through to
// <home>/.local/state/construct; passing an empty env here mirrors that.

function childDoctorRoot(home) {
  return doctorRoot(home, {});
}

function seed() {
  const home = mkdtempSync(join(tmpdir(), 'context-recovery-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'context-recovery-cwd-'));
  return {
    home,
    cwd,
    cleanup: () => {
      rmTmpDir(home);
      rmTmpDir(cwd);
    },
  };
}

function runHook({ home, cwd }, payload) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    env: sterileSpawnEnv({ HOME: home, USERPROFILE: home, CX_HOME_OVERRIDE: home }),
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('context-window-recovery saves context in cwd and doctorRoot and records the cooldown', () => {
  const env = seed();
  try {
    const r = runHook(env, { error: CONTEXT_LIMIT_ERROR, cwd: env.cwd });
    assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
    assert.match(r.stdout, /Context window limit hit/);

    const projectMd = join(env.cwd, '.cx', 'context.md');
    const projectJson = join(env.cwd, '.cx', 'context.json');
    assert.ok(existsSync(projectMd), 'project .cx/context.md must be written');
    assert.ok(existsSync(projectJson), 'project .cx/context.json must be written');
    assert.match(readFileSync(projectMd, 'utf8'), /context-window-recovery/);
    const projectState = JSON.parse(readFileSync(projectJson, 'utf8'));
    assert.equal(projectState.source, 'context-window-recovery');

    const globalRoot = childDoctorRoot(env.home);
    assert.ok(existsSync(join(globalRoot, '.cx', 'context.md')), 'doctorRoot .cx/context.md must be written');
    assert.ok(existsSync(join(globalRoot, '.cx', 'context.json')), 'doctorRoot .cx/context.json must be written');

    const cooldown = JSON.parse(readFileSync(join(globalRoot, 'context-recovery.json'), 'utf8'));
    assert.ok(typeof cooldown.lastTriggeredAt === 'number' && cooldown.lastTriggeredAt > 0,
      'cooldown state must record a lastTriggeredAt timestamp');
  } finally {
    env.cleanup();
  }
});

test('context-window-recovery is a no-op on a second trigger inside the 10-minute cooldown', () => {
  const env = seed();
  const secondCwd = mkdtempSync(join(tmpdir(), 'context-recovery-cwd2-'));
  try {
    const first = runHook(env, { error: CONTEXT_LIMIT_ERROR, cwd: env.cwd });
    assert.equal(first.status, 0);
    const statePath = join(childDoctorRoot(env.home), 'context-recovery.json');
    const firstStamp = JSON.parse(readFileSync(statePath, 'utf8')).lastTriggeredAt;

    const second = runHook({ home: env.home, cwd: secondCwd }, { error: CONTEXT_LIMIT_ERROR, cwd: secondCwd });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '', 'a cooled-down trigger must print nothing');
    assert.equal(existsSync(join(secondCwd, '.cx')), false, 'a cooled-down trigger must not write project context');
    const secondStamp = JSON.parse(readFileSync(statePath, 'utf8')).lastTriggeredAt;
    assert.equal(secondStamp, firstStamp, 'the cooldown timestamp must be untouched');
  } finally {
    rmTmpDir(secondCwd);
    env.cleanup();
  }
});

test('context-window-recovery fires again once the cooldown has expired', () => {
  const env = seed();
  try {
    const globalRoot = childDoctorRoot(env.home);
    mkdirSync(globalRoot, { recursive: true });
    const staleStamp = Date.now() - 11 * 60 * 1000;
    writeFileSync(join(globalRoot, 'context-recovery.json'), JSON.stringify({ lastTriggeredAt: staleStamp }));

    const r = runHook(env, { error: CONTEXT_LIMIT_ERROR, cwd: env.cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Context window limit hit/);
    assert.ok(existsSync(join(env.cwd, '.cx', 'context.md')), 'an expired cooldown must save context again');
    const refreshed = JSON.parse(readFileSync(join(globalRoot, 'context-recovery.json'), 'utf8')).lastTriggeredAt;
    assert.ok(refreshed > staleStamp, 'the cooldown timestamp must be refreshed');
  } finally {
    env.cleanup();
  }
});

test('context-window-recovery writes nothing for a non-matching error', () => {
  const env = seed();
  try {
    const r = runHook(env, { error: 'segmentation fault in native module', cwd: env.cwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'a non-context error must print nothing');
    assert.equal(existsSync(join(env.cwd, '.cx')), false, 'no project context may be written');
    assert.equal(existsSync(join(childDoctorRoot(env.home), 'context-recovery.json')), false,
      'no cooldown state may be written');
  } finally {
    env.cleanup();
  }
});
