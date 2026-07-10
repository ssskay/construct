/**
 * tests/functional/review-pr.functional.test.mjs — `construct review pr`
 * deterministic diff review through the real binary (bead construct-h7501,
 * ADR-0069). This is the backend of the CI `review` gate, so the assertions
 * mirror the gate's contract: a planted secret in the PR diff surfaces as a
 * high-severity finding, a clean diff reports zero findings with exit 0, and
 * a review that cannot run (missing --base, unknown ref) exits non-zero
 * instead of shrugging. The fixture secret is assembled at runtime so no
 * scannable literal lives in the repository.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'construct');

const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const dirs = [];
test.after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd, GIT_CONFIG_GLOBAL: path.join(cwd, '.gitconfig-none') },
  });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function makePrRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-reviewpr-'));
  dirs.push(cwd);
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'app.mjs'), 'export const ok = true;\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'base']);
  git(cwd, ['checkout', '-b', 'feature']);
  return cwd;
}

function runReviewPr(cwd, args) {
  return spawnSync(process.execPath, [BIN, 'review', 'pr', ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd },
  });
}

test('a planted secret in the PR diff surfaces as a high-severity finding', () => {
  const cwd = makePrRepo();
  fs.writeFileSync(path.join(cwd, 'src', 'deploy.mjs'), `export const key = '${FAKE_AWS_KEY}';\n`);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'feature change with a leaked key']);

  const res = runReviewPr(cwd, ['--base=main', '--output=.cx/pr-review.json']);
  assert.equal(res.status, 0, `review pr failed: ${res.stderr}`);

  const report = JSON.parse(fs.readFileSync(path.join(cwd, '.cx', 'pr-review.json'), 'utf8'));
  assert.equal(report.generated_by, 'construct review pr');
  assert.equal(report.base_ref, 'main');
  assert.ok(report.summary.length > 0, 'summary must be non-empty');
  const high = report.findings.filter((f) => f.severity === 'high');
  assert.equal(high.length, 1, `expected exactly one high finding, got: ${JSON.stringify(report.findings)}`);
  assert.match(high[0].message, /AWS access key/);
  assert.equal(high[0].file, 'src/deploy.mjs');
});

test('a clean diff reports zero findings and exits 0', () => {
  const cwd = makePrRepo();
  fs.writeFileSync(path.join(cwd, 'src', 'app.mjs'), 'export const ok = true;\nexport const extra = 1;\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'clean feature change']);

  const res = runReviewPr(cwd, ['--base=main']);
  assert.equal(res.status, 0, `review pr failed: ${res.stderr}`);

  const report = JSON.parse(res.stdout);
  assert.equal(report.findings.length, 0, `expected no findings: ${JSON.stringify(report.findings)}`);
  assert.equal(report.diff.files_changed, 1);
});

test('base-branch drift after the fork point is not attributed to the PR', () => {
  const cwd = makePrRepo();
  fs.writeFileSync(path.join(cwd, 'src', 'feature.mjs'), 'export const feature = 1;\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'feature-only change']);
  git(cwd, ['checkout', 'main']);
  fs.writeFileSync(path.join(cwd, 'src', 'drift.mjs'), `export const key = '${FAKE_AWS_KEY}';\n`);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'base moved on with its own (leaky) change']);
  git(cwd, ['checkout', 'feature']);

  const res = runReviewPr(cwd, ['--base=main']);
  assert.equal(res.status, 0, `review pr failed: ${res.stderr}`);

  const report = JSON.parse(res.stdout);
  assert.equal(report.findings.length, 0, 'merge-base semantics must exclude base drift');
  assert.equal(report.diff.files_changed, 1);
});

test('missing --base and an unknown ref both fail loudly', () => {
  const cwd = makePrRepo();
  fs.writeFileSync(path.join(cwd, 'src', 'app.mjs'), 'export const ok = false;\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'change']);

  const noBase = runReviewPr(cwd, []);
  assert.equal(noBase.status, 1);
  assert.match(noBase.stderr, /Usage: construct review pr --base=/);

  const badRef = runReviewPr(cwd, ['--base=no-such-branch']);
  assert.equal(badRef.status, 1, 'unknown ref must exit non-zero, not shrug');
});
