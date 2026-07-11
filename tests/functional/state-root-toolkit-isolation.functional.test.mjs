/**
 * tests/functional/state-root-toolkit-isolation.functional.test.mjs
 *
 * Pins that machine-scoped heavy state (ADR-0066) is anchored to the user
 * home and never follows CX_TOOLKIT_DIR into the toolkit install root or the
 * project working tree. Regression coverage for the stray
 * `<repo>/projects/<key>/lancedb` observed 2026-07-10: state-root resolved its
 * base from constructDir(), so any process carrying CX_TOOLKIT_DIR (every
 * managed MCP entry sets it, and test suites exported it pointing at the repo)
 * dropped the LanceDB vector store inside the working tree.
 *
 * Spawns real child processes (no mocks) against the real lib/state-root.mjs
 * and lib/storage/vector-client.mjs, with all writes confined to mkdtemp
 * fixtures per the isolation contract in tests/functional/README.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { assertPathUnderRoot } from '../helpers/isolation-contract.mjs';
import { deriveProjectKey } from '../../lib/state-root.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeFixture() {
  const project = mkdtempSync(join(tmpdir(), 'cx-state-iso-project-'));
  const toolkit = mkdtempSync(join(tmpdir(), 'cx-state-iso-toolkit-'));
  const home = mkdtempSync(join(tmpdir(), 'cx-state-iso-home-'));
  mkdirSync(join(project, '.cx'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project });
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.com/cx/state-iso.git'], { cwd: project });
  return {
    project,
    toolkit,
    home,
    cleanup: () => {
      rmTmpDir(project);
      rmTmpDir(toolkit);
      rmTmpDir(home);
    },
  };
}

function runChild(script, { cwd, env }) {
  const scriptPath = join(cwd, '_probe.mjs');
  writeFileSync(scriptPath, script);
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8', timeout: 120_000, env });
}

test('resolveStateRoot ignores CX_TOOLKIT_DIR and anchors to the user home', (t) => {
  const { project, toolkit, home, cleanup } = makeFixture();
  t.after(cleanup);

  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'lib', 'state-root.mjs')).href;
  const result = runChild(
    `import { resolveStateRoot } from ${JSON.stringify(moduleUrl)};\n`
    + `process.stdout.write(resolveStateRoot(process.cwd(), { ensureDir: false }));\n`,
    { cwd: project, env: sterileSpawnEnv({ HOME: home, CX_TOOLKIT_DIR: toolkit }) },
  );
  assert.equal(result.status, 0, `probe failed: ${result.stderr}`);

  const stateRoot = result.stdout.trim();
  const key = deriveProjectKey(project);
  assert.equal(stateRoot, join(home, '.construct', 'projects', key));
  assertPathUnderRoot(stateRoot, home, 'per-project state root');
});

test('a LanceDB connect with CX_TOOLKIT_DIR set lands under the home state root, never the toolkit or project tree', (t) => {
  const { project, toolkit, home, cleanup } = makeFixture();
  t.after(cleanup);

  // The real vector client, the real @lancedb driver, a real on-disk database
  // — the durable artifact this asserts on is the directory LanceDB creates on
  // connect, exactly what polluted the repo root in the original incident.

  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'lib', 'storage', 'vector-client.mjs')).href;
  const result = runChild(
    `import { VectorClient } from ${JSON.stringify(moduleUrl)};\n`
    + `const client = new VectorClient();\n`
    + `await client._getDb();\n`
    + `await client.close();\n`
    + `process.stdout.write('connected');\n`,
    { cwd: project, env: sterileSpawnEnv({ HOME: home, CX_TOOLKIT_DIR: toolkit }) },
  );
  assert.equal(result.status, 0, `vector connect failed: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'connected');

  assert.equal(existsSync(join(toolkit, 'projects')), false,
    'CX_TOOLKIT_DIR must never accumulate per-project state (projects/ under the toolkit root)');
  assert.equal(existsSync(join(project, 'projects')), false,
    'the project working tree must never accumulate per-project state (projects/ at the repo root)');

  const key = deriveProjectKey(project);
  const expected = join(home, '.construct', 'projects', key, 'lancedb');
  assert.ok(existsSync(expected), `expected the vector store at ${expected}`);
  assertPathUnderRoot(expected, home, 'lancedb directory');
});

test('resolveSharedRuntimeDir ignores CX_TOOLKIT_DIR and anchors to the user home', (t) => {
  const { project, toolkit, home, cleanup } = makeFixture();
  t.after(cleanup);

  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'lib', 'state-root.mjs')).href;
  const result = runChild(
    `import { resolveSharedRuntimeDir } from ${JSON.stringify(moduleUrl)};\n`
    + `process.stdout.write(resolveSharedRuntimeDir('docling', { ensureDir: false }));\n`,
    { cwd: project, env: sterileSpawnEnv({ HOME: home, CX_TOOLKIT_DIR: toolkit }) },
  );
  assert.equal(result.status, 0, `probe failed: ${result.stderr}`);

  const runtimeDir = result.stdout.trim();
  assert.equal(runtimeDir, join(home, '.construct', 'runtime', 'docling'));
  assertPathUnderRoot(runtimeDir, home, 'shared runtime directory');
});
