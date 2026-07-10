/**
 * tests/functional/postinstall-global-scope.functional.test.mjs
 *
 * ADR-0029: `npm i -g` runs construct-postinstall.mjs with
 * `npm_config_global=true`. The postinstall must print footprint guidance and
 * exit 0 without invoking the global front-door sync — `~/.claude/CLAUDE.md`,
 * `~/.claude/settings.json`, and `~/.construct/*` only land on
 * `construct install --footprint=user` (ADR-0071 renamed --scope to
 * --footprint), so the consent point is visible.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { configDir } from '../../lib/config/xdg.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTINSTALL = path.resolve(__dirname, '..', '..', 'bin', 'construct-postinstall.mjs');

const tmpDirs = [];
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-postinstall-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { rmTmpDir(dir); } catch {}
  }
});

test('npm_config_global=true: postinstall prints footprint guidance and writes nothing', () => {
  const home = freshHome();
  const res = spawnSync('node', [POSTINSTALL], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      npm_config_global: 'true',
      INIT_CWD: home,
      CONSTRUCT_SKIP_POSTINSTALL: '',
    },
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} — stderr: ${res.stderr}`);
  assert.match(res.stdout, /machine-scope setup is opt-in/);
  assert.match(res.stdout, /construct install --footprint=user/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'postinstall must not write to ~/.claude/');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')), false, 'postinstall must not write to ~/.claude/CLAUDE.md');
  assert.equal(fs.existsSync(path.join(configDir(home), 'config.env')), false, 'postinstall must not write to configDir()/config.env');
});

test('CONSTRUCT_SKIP_POSTINSTALL=1 still short-circuits the postinstall', () => {
  const home = freshHome();
  const res = spawnSync('node', [POSTINSTALL], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      npm_config_global: 'true',
      CONSTRUCT_SKIP_POSTINSTALL: '1',
    },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /skipping/i);
});
