/**
 * tests/published-scripts.test.mjs — every scripts/ file the CLI dispatches to
 * must ship in the npm artifact.
 *
 * package.json uses a `files` whitelist, so a scripts/ file is excluded from
 * the published tarball unless listed explicitly. bin/construct dispatches to
 * scripts via `path.join(ROOT_DIR, 'scripts', '<name>')`; a referenced script
 * missing from the whitelist crashes that command with MODULE_NOT_FOUND for
 * every npm consumer while working fine from a git clone (v1.5.2 shipped only
 * sync-specialists.mjs, breaking `review legacy`, `optimize`, the sync-time
 * workflow-defs drift check, seed-traces, and lint:templates). This gate
 * extracts the referenced script names from the CLI source and asserts each
 * one is whitelisted and exists on disk.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function referencedScripts() {
  const src = fs.readFileSync(path.join(root, 'bin', 'construct'), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/['"]scripts['"],\s*['"]([\w.-]+\.mjs)['"]/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

test('every scripts/ file referenced by bin/construct is in the npm files whitelist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const shipped = new Set(pkg.files.filter((f) => f.startsWith('scripts/')));
  const referenced = referencedScripts();

  assert.ok(referenced.length > 0, 'expected bin/construct to reference at least one script');
  const missing = referenced.filter((name) => !shipped.has(`scripts/${name}`));
  assert.deepEqual(missing, [], `scripts referenced by the CLI but excluded from the published package: ${missing.join(', ')}`);
});

test('every whitelisted scripts/ entry exists on disk', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const listed = pkg.files.filter((f) => f.startsWith('scripts/'));
  const gone = listed.filter((f) => !fs.existsSync(path.join(root, f)));
  assert.deepEqual(gone, [], `whitelisted scripts missing on disk: ${gone.join(', ')}`);
});
