/**
 * tests/functional/monitor-cli.functional.test.mjs
 *
 * Drives the real `construct monitor` binary against an isolated HOME/cwd
 * (construct-jvjow.1). Proves the one-command flow writes all three durable
 * artifacts that today require three separate commands — construct.config.json
 * `sources.targets[]`, embed.yaml `roles{}`/`sources:`, and the enabled
 * `.cx/embed/<id>.manifest.json` capability manifest — and prints a summary of
 * what it assembled. The daemon-start step is exercised with `--no-start`
 * here (assembly only); the daemon actually starting is covered by the
 * `runEmbedCli(['start'], ...)` unit tests in tests/embed-cli.test.mjs, which
 * `construct monitor` calls unmodified.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'construct');

const tmpDirs = [];
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cx-monitor-fn-'));
  const home = join(root, 'HOME');
  const project = join(root, 'project');
  mkdirSync(join(project, '.cx'), { recursive: true });
  writeFileSync(join(project, '.cx', 'context.md'), '# test project\n');
  mkdirSync(home, { recursive: true });
  tmpDirs.push(root);
  return { root, home, project };
}
after(() => {
  for (const dir of tmpDirs) {
    try { rmTmpDir(dir); } catch { /* best-effort cleanup */ }
  }
});

function runMonitor(args, { home, project }) {
  return spawnSync(process.execPath, [BIN, 'monitor', ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30_000,
    env: sterileSpawnEnv({ HOME: home, USERPROFILE: home, CX_HOME_OVERRIDE: home }),
  });
}

test('construct monitor with no --as/--targets prints usage and writes nothing', () => {
  const { home, project } = sandbox();
  const res = runMonitor([], { home, project });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Usage: construct monitor/);
  assert.equal(existsSync(join(project, 'construct.config.json')), false);
  assert.equal(existsSync(join(project, 'embed.yaml')), false);
});

test('construct monitor rejects an unknown --as capability and writes nothing', () => {
  const { home, project } = sandbox();
  const res = runMonitor(['--as', 'not-a-real-capability', '--targets', 'github:acme/api', '--no-start'], { home, project });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown capability "not-a-real-capability"/);
  assert.match(res.stderr, /operations/);
  assert.equal(existsSync(join(project, 'construct.config.json')), false);
  assert.equal(existsSync(join(project, 'embed.yaml')), false);
});

test('construct monitor --as operations --targets ... assembles all three durable artifacts and prints a summary', () => {
  const { home, project } = sandbox();
  const res = runMonitor(
    ['--as', 'operations', '--targets', 'github:acme/api,jira:PLAT', '--no-start'],
    { home, project },
  );
  assert.equal(res.status, 0, `exit 0 — stderr: ${res.stderr}`);

  // construct.config.json sources.targets[]
  const cfgPath = join(project, 'construct.config.json');
  assert.ok(existsSync(cfgPath), 'construct.config.json exists');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const targets = cfg.sources?.targets ?? [];
  assert.equal(targets.length, 2);
  const github = targets.find((t) => t.provider === 'github');
  const jira = targets.find((t) => t.provider === 'jira');
  assert.equal(github.selector.repo, 'acme/api');
  assert.equal(jira.selector.project, 'PLAT');
  assert.match(github.id, /^monitor-github-/);

  // embed.yaml roles{} + sources:
  const embedYamlPath = join(project, 'embed.yaml');
  assert.ok(existsSync(embedYamlPath), 'embed.yaml exists');
  const embedYaml = readFileSync(embedYamlPath, 'utf8');
  assert.match(embedYaml, /roles:/);
  assert.match(embedYaml, /primary: operations/);
  assert.match(embedYaml, /provider: github/);
  assert.match(embedYaml, /provider: jira/);

  // .cx/embed/<id>.manifest.json, enabled
  const manifestPath = join(project, '.cx', 'embed', 'operations.manifest.json');
  assert.ok(existsSync(manifestPath), 'capability manifest exists');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.embed.enabled, true);
  assert.equal(manifest.embed.specialist, 'cx-operations');

  // Prints a summary naming the durable artifacts it wrote.
  assert.match(res.stdout, /construct monitor: assembled/);
  assert.match(res.stdout, /construct\.config\.json/);
  assert.match(res.stdout, /embed\.yaml/);
  assert.match(res.stdout, /operations\.manifest\.json/);
  assert.match(res.stdout, /not started \(--no-start\)/);
});

test('construct monitor is idempotent: re-running with the same --targets upserts rather than erroring on duplicate ids', () => {
  const { home, project } = sandbox();
  const first = runMonitor(['--as', 'operations', '--targets', 'github:acme/api', '--no-start'], { home, project });
  assert.equal(first.status, 0, `first run exit 0 — stderr: ${first.stderr}`);

  const second = runMonitor(['--as', 'operations', '--targets', 'github:acme/api', '--no-start'], { home, project });
  assert.equal(second.status, 0, `second run exit 0 — stderr: ${second.stderr}`);

  const cfg = JSON.parse(readFileSync(join(project, 'construct.config.json'), 'utf8'));
  assert.equal(cfg.sources.targets.length, 1, 're-running with the same target must not duplicate it');
});

test('construct monitor --as pm-feedback sets embed.yaml roles.primary from that capability\'s specialist', () => {
  const { home, project } = sandbox();
  const res = runMonitor(['--as', 'pm-feedback', '--targets', 'jira:PLAT', '--no-start'], { home, project });
  assert.equal(res.status, 0, `exit 0 — stderr: ${res.stderr}`);

  const embedYaml = readFileSync(join(project, 'embed.yaml'), 'utf8');
  assert.match(embedYaml, /primary: product-manager/);

  const manifestPath = join(project, '.cx', 'embed', 'pm-feedback.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.embed.specialist, 'cx-product-manager');
  assert.equal(manifest.embed.enabled, true);
});
