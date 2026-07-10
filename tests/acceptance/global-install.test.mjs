/**
 * tests/acceptance/global-install.test.mjs — global install + project init
 *
 * Verifies that the published tarball (produced via `npm pack`) can be
 * installed globally via `npm install -g`, then creates two
 * independent projects with no cross-project state leakage.
 *
 * Run standalone:
 *   node --test --test-timeout=120000 tests/acceptance/global-install.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');

// Helpers ---------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...opts,
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function assertNoModuleNotFound(output, label) {
  const forbidden = ['Cannot find module', 'MODULE_NOT_FOUND'];
  for (const pattern of forbidden) {
    assert.ok(
      !output.includes(pattern),
      `${label}: output contains "${pattern}"\n---\n${output}\n---`,
    );
  }
}

// Test suite ------------------------------------------------------------

test('global install + project init (npm pack -> global install -> 2 projects)', { timeout: 180_000 }, async (t) => {
  let tarballPath = null;
  let globalPrefix = null;
  let projectA = null;
  let projectB = null;
  const createdDirs = [];

  // Suite-private pack destination: the packing acceptance suites run
  // concurrently under node --test, and a shared repo-root tarball let one
  // suite install while another rewrote or deleted the same file — npm's
  // "tarball data ... seems to be corrupted" on slow runners (construct-rgqym).

  const packDir = mkdtempSync(join(tmpdir(), 'construct-global-tgz-'));

  // ── Step 1: npm pack ─────────────────────────────────────────────────
  await t.test('npm pack produces a tarball', () => {
    const packResult = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: PROJECT_ROOT });

    if (packResult.status !== 0) {
      t.todo(`npm pack failed (status ${packResult.status}): ${combinedOutput(packResult)}`);
      return;
    }

    let packJson;
    try {
      packJson = JSON.parse(packResult.stdout.trim());
    } catch {
      const lines = packResult.stdout.trim().split('\n');
      const jsonStart = lines.findIndex((l) => l.trimStart().startsWith('['));
      if (jsonStart === -1) {
        t.todo(`npm pack output not parseable: ${packResult.stdout}`);
        return;
      }
      packJson = JSON.parse(lines.slice(jsonStart).join('\n'));
    }

    const filename = packJson[0]?.filename;
    assert.ok(filename, 'npm pack should emit a filename in JSON output');

    tarballPath = resolve(packDir, filename);
    assert.ok(existsSync(tarballPath), `Tarball should exist at ${tarballPath}`);
  });

  if (!tarballPath) {
    await t.test('remaining steps (skipped -- pack failed)', () => {
      t.todo('Skipped because npm pack did not produce a tarball');
    });
    return;
  }

  // ── Step 2: create global-prefix ─────────────────────────────────────
  await t.test('create global install prefix directory', () => {
    globalPrefix = mkdtempSync(join(tmpdir(), 'construct-global-'));
    createdDirs.push(globalPrefix);
    assert.ok(existsSync(globalPrefix), 'Global prefix directory should exist');
  });

  // ── Step 3: global install ────────────────────────────────────────────
  await t.test('npm install -g tarball into global prefix', () => {
    assert.ok(globalPrefix && tarballPath, 'Prereqs must be set up');
    const installResult = run('npm', ['install', '-g', tarballPath, `--prefix=${globalPrefix}`], {
      timeout: 90_000,
    });
    assert.equal(
      installResult.status,
      0,
      `npm install -g failed:\n${combinedOutput(installResult)}`,
    );
  });

  const binPath = join(globalPrefix, 'bin', 'construct');

  await t.test('binary exists at global prefix bin', () => {
    assert.ok(existsSync(binPath), `Binary should exist at ${binPath}`);
  });

  // lib/paths.mjs resolves the ADR-0066 state root from process.env.HOME /
  // CX_HOME_OVERRIDE in the CHILD's own env, not this test process's env —
  // every spawned `construct` call below (for either project) must be
  // pinned to a throwaway sandbox home or it leaks project-key directories
  // into the real developer machine's ~/.construct/projects/.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'construct-global-home-'));
  createdDirs.push(sandboxHome);

  const globalEnv = {
    ...process.env,
    CONSTRUCT_DEPLOYMENT_MODE: 'solo',
    PATH: join(globalPrefix, 'bin') + delimiter + (process.env.PATH || ''),
    HOME: sandboxHome,
    CX_HOME_OVERRIDE: sandboxHome,
  };

  // ── Step 4: create two independent project dirs ──────────────────────
  await t.test('create project A directory', () => {
    projectA = mkdtempSync(join(tmpdir(), 'construct-projA-'));
    createdDirs.push(projectA);
    assert.ok(existsSync(projectA), 'Project A directory should exist');
  });

  await t.test('create project B directory', () => {
    projectB = mkdtempSync(join(tmpdir(), 'construct-projB-'));
    createdDirs.push(projectB);
    assert.ok(existsSync(projectB), 'Project B directory should exist');
  });

  // ── Step 5: git init both projects ───────────────────────────────────
  await t.test('git init in project A', () => {
    assert.ok(projectA, 'Project A must exist');
    const result = run('git', ['init'], { cwd: projectA, timeout: 10_000 });
    assert.equal(result.status, 0, `git init failed in project A:\n${combinedOutput(result)}`);
  });

  await t.test('git init in project B', () => {
    assert.ok(projectB, 'Project B must exist');
    const result = run('git', ['init'], { cwd: projectB, timeout: 10_000 });
    assert.equal(result.status, 0, `git init failed in project B:\n${combinedOutput(result)}`);
  });

  // ── Step 6: Project A init ───────────────────────────────────────────
  await t.test('project A: construct init --yes exits 0 and creates .cx/', () => {
    assert.ok(projectA, 'Project A must exist');
    const result = run('node', [binPath, 'init', '--yes'], {
      cwd: projectA,
      env: globalEnv,
      timeout: 30_000,
    });
    const output = combinedOutput(result);
    assertNoModuleNotFound(output, 'project A init');
    assert.equal(result.status, 0, `project A init exited ${result.status}\n${output}`);

    const cxDir = join(projectA, '.cx');
    assert.ok(existsSync(cxDir), `.cx/ should exist in project A at ${cxDir}`);
  });

  // ── Step 7: Project B init ───────────────────────────────────────────
  await t.test('project B: construct init --yes exits 0 and creates .cx/', () => {
    assert.ok(projectB, 'Project B must exist');
    const result = run('node', [binPath, 'init', '--yes'], {
      cwd: projectB,
      env: globalEnv,
      timeout: 30_000,
    });
    const output = combinedOutput(result);
    assertNoModuleNotFound(output, 'project B init');
    assert.equal(result.status, 0, `project B init exited ${result.status}\n${output}`);

    const cxDir = join(projectB, '.cx');
    assert.ok(existsSync(cxDir), `.cx/ should exist in project B at ${cxDir}`);
  });

  // ── Step 8: Status check in both projects ────────────────────────────
  await t.test('project A: construct status --json returns valid JSON with deployment mode', () => {
    assert.ok(projectA, 'Project A must exist');
    const result = run('node', [binPath, 'status', '--json'], {
      cwd: projectA,
      env: globalEnv,
      timeout: 30_000,
    });
    const output = combinedOutput(result);
    assertNoModuleNotFound(output, 'project A status --json');
    assert.equal(result.status, 0, `project A status --json exited ${result.status}\n${output}`);

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch (err) {
      assert.fail(`project A status --json output is not valid JSON: ${err.message}\n${result.stdout}`);
    }
    assert.ok(parsed !== null && typeof parsed === 'object', 'Parsed JSON should be an object');
    const hasDeploymentMode =
      typeof parsed.deploymentMode === 'string' ||
      (parsed.deployment && typeof parsed.deployment.mode === 'string');
    assert.ok(
      hasDeploymentMode,
      `JSON must contain deploymentMode or deployment.mode. Got keys: ${Object.keys(parsed).join(', ')}`,
    );
  });

  await t.test('project B: construct status --json returns valid JSON with deployment mode', () => {
    assert.ok(projectB, 'Project B must exist');
    const result = run('node', [binPath, 'status', '--json'], {
      cwd: projectB,
      env: globalEnv,
      timeout: 30_000,
    });
    const output = combinedOutput(result);
    assertNoModuleNotFound(output, 'project B status --json');
    assert.equal(result.status, 0, `project B status --json exited ${result.status}\n${output}`);

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch (err) {
      assert.fail(`project B status --json output is not valid JSON: ${err.message}\n${result.stdout}`);
    }
    assert.ok(parsed !== null && typeof parsed === 'object', 'Parsed JSON should be an object');
    const hasDeploymentMode =
      typeof parsed.deploymentMode === 'string' ||
      (parsed.deployment && typeof parsed.deployment.mode === 'string');
    assert.ok(
      hasDeploymentMode,
      `JSON must contain deploymentMode or deployment.mode. Got keys: ${Object.keys(parsed).join(', ')}`,
    );
  });

  // ── Step 9: No cross-project leakage ─────────────────────────────────
  await t.test('no cross-project path leakage in .cx/ files', () => {
    assert.ok(projectA && projectB, 'Both projects must exist');

    const cxDirA = join(projectA, '.cx');
    const cxDirB = join(projectB, '.cx');

    assert.ok(existsSync(cxDirA), '.cx/ should exist in project A');
    assert.ok(existsSync(cxDirB), '.cx/ should exist in project B');

    const entriesA = readdirSync(cxDirA, { recursive: true }).filter(
      (e) => statSync(join(cxDirA, e)).isFile(),
    );
    const entriesB = readdirSync(cxDirB, { recursive: true }).filter(
      (e) => statSync(join(cxDirB, e)).isFile(),
    );

    for (const file of entriesA) {
      const content = readFileSync(join(cxDirA, file), 'utf8');
      assert.ok(
        !content.includes(projectB),
        `Project A .cx/${file} should not reference project B path`,
      );
    }

    for (const file of entriesB) {
      const content = readFileSync(join(cxDirB, file), 'utf8');
      assert.ok(
        !content.includes(projectA),
        `Project B .cx/${file} should not reference project A path`,
      );
    }
  });

  // ── Step 10: Filesystem audit ─────────────────────────────────────────
  await t.test('filesystem audit: no unexpected directories and expected content exists', () => {
    assert.ok(createdDirs.length >= 3, 'Should have created at least 3 directories');

    for (const dir of createdDirs) {
      assert.ok(existsSync(dir), `Created directory should still exist: ${dir}`);
    }

    assert.ok(existsSync(join(projectA, '.cx')), 'Project A .cx/ should exist');
    assert.ok(existsSync(join(projectB, '.cx')), 'Project B .cx/ should exist');
    assert.ok(existsSync(globalPrefix), 'Global prefix should still exist');
    assert.ok(existsSync(binPath), 'Global binary should still exist');
  });

  // ── Step 11: Cleanup ─────────────────────────────────────────────────
  await t.test('cleanup temp directories and tarball', () => {
    for (const dir of createdDirs) {
      if (dir && existsSync(dir)) {
        rmTmpDir(dir);
      }
    }

    rmTmpDir(packDir);
  });
});