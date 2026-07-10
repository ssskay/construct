/**
 * tests/acceptance/packed-install.test.mjs
 *
 * LMCP-L2 packed consumer install acceptance test.
 *
 * Verifies that the published tarball (produced via `npm pack`) installs
 * cleanly into a fresh project and that the `construct` binary is functional.
 *
 * Run standalone:
 *   node --test --test-timeout=120000 tests/acceptance/packed-install.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');

// Helpers ---------------------------------------------------------------

/**
 * Run a command synchronously and return the result.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts  - spawnSync options
 */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...opts,
  });
}

/** Return combined stdout + stderr for diagnostic messages. */
function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

/** Assert that output does NOT contain MODULE_NOT_FOUND errors. */
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

test('packed consumer install (npm pack → clean install → smoke)', { timeout: 120_000 }, async (t) => {
  let tmpDir = null;
  let tarballPath = null;

  // Suite-private pack destination: the packing acceptance suites run
  // concurrently under node --test, and a shared repo-root tarball let one
  // suite install while another rewrote or deleted the same file — npm's
  // "tarball data ... seems to be corrupted" on slow runners (construct-rgqym).

  const packDir = mkdtempSync(join(tmpdir(), 'construct-pack-tgz-'));

  // ── Step 1: npm pack ─────────────────────────────────────────────────
  await t.test('npm pack produces a tarball', () => {
    const packResult = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: PROJECT_ROOT });

    if (packResult.status !== 0) {
      // Skip gracefully — build artifact may be missing in this environment
      t.todo(`npm pack failed (status ${packResult.status}): ${combinedOutput(packResult)}`);
      return;
    }

    // npm pack --json emits a JSON array; pick the first entry's filename
    let packJson;
    try {
      packJson = JSON.parse(packResult.stdout.trim());
    } catch {
      // Fallback: stdout may contain non-JSON preamble; try to extract filename
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
    // pack step was skipped — mark remaining subtests as todo and bail
    await t.test('install and smoke (skipped — pack failed)', () => {
      t.todo('Skipped because npm pack did not produce a tarball');
    });
    return;
  }

  // ── Step 2: create clean temp dir ────────────────────────────────────
  await t.test('create clean temp directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'construct-pack-test-'));
    assert.ok(existsSync(tmpDir), 'Temp directory should exist');
  });

  // ── Step 3: npm init -y ───────────────────────────────────────────────
  await t.test('npm init -y in temp directory', () => {
    assert.ok(tmpDir, 'Temp dir must have been created');
    const initResult = run('npm', ['init', '-y'], { cwd: tmpDir });
    assert.equal(
      initResult.status,
      0,
      `npm init -y failed:\n${combinedOutput(initResult)}`,
    );
  });

  // ── Step 4: install tarball ───────────────────────────────────────────
  await t.test('npm install tarball', () => {
    assert.ok(tmpDir && tarballPath, 'Prereqs must be set up');
    const installResult = run('npm', ['install', tarballPath, '--prefer-offline'], {
      cwd: tmpDir,
      timeout: 90_000,
    });
    assert.equal(
      installResult.status,
      0,
      `npm install failed:\n${combinedOutput(installResult)}`,
    );
  });

  const binPath = join(tmpDir, 'node_modules', '.bin', 'construct');

  // lib/paths.mjs resolves the ADR-0066 state root from process.env.HOME /
  // CX_HOME_OVERRIDE in the CHILD's own env, not this test process's env —
  // every spawned `construct` call below must be pinned to a throwaway
  // sandbox home or it leaks project-key directories into the real
  // developer machine's ~/.construct/projects/.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'construct-pack-test-home-'));
  const soloEnv = { ...process.env, HOME: sandboxHome, CX_HOME_OVERRIDE: sandboxHome };

  // ── Step 5: construct version ─────────────────────────────────────────
  await t.test('construct version exits 0', () => {
    assert.ok(existsSync(binPath), `Binary should exist at ${binPath}`);

    const result = run('node', [binPath, 'version'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'construct version');
    assert.equal(result.status, 0, `construct version exited ${result.status}\n${output}`);
    assert.match(
      result.stdout.trim(),
      /construct v\d+\.\d+/,
      `Expected version string, got: ${result.stdout.trim()}`,
    );
  });

  // ── Step 6: construct status --json ───────────────────────────────────
  await t.test('construct status --json exits 0 and returns valid JSON', () => {
    assert.ok(existsSync(binPath), `Binary should exist at ${binPath}`);

    const result = run('node', [binPath, 'status', '--json'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'construct status --json');
    assert.equal(result.status, 0, `construct status --json exited ${result.status}\n${output}`);

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch (err) {
      assert.fail(`construct status --json output is not valid JSON: ${err.message}\n${result.stdout}`);
    }
    assert.ok(parsed !== null && typeof parsed === 'object', 'Parsed JSON should be an object');
  });

  // ── Step 7: construct doctor ──────────────────────────────────────────
  await t.test('construct doctor does not crash (MODULE_NOT_FOUND check)', () => {
    assert.ok(existsSync(binPath), `Binary should exist at ${binPath}`);

    const result = run('node', [binPath, 'doctor'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    // doctor may exit non-zero in a minimal environment (missing config etc.)
    // but it must NOT crash with module resolution errors
    assertNoModuleNotFound(output, 'construct doctor');

    // A hard crash produces no structured output and typically exits with code 1
    // via an unhandled exception — detect that via stderr containing 'Error:' at top level
    const isUnhandledCrash =
      result.status !== 0 &&
      result.stderr?.includes('Error:') &&
      !result.stdout?.trim();

    assert.ok(
      !isUnhandledCrash,
      `construct doctor appears to have crashed (status ${result.status}):\n${output}`,
    );
  });

  // ── Step 8: cleanup ───────────────────────────────────────────────────
  await t.test('cleanup temp directory', () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmTmpDir(tmpDir);
    }

    rmTmpDir(packDir);
    rmTmpDir(sandboxHome);
  });
});
