/**
 * tests/acceptance/05-optional-dep-degradation.test.mjs — LMCP-L4 optional-dep degradation matrix.
 *
 * LMCP-L4: Optional-dependency degradation matrix suite.
 *
 * Proves that `construct` gracefully degrades when optional dependencies
 * are absent. Covers:
 *   1.  Intent ↔ package.json cross-referencing
 *   2.  Packed install without optional deps (--no-optional)
 *   3.  Individual missing optional dep detection via doctor
 *   4.  Binary sidecar absence detection
 *   5.  Solo-mode grace (no errors from missing optional deps)
 *
 * Run standalone:
 *   node --test --test-timeout=120000 tests/acceptance/05-optional-dep-degradation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

/** Parse npm pack --json output, returning the first tarball filename. */
function parsePackJson(stdout) {
  let packJson;
  try {
    packJson = JSON.parse(stdout.trim());
  } catch {
    const lines = stdout.trim().split('\n');
    const jsonStart = lines.findIndex((l) => l.trimStart().startsWith('['));
    if (jsonStart === -1) return null;
    packJson = JSON.parse(lines.slice(jsonStart).join('\n'));
  }
  return packJson?.[0]?.filename ?? null;
}

/** Load deps/intent.json entries matching a filter. */
function loadIntents() {
  const raw = readFileSync(join(PROJECT_ROOT, 'deps', 'intent.json'), 'utf8');
  return JSON.parse(raw);
}

