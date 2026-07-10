/**
 * tests/functional/install-scope.functional.test.mjs
 *
 * ADR-0029: `construct install` is scoped. ADR-0071 renamed the flag from
 * `--scope` to `--footprint` (same values, same semantics); `--scope` keeps
 * working as a deprecated alias that prints a one-line deprecation notice.
 * A bare invocation with no `--footprint`/`--scope` hard-errors naming the
 * flag (construct-vzg2i.3) rather than silently exiting 0 having written
 * nothing; `--footprint=project` remains an explicit, documented no-op that
 * prints guidance and exits 0. `~/.construct/config.env` and `~/.claude/*`
 * must remain untouched in every non-writing path. Invalid footprints fail
 * with exit 1 before any machine setup. The `--footprint=user` and
 * `--footprint=both` paths run the machine-state body (covered by
 * tests/functional/install-parity and the setup-prompts suite — not
 * duplicated here).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { configDir, stateDir } from '../../lib/config/xdg.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'construct');

const tmpDirs = [];
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-install-scope-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { rmTmpDir(dir); } catch {}
  }
});

function runInstall(args, env) {
  return spawnSync('node', [BIN, 'install', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

test('bare install (no --footprint) hard-errors naming the flag, writes nothing', () => {
  const home = freshHome();
  const res = runInstall([], { HOME: home });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stdout: ${res.stdout}`);
  const combined = `${res.stdout}${res.stderr}`;
  assert.match(combined, /no footprint specified/i);
  assert.match(combined, /--footprint=user/);
  assert.match(combined, /--footprint=both/);
  assert.match(combined, /--footprint=project/);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'bare invocation must not write config.env');
  assert.equal(fs.existsSync(path.join(configDir(home), 'lib')), false, 'bare invocation must not create the lib symlink');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'bare invocation must not touch ~/.claude/');
});

test('--footprint=project is explicit no-op for user-scope state', () => {
  const home = freshHome();
  const res = runInstall(['--footprint=project'], { HOME: home });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /footprint: project/i);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'must not write user-scope config.env');
  assert.equal(fs.existsSync(path.join(configDir(home), 'lib')), false, 'must not create lib symlink');
  assert.equal(fs.existsSync(path.join(home, '.construct', 'services')), false, 'must not stage Postgres compose');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'must not touch ~/.claude/');
});

test('--footprint=bogus fails fast with exit 1 before any setup', () => {
  const home = freshHome();
  const res = runInstall(['--footprint=bogus'], { HOME: home });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(`${res.stdout}${res.stderr}`, /--footprint=bogus/);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'must not write config before validating footprint');
});

test('--footprint (no value) fails fast with exit 1', () => {
  const home = freshHome();
  const res = runInstall(['--footprint'], { HOME: home });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(`${res.stdout}${res.stderr}`, /--footprint/);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false);
});

test('--footprint=user --dry-run previews the plan and writes nothing', () => {
  const home = freshHome();
  const res = runInstall(['--footprint=user', '--dry-run', '--yes'], { HOME: home });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(res.stdout, /dry-run/i);
  assert.match(res.stdout, /No files were written/i);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'dry-run must not write config.env');
  assert.equal(fs.existsSync(path.join(configDir(home), 'lib')), false, 'dry-run must not create the lib symlink');
  assert.equal(fs.existsSync(path.join(stateDir(home), 'workspace')), false, 'dry-run must not scaffold the workspace');
  assert.equal(fs.existsSync(path.join(stateDir(home), 'vector')), false, 'dry-run must not create the vector store dir');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'dry-run must not touch ~/.claude/');
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'dev.construct.pressure-release.plist')), false, 'dry-run must not register the LaunchAgent');
});

test('--help still works, documents --footprint as primary and --scope as deprecated alias', () => {
  const home = freshHome();
  const res = runInstall(['--help'], { HOME: home });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--footprint=<f>/);
  assert.match(res.stdout, /project\|user\|both/);
  assert.match(res.stdout, /--scope=<s>\s+deprecated alias for --footprint/);
});

test('--scope=user is a deprecated alias for --footprint=user: identical dry-run plan plus a deprecation notice', () => {
  const home = freshHome();
  const footprintRes = runInstall(['--footprint=user', '--dry-run', '--yes'], { HOME: home });
  const scopeRes = runInstall(['--scope=user', '--dry-run', '--yes'], { HOME: home });
  assert.equal(scopeRes.status, 0, `expected exit 0, got ${scopeRes.status} — stderr: ${scopeRes.stderr}`);
  assert.equal(footprintRes.stdout, scopeRes.stdout, '--scope=user and --footprint=user must render the identical dry-run plan');
  assert.match(scopeRes.stderr, /Deprecation notice: --scope is deprecated/);
  assert.doesNotMatch(footprintRes.stderr, /Deprecation notice/, '--footprint must not print the deprecation notice');
});

test('--scope=project still works as an alias and prints the deprecation notice', () => {
  const home = freshHome();
  const res = runInstall(['--scope=project'], { HOME: home });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /footprint: project/i);
  assert.match(res.stderr, /Deprecation notice: --scope is deprecated for `construct install`; use --footprint instead/);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'must not write user-scope config.env');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'must not touch ~/.claude/');
});

test('--scope=bogus still fails fast with exit 1, same as --footprint=bogus', () => {
  const home = freshHome();
  const res = runInstall(['--scope=bogus'], { HOME: home });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(`${res.stdout}${res.stderr}`, /--scope=bogus/);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'must not write config before validating footprint');
});

test('--scope (no value) still fails fast with exit 1', () => {
  const home = freshHome();
  const res = runInstall(['--scope'], { HOME: home });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(`${res.stdout}${res.stderr}`, /--scope/);
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false);
});

test('--footprint takes precedence when both --footprint and --scope are passed, no deprecation notice', () => {
  const home = freshHome();
  const res = runInstall(['--footprint=project', '--scope=user'], { HOME: home });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(res.stdout, /footprint: project/i);
  assert.doesNotMatch(res.stderr, /Deprecation notice/, 'explicit --footprint wins and is not an alias use');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'must not touch ~/.claude/');
});
