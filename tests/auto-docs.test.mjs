/**
 * tests/auto-docs.test.mjs — tests for lib/auto-docs.mjs region regeneration.
 *
 * @capability document.auto-docs
 *
 * Verifies that regenerateDocs() correctly writes/replaces managed regions,
 * is idempotent (second run produces no changes), and that --check mode
 * detects drift without writing files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { regenerateDocs } from '../lib/auto-docs.mjs';

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-autodocs-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('regenerateDocs fills empty AUTO regions in README', async () => {
  const rootDir = makeTempRepo({
    'README.md': '# Construct\n\n## Commands\n\n<!-- AUTO:commands -->\n<!-- /AUTO:commands -->\n',
    'lib/cli-commands.mjs': `
export const CLI_COMMANDS = [{ name: 'status', emoji: '📡', category: 'Services', description: 'Show health' }];
export const CLI_COMMANDS_BY_CATEGORY = { Services: CLI_COMMANDS };
export const CATEGORY_ORDER = ['Services'];
    `,
    'lib/hooks/test-hook.mjs': '/**\n * lib/hooks/test-hook.mjs — sample hook for testing.\n */\n',
  });

  const { changed } = await regenerateDocs({ rootDir });
  assert.ok(changed.length > 0, 'expected at least one file to be updated');

  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  assert.ok(readme.includes('`construct status`'), 'commands table should include status command');
  assert.ok(readme.includes('<!-- AUTO:commands -->'), 'open marker should remain');
  assert.ok(readme.includes('<!-- /AUTO:commands -->'), 'close marker should remain');
});

test('regenerateDocs is idempotent', async () => {
  const rootDir = makeTempRepo({
    'README.md': '# Construct\n\n<!-- AUTO:commands -->\n<!-- /AUTO:commands -->\n',
    'lib/cli-commands.mjs': `
export const CLI_COMMANDS = [{ name: 'doctor', emoji: '🩺', category: 'Diagnostics', description: 'Run checks' }];
export const CLI_COMMANDS_BY_CATEGORY = { Diagnostics: CLI_COMMANDS };
export const CATEGORY_ORDER = ['Diagnostics'];
    `,
    'lib/hooks/h.mjs': '',
  });

  await regenerateDocs({ rootDir });
  const contentAfterFirst = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');

  const { changed } = await regenerateDocs({ rootDir });
  const contentAfterSecond = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');

  assert.equal(changed.length, 0, 'second run should change nothing');
  assert.equal(contentAfterFirst, contentAfterSecond, 'content should be identical after second run');
});

test('regenerateDocs --check detects drift without writing', async () => {
  const rootDir = makeTempRepo({
    'README.md': '# Construct\n\n<!-- AUTO:commands -->\nSTALE CONTENT\n<!-- /AUTO:commands -->\n',
    'lib/cli-commands.mjs': `
export const CLI_COMMANDS = [{ name: 'sync', emoji: '🔄', category: 'Sync', description: 'Sync agents' }];
export const CLI_COMMANDS_BY_CATEGORY = { Sync: CLI_COMMANDS };
export const CATEGORY_ORDER = ['Sync'];
    `,
    'lib/hooks/h.mjs': '',
  });

  const originalContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  const { changed, checked } = await regenerateDocs({ rootDir, check: true });

  assert.equal(checked, true);
  assert.ok(changed.length > 0, 'should detect drift');
  const contentAfterCheck = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  assert.equal(originalContent, contentAfterCheck, '--check must not write files');
});

test('regenerateDocs skips files without AUTO markers', async () => {
  const rootDir = makeTempRepo({
    'README.md': '# No markers here\n',
    'lib/cli-commands.mjs': `
export const CLI_COMMANDS = [];
export const CLI_COMMANDS_BY_CATEGORY = {};
export const CATEGORY_ORDER = [];
    `,
    'lib/hooks/h.mjs': '',
  });

  const { changed } = await regenerateDocs({ rootDir });
  assert.equal(changed.length, 0, 'no markers means nothing to update');
});

test('regenerateDocs stays silent when rootDir is not a git repository', async () => {
  const rootDir = makeTempRepo({
    'README.md': '# Construct\n\n## Commands\n\n<!-- AUTO:commands -->\n<!-- /AUTO:commands -->\n',
    'lib/cli-commands.mjs': `
export const CLI_COMMANDS = [{ name: 'status', emoji: '📡', category: 'Services', description: 'Show health' }];
export const CLI_COMMANDS_BY_CATEGORY = { Services: CLI_COMMANDS };
export const CATEGORY_ORDER = ['Services'];
    `,
    'lib/hooks/test-hook.mjs': '/**\n * lib/hooks/test-hook.mjs — sample hook for testing.\n */\n',
  });

  const libUrl = new URL('../lib/auto-docs.mjs', import.meta.url).href;
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { regenerateDocs } = await import(${JSON.stringify(libUrl)}); await regenerateDocs({ rootDir: ${JSON.stringify(rootDir)}, check: true });`,
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`);
  assert.ok(!res.stderr.includes('fatal: not a git repository'), `git stderr leaked to the user: ${res.stderr}`);
});
