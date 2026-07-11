/**
 * lib/runtime/uv-bootstrap.mjs — idempotent uv + docling venv provisioner.
 *
 * One venv per machine, not one per project (construct-rf26.16; ADR-0066
 * called this out as the docling venv's terminal shape). On first use:
 * downloads uv via the official Astral installer, creates
 * `~/.construct/runtime/docling/.venv` via `resolveSharedRuntimeDir`,
 * installs the pinned docling release.
 * Subsequent calls from any project on this machine are no-ops once the
 * venv is present — there is no project key anywhere in this path.
 *
 * Version pin is the lockfile: `.install-marker.json`'s `doclingVersion`
 * field is compared against DOCLING_PIN on every call. A mismatch (a
 * construct upgrade that bumps the pin) is not silent drift — it clears the
 * stale venv directory and re-provisions from scratch under `force`
 * semantics, rather than layering a new install over an old one.
 *
 * Best-practice notes (2026-06):
 *   - uv (Astral) is the consensus Python tooling, ~10× faster than pip, single
 *     binary, lockfile-based. OpenAI acquired Astral on 2026-03-19; the project
 *     remains Apache-2.0 and actively maintained, but single-vendor governance
 *     is a documented concern — flagged for re-evaluation if licensing shifts.
 *   - docling (IBM, MIT, donated to LF AI & Data early 2026) is the consensus
 *     multi-format doc parser for layout-aware MD/JSON output.
 *
 * Returns the path to the venv's python binary so callers can spawn the
 * sidecar without relying on PATH state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import { resolveSharedRuntimeDir } from '../state-root.mjs';

const DOCLING_PIN = '2.45.0';
const UV_INSTALL_URL = 'https://astral.sh/uv/install.sh';
const UV_TIMEOUT_MS = 120_000;
const VENV_TIMEOUT_MS = 240_000;
const INSTALL_TIMEOUT_MS = 600_000;

// ensureDir:false — shared by the provisioner (ensureDoclingVenv, which
// already mkdirs before it writes) and the read-only detector
// (describeDoclingRuntime); a detect-only call must not conjure the dir.

export function defaultRuntimeDir() {
  return resolveSharedRuntimeDir('docling', { ensureDir: false });
}

function which(bin) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim().split('\n')[0] || null;
}

// Provisioning runs on the request path (the first docling ingest), including
// inside the long-lived MCP server. spawnSync would block the event loop for the
// whole multi-minute install — freezing every other request and defeating the
// per-tool dispatch timeout. Run each step via async spawn instead, shaped to
// mirror spawnSync's result so describeStepFailure reads it unchanged.

function runAsync(cmd, args, { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ status: null, stdout, stderr, error, signal: null }); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr, signal: timedOut ? 'SIGTERM' : signal, error: timedOut ? { code: 'ETIMEDOUT' } : null });
    });
  });
}

// First-run docling provisioning blocks for minutes (uv install, venv, then a
// large `uv pip install docling` that pulls ML deps). Without a heartbeat it
// reads as a hang. Progress goes to stderr only, so JSON consumers on stdout are
// unaffected; it is the long-operation's own channel, not a suppressible notice.

function progress(message) {
  try { process.stderr.write(`[docling setup] ${message}\n`); } catch { /* stderr closed */ }
}

// spawnSync sets status=null and error.code=ETIMEDOUT on timeout; distinguish a
// timeout from a real non-zero exit so the message tells the user what to do.

function describeStepFailure(label, result, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    return `${label} timed out after ${Math.round(timeoutMs / 1000)}s — docling's one-time download did not complete. Check network/proxy and re-run; or set ingest.fallback to "adapter" to skip docling.`;
  }
  return `${label} failed (${result.status}): ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`;
}