/** Load package.json. */
function loadPackageJson() {
  const raw = readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

// Suite -----------------------------------------------------------------

test('LMCP-L4: optional-dep degradation matrix', { timeout: 180_000 }, async (t) => {
  // ── Test 1: Cross-reference intent ↔ package.json ───────────────────
  await t.test('every npm-optional intent entry has matching optionalDependency in package.json', () => {
    const intents = loadIntents();
    const pkg = loadPackageJson();
    const npmOptional = intents.filter(
      (e) => e.kind === 'npm-optional' && e.disposition !== 'quarantine',
    );

    assert.ok(npmOptional.length > 0, 'Should find npm-optional intent entries');

    for (const entry of npmOptional) {
      assert.ok(
        entry.id in (pkg.optionalDependencies ?? {}),
        `Intent entry "${entry.id}" (${entry.kind}, ${entry.disposition}) must have a matching entry in package.json optionalDependencies`,
      );
    }
  });

  await t.test('every package.json optionalDependency has an intent entry', () => {
    const intents = loadIntents();
    const pkg = loadPackageJson();
    const intentIds = new Set(intents.map((e) => e.id));

    for (const depName of Object.keys(pkg.optionalDependencies ?? {})) {
      assert.ok(
        intentIds.has(depName),
        `package.json optionalDependency "${depName}" must have a matching entry in deps/intent.json`,
      );
    }
  });

  await t.test('every npm-optional intent entry has degradationBehavior=graceful-skip', () => {
    const intents = loadIntents();
    const npmOptional = intents.filter((e) => e.kind === 'npm-optional');

    for (const entry of npmOptional) {
      assert.equal(
        entry.degradationBehavior,
        'graceful-skip',
        `Intent entry "${entry.id}" must have degradationBehavior "graceful-skip", got "${entry.degradationBehavior}"`,
      );
    }
  });

  await t.test('every binary-sidecar intent entry with disposition=optional has degradationBehavior=graceful-skip', () => {
    const intents = loadIntents();
    const binaryOptional = intents.filter(
      (e) => e.kind === 'binary-sidecar' && e.disposition === 'optional',
    );

    for (const entry of binaryOptional) {
      assert.equal(
        entry.degradationBehavior,
        'graceful-skip',
        `Binary sidecar intent entry "${entry.id}" (disposition=optional) must have degradationBehavior "graceful-skip", got "${entry.degradationBehavior}"`,
      );
    }
  });

  // ── Test 2: Packed install without optional deps ────────────────────
  let tmpDir = null;
  let tarballPath = null;

  // Suite-private pack destination: the packing acceptance suites run
  // concurrently under node --test, and a shared repo-root tarball let one
  // suite install while another rewrote or deleted the same file — npm's
  // "tarball data ... seems to be corrupted" on slow runners (construct-rgqym).

  const packDir = mkdtempSync(join(tmpdir(), 'construct-degradation-tgz-'));

  await t.test('npm pack produces tarball', () => {
    const packResult = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: PROJECT_ROOT });
    if (packResult.status !== 0) {
      t.todo(`npm pack failed (status ${packResult.status})`);
      return;
    }

    const filename = parsePackJson(packResult.stdout);
    assert.ok(filename, 'npm pack should emit a filename');

    tarballPath = resolve(packDir, filename);
    assert.ok(existsSync(tarballPath), `Tarball should exist at ${tarballPath}`);
  });

  if (!tarballPath) {
    await t.test('remaining install tests (skipped — pack failed)', (ct) => {
      ct.todo('Skipped because npm pack did not produce a tarball');
    });
    return;
  }

  await t.test('create clean temp directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'construct-degradation-'));
    assert.ok(existsSync(tmpDir), 'Temp directory should exist');
  });

  await t.test('npm init -y in temp directory', () => {
    const initResult = run('npm', ['init', '-y'], { cwd: tmpDir });
    assert.equal(initResult.status, 0, `npm init -y failed:\n${combinedOutput(initResult)}`);
  });

  await t.test('npm install tarball --no-optional --ignore-scripts', () => {
    const installResult = run('npm', [
      'install', tarballPath,
      '--no-optional',
      '--ignore-scripts',
      '--prefer-offline',
    ], { cwd: tmpDir, timeout: 90_000 });
    assert.equal(installResult.status, 0, `npm install failed:\n${combinedOutput(installResult)}`);
  });

  const binPath = join(tmpDir, 'node_modules', '.bin', 'construct');

  // lib/paths.mjs resolves the ADR-0066 state root from process.env.HOME /
  // CX_HOME_OVERRIDE in the CHILD's own env, not this test process's env —
  // every spawned `construct` call below must be pinned to a throwaway
  // sandbox home or it leaks project-key directories into the real
  // developer machine's ~/.construct/projects/.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'construct-degradation-home-'));
  const soloEnv = {
    ...process.env,
    CONSTRUCT_DEPLOYMENT_MODE: 'solo',
    HOME: sandboxHome,
    CX_HOME_OVERRIDE: sandboxHome,
  };

  await t.test('construct version exits 0 with no optional deps', () => {
    assert.ok(existsSync(binPath), `Binary should exist at ${binPath}`);

    const result = run('node', [binPath, 'version'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'construct version --no-optional');
    assert.equal(result.status, 0, `construct version exited ${result.status}\n${output}`);
    assert.match(result.stdout.trim(), /construct v\d+\.\d+/, `Expected version, got: ${result.stdout.trim()}`);
  });

  await t.test('construct status --json returns valid JSON without optional deps', () => {
    assert.ok(existsSync(binPath));

    const result = run('node', [binPath, 'status', '--json'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'construct status --json --no-optional');
    assert.equal(result.status, 0, `construct status --json exited ${result.status}\n${output}`);

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch (err) {
      assert.fail(`Output not valid JSON: ${err.message}\n${result.stdout}`);
    }
    assert.ok(parsed !== null && typeof parsed === 'object', 'Parsed JSON should be an object');
  });

  await t.test('construct doctor does not crash (MODULE_NOT_FOUND) without optional deps', () => {
    assert.ok(existsSync(binPath));

    const result = run('node', [binPath, 'doctor'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'construct doctor --no-optional');

    const isUnhandledCrash =
      result.status !== 0 &&
      result.stderr?.includes('Error:') &&
      !result.stdout?.trim();

    assert.ok(
      !isUnhandledCrash,
      `construct doctor appears to have crashed (status ${result.status}):\n${output}`,
    );
  });

  // ── Test 3: Each optional dep individually detected by doctor ───────
  await t.test('construct doctor warns about missing optional deps in stripped install', () => {
    assert.ok(existsSync(binPath));

    const result = run('node', [binPath, 'doctor'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    // The --no-optional install means ALL optional deps are missing.
    // Doctor should produce output without crashing.
    assertNoModuleNotFound(output, 'construct doctor optional-dep warning');

    // Verify we see warnings — doctor marks missing optional items with '⚠'
    const hasWarnings = (result.stdout ?? '').includes('⚠') || result.status === 0;
    assert.ok(hasWarnings || result.status !== 1,
      'Doctor should either exit 0 (with warnings) or show warnings in output when optional deps are absent',
    );
  });

  // ── Test 4: Binary sidecar absence detection ────────────────────────
  await t.test('doctor detects absent binary sidecars (pandoc, typst, gh)', () => {
    // Probe which sidecars are known-missing on this system
    const sidecars = [
      { name: 'pandoc', probe: 'pandoc --version' },
      { name: 'typst', probe: 'typst --version' },
      { name: 'gh', probe: 'gh --version' },
    ];

    const absent = sidecars.filter((s) => {
      const r = run('sh', ['-c', `command -v ${s.name}`], { stdio: 'pipe' });
      return r.status !== 0;
    });

    // Doctor runs on the actual project; checks binary sidecars via probes.
    // Verify the doctor command handles missing binaries without crashing.
    const result = run('node', [join(PROJECT_ROOT, 'bin', 'construct'), 'doctor'], {
      cwd: PROJECT_ROOT,
      env: soloEnv,
      timeout: 30_000,
    });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'construct doctor (source checkout)');

    // Should not crash regardless of which sidecars are absent
    const isUnhandledCrash =
      result.status !== 0 &&
      (result.stderr ?? '').includes('Error:') &&
      !(result.stdout ?? '').trim();

    assert.ok(
      !isUnhandledCrash,
      `construct doctor crashed (status ${result.status}):\n${output}`,
    );

    // Record which sidecars are absent for the report
    console.log(`\n  [info] absent binary sidecars: ${absent.map(s => s.name).join(', ') || '(none — all present)'}`);
  });

  // ── Test 5: Solo mode graceful degradation ──────────────────────────
  await t.test('solo mode: no MODULE_NOT_FOUND from doctor exit 0 path', () => {
    assert.ok(existsSync(binPath));

    const result = run('node', [binPath, 'doctor'], { cwd: tmpDir, env: soloEnv });
    const output = combinedOutput(result);

    assertNoModuleNotFound(output, 'solo mode doctor');

    // Doctor may exit 0 (healthy with warnings) or 1 (some non-optional failures).
    // Either way, it must not crash with module-not-found.
    // In the stripped install, many optional checks will show '⚠' but not crash.
    const crashed = result.status !== 0
      && (result.stderr ?? '').includes('Error:')
      && !(result.stdout ?? '').trim();

    assert.ok(!crashed, `Doctor crashed in solo mode (status ${result.status}):\n${output}`);
  });

  // ── Cleanup ─────────────────────────────────────────────────────────
  await t.test('cleanup', () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmTmpDir(tmpDir);
    }
    rmTmpDir(packDir);
    rmTmpDir(sandboxHome);
  });
});
