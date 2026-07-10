/**
 * tests/onboarding-docs-consistency.test.mjs — guards README's quickstart and
 * docs/guides/start's first-task path against re-diverging.
 *
 * Ground truth (lib/init-unified.mjs) is that `construct init` syncs adapters
 * and starts services by default unless `--no-start` or `--interactive` is
 * passed. This test pins README's "Getting started" claim to that code path
 * and blocks first-task.mdx from presenting `construct sync` / `construct
 * dev` as separate mandatory onboarding steps after `construct init`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO, relPath), 'utf8');
}

test('lib/init-unified.mjs still auto-starts services by default', () => {
  const src = read('lib/init-unified.mjs');
  assert.match(
    src,
    /shouldStart\s*=\s*!args\.includes\('--no-start'\)/,
    'construct init must keep starting services by default (unless --no-start/--interactive) — ' +
      "README's quickstart claim depends on this"
  );
});

test('README quickstart claims construct init starts services by default', () => {
  const readme = read('README.md');
  const gettingStarted = readme.slice(readme.indexOf('## Getting started'), readme.indexOf('## Usage'));
  assert.match(
    gettingStarted,
    /construct init.*starts the local services by default/s,
    'README\'s "Getting started" section must state that `construct init` starts services by default'
  );
});

test('first-task.mdx does not present sync/dev as separate required onboarding steps', () => {
  const firstTask = read('docs/guides/start/first-task.mdx');
  const initSection = firstTask.slice(
    firstTask.indexOf('## Initialize Construct in the project'),
    firstTask.indexOf('## Dispatch a task')
  );
  assert.doesNotMatch(
    initSection,
    /### `construct sync`/,
    'construct sync must not reappear as a separate <Step> in the init walkthrough — ' +
      'construct init syncs adapters itself by default'
  );
  assert.doesNotMatch(
    initSection,
    /### `construct dev`/,
    'construct dev must not reappear as a separate <Step> in the init walkthrough — ' +
      'construct init starts services itself by default'
  );
  assert.match(
    initSection,
    /construct init --yes/,
    'the init walkthrough should lead with the single-command canonical path'
  );
});