async function ensureUv(installDir) {
  const fromPath = which('uv');
  if (fromPath) return fromPath;
  const cachedUv = path.join(installDir, 'bin', 'uv');
  if (existsSync(cachedUv)) return cachedUv;
  mkdirSync(installDir, { recursive: true });
  progress('Installing uv (Python toolchain) — first run only…');
  const env = { ...process.env, UV_INSTALL_DIR: path.join(installDir, 'bin'), UV_NO_MODIFY_PATH: '1' };
  const sh = await runAsync('sh', ['-c', `curl -LsSf ${UV_INSTALL_URL} | sh`], { env, timeoutMs: UV_TIMEOUT_MS });
  if (sh.status !== 0) {
    throw new Error(describeStepFailure('uv install', sh, UV_TIMEOUT_MS));
  }
  if (!existsSync(cachedUv)) {
    throw new Error(`uv install reported success but binary not found at ${cachedUv}`);
  }
  return cachedUv;
}

function pythonBinFor(venvDir) {
  const candidates = process.platform === 'win32'
    ? [path.join(venvDir, 'Scripts', 'python.exe')]
    : [path.join(venvDir, 'bin', 'python'), path.join(venvDir, 'bin', 'python3')];
  return candidates.find((p) => existsSync(p));
}

function readMarker(markerPath) {
  try { return JSON.parse(readFileSync(markerPath, 'utf8')); }
  catch { return null; }
}

function writeMarker(markerPath, payload) {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export async function ensureDoclingVenv({ runtimeDir = defaultRuntimeDir(), force = false } = {}) {
  mkdirSync(runtimeDir, { recursive: true });
  const venvDir = path.join(runtimeDir, '.venv');
  const markerPath = path.join(runtimeDir, '.install-marker.json');
  const existingMarker = readMarker(markerPath);
  const existingPython = pythonBinFor(venvDir);

  if (!force && existingPython && existingMarker?.doclingVersion === DOCLING_PIN) {
    return { pythonBin: existingPython, venvDir, runtimeDir, fresh: false };
  }

  // A version-pin mismatch (existingMarker present but doclingVersion !== DOCLING_PIN)
  // is a controlled re-provision, not silent drift: clear the stale venv outright
  // rather than trust `uv venv` to reconcile an existing directory left by a
  // different docling/Python pin.

  if (existingMarker && existingMarker.doclingVersion !== DOCLING_PIN) {
    progress(`Pinned docling version changed (${existingMarker.doclingVersion} → ${DOCLING_PIN}) — re-provisioning.`);
    try { rmSync(venvDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  progress('Provisioning the docling document extractor (first run). This downloads a Python runtime and ML dependencies and can take several minutes; later runs are instant.');
  const uv = await ensureUv(runtimeDir);

  progress('Creating Python 3.11 virtualenv…');
  const venvResult = await runAsync(uv, ['venv', venvDir, '--python', '3.11'], { timeoutMs: VENV_TIMEOUT_MS });
  if (venvResult.status !== 0) {
    throw new Error(describeStepFailure('uv venv', venvResult, VENV_TIMEOUT_MS));
  }

  progress(`Installing docling ${DOCLING_PIN} and its dependencies — the slow step (large download)…`);
  const installResult = await runAsync(uv, ['pip', 'install', '--python', pythonBinFor(venvDir), `docling==${DOCLING_PIN}`], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (installResult.status !== 0) {
    throw new Error(describeStepFailure('docling install', installResult, INSTALL_TIMEOUT_MS));
  }
  progress('docling extractor ready.');

  const pythonBin = pythonBinFor(venvDir);
  writeMarker(markerPath, {
    doclingVersion: DOCLING_PIN,
    installedAt: new Date().toISOString(),
    pythonBin,
    uvVersion: spawnSync(uv, ['--version'], { encoding: 'utf8' }).stdout.trim() || null,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  });

  return { pythonBin, venvDir, runtimeDir, fresh: true };
}

export function describeDoclingRuntime({ runtimeDir = defaultRuntimeDir() } = {}) {
  const venvDir = path.join(runtimeDir, '.venv');
  return {
    runtimeDir,
    venvDir,
    pythonBin: pythonBinFor(venvDir),
    marker: readMarker(path.join(runtimeDir, '.install-marker.json')),
    available: !!pythonBinFor(venvDir),
  };
}
