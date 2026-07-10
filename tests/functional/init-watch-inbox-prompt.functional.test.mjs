/**
 * tests/functional/init-watch-inbox-prompt.functional.test.mjs
 *
 * construct-b2t01.1: `construct init` asks once whether to watch inbox/
 * continuously. Non-interactive runs (--yes, CI, no TTY) never block on
 * stdin — the default is off, taken instantly via the --watch-inbox flag's
 * absence. On yes (--watch-inbox), autoEmbed:true is wired into
 * construct.config.json and the enable-supervision hint is printed instead
 * of installing a real launchd/systemd unit (supervision install is
 * interactive-only). On no, the enable commands are printed so the user can
 * turn it on later. Spawns the real `construct init` binary against an
 * isolated HOME/CX_HOME_OVERRIDE (sterileSpawnEnv) and asserts on the
 * durable construct.config.json artifact, not just stdout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'construct');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'init-watch-inbox-'));
  const HOME = join(root, 'HOME');
  const project = join(root, 'project');
  mkdirSync(HOME, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, HOME, project, cleanup() { rmTmpDir(root); } };
}

function runInit(env, extraArgs) {
  spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: env.project });
  spawnSync('git', ['config', 'user.email', 'watch-inbox@example.com'], { cwd: env.project });
  spawnSync('git', ['config', 'user.name', 'Watch Inbox Test'], { cwd: env.project });
  return spawnSync(
    process.execPath,
    [BIN, 'init', '--yes', '--no-start', ...extraArgs],
    {
      cwd: env.project,
      encoding: 'utf8',
      timeout: 120_000,
      env: sterileSpawnEnv({
        HOME: env.HOME,
        USERPROFILE: env.HOME,
        CX_HOME_OVERRIDE: env.HOME,
        XDG_CONFIG_HOME: join(env.HOME, '.config'),
        XDG_DATA_HOME: join(env.HOME, '.local', 'share'),
        XDG_CACHE_HOME: join(env.HOME, '.cache'),
        XDG_RUNTIME_DIR: join(env.HOME, 'run'),
        CONSTRUCT_SKIP_BOOTSTRAP_PROBE: '1',
        BOOTSTRAP_CHECKED: '1',
      }),
    },
  );
}

function readProjectConfig(env) {
  return JSON.parse(readFileSync(join(env.project, 'construct.config.json'), 'utf8'));
}

test('construct init --yes (no --watch-inbox) defaults to off without blocking on stdin', async (t) => {
  const env = sandbox();
  t.after(env.cleanup);

  const start = Date.now();
  const result = runInit(env, []);
  const elapsed = Date.now() - start;

  assert.equal(result.status, 0, `init exited ${result.status}: ${result.stderr}`);
  assert.ok(elapsed < 120_000, 'init must not hang waiting on stdin in a non-interactive context');

  const config = readProjectConfig(env);
  assert.equal(config.autoEmbed, false, 'autoEmbed defaults to false when --watch-inbox is not passed');

  assert.match(result.stdout, /Continuous inbox watching is off/);
  assert.match(result.stdout, /construct config set autoEmbed true/);
  assert.match(result.stdout, /construct embed supervise/);
});

test('construct init --yes --watch-inbox wires autoEmbed:true and prints the supervise hint', async (t) => {
  const env = sandbox();
  t.after(env.cleanup);

  const result = runInit(env, ['--watch-inbox']);
  assert.equal(result.status, 0, `init exited ${result.status}: ${result.stderr}`);

  const config = readProjectConfig(env);
  assert.equal(config.autoEmbed, true, 'autoEmbed is wired to true when --watch-inbox is passed');

  assert.match(result.stdout, /Continuous inbox watching enabled \(autoEmbed: true\)/);
  // Non-interactive: supervision install (launchd/systemd) stays a printed
  // next step rather than an automatic system mutation.
  assert.match(result.stdout, /Run `construct embed supervise` later/);
});
