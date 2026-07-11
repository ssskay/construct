/**
 * tests/functional/edit-error-recovery.functional.test.mjs — end-to-end
 * coverage for the PostToolUseFailure edit-recovery hook.
 *
 * Spawns lib/hooks/edit-error-recovery.mjs with hook-input JSON on stdin.
 * The hook is pure stdin→stdout: when tool_name is an edit tool (Edit,
 * Write, MultiEdit) and the error text matches a known edit-failure
 * pattern, it prints recovery steps naming the failed file_path.
 *
 * Contracts:
 *   1. Matching tool + matching error → recovery message with the file path.
 *   2. Error text is also matched inside a JSON-stringified tool_response.
 *   3. Non-edit tool with a matching error → silent exit 0.
 *   4. Edit tool with a non-matching error → silent exit 0.
 *   5. Malformed stdin → exit 0, no crash, no output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const HOOK = join(REPO_ROOT, 'lib', 'hooks', 'edit-error-recovery.mjs');

function seed() {
  const home = mkdtempSync(join(tmpdir(), 'edit-error-recovery-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'edit-error-recovery-cwd-'));
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
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('edit-error-recovery prints recovery steps with the failed file_path on a matching Edit failure', () => {
  const env = seed();
  try {
    const r = runHook(env, {
      tool_name: 'Edit',
      error: 'String not found: old_string not found in file',
      tool_input: { file_path: '/tmp/project/src/app.mjs' },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
    assert.match(r.stdout, /✗ Edit failed on \/tmp\/project\/src\/app\.mjs\./);
    assert.match(r.stdout, /Recovery steps:/);
    assert.match(r.stdout, /Re-read the file with Read before retrying/);
  } finally {
    env.cleanup();
  }
});

test('edit-error-recovery matches error text embedded in tool_response for MultiEdit', () => {
  const env = seed();
  try {
    const r = runHook(env, {
      tool_name: 'MultiEdit',
      tool_response: { is_error: true, detail: 'No match found for edit 2 of 3' },
      tool_input: { file_path: '/tmp/project/lib/util.mjs' },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /✗ MultiEdit failed on \/tmp\/project\/lib\/util\.mjs\./);
    assert.match(r.stdout, /Recovery steps:/);
  } finally {
    env.cleanup();
  }
});

test('edit-error-recovery is silent for a non-edit tool even when the error text matches', () => {
  const env = seed();
  try {
    const r = runHook(env, {
      tool_name: 'Bash',
      error: 'permission denied: /etc/hosts',
      tool_input: { command: 'cat /etc/hosts' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'non-edit tools must produce no output');
  } finally {
    env.cleanup();
  }
});

test('edit-error-recovery is silent when the error does not match an edit-failure pattern', () => {
  const env = seed();
  try {
    const r = runHook(env, {
      tool_name: 'Edit',
      error: 'network timeout while syncing state',
      tool_input: { file_path: '/tmp/project/src/app.mjs' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'unrecognized errors must produce no output');
  } finally {
    env.cleanup();
  }
});

test('edit-error-recovery exits 0 with no output on malformed stdin', () => {
  const env = seed();
  try {
    const r = runHook(env, 'this is {not json');
    assert.equal(r.status, 0, `malformed input must not crash; stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
  } finally {
    env.cleanup();
  }
});
