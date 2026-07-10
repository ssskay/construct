#!/usr/bin/env node
/**
 * lib/setup.mjs — Machine-scoped first-run setup wizard for Construct.
 *
 * Installs cm/cass, configures managed defaults, wires MCP integrations, and
 * writes the XDG user config (~/.config/construct/config.env). Invoked by
 * `construct install` and by lib/install/first-invocation.mjs when a TTY
 * user is missing resources.
 *
 * The embedding model and LanceDB vector store provision lazily by default
 * (construct-rf26.17) — pass --with-embeddings to warm both up during
 * install instead of at first semantic-search use, mirroring --with-docling.
 *
 * Project-scoped scaffolding (`.cx/`, AGENTS.md, plan.md, adapters) lives
 * in lib/init-unified.mjs — invoked by `construct init`. These two flows
 * are intentionally separate: install runs once per machine, init runs
 * once per repo.
 *
 * Construct now uses embedded LanceDB and Git-backed state, removing the
 * dependency on local Docker-managed Postgres.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { ensureUserConfigDir, getUserEnvPath, writeEnvValues } from './env-config.mjs';
import { MODEL_TIERS } from './model-tiers.mjs';
import { migrateLegacyModelConfig, migrateLegacyCredentialConfig } from './config/legacy-config-migration.mjs';
import { configDir, stateDir, doctorRoot } from './config/xdg.mjs';
import { DEFAULT_WORKSPACE_PATH, WORKSPACE_DOCS_LANES } from './embed/config.mjs';
import {
  DEFAULT_DEPLOYMENT_MODE,
  DEPLOYMENT_MODE_ENV_KEY,
  getDeploymentMode,
} from './deployment-mode.mjs';
import { getCanonicalOpenCodeConfigPath, readOpenCodeConfig, writeOpenCodeConfig } from './opencode-config.mjs';
import { getEmbeddingModelInfo, warmupEmbeddingModel } from './storage/embeddings-engine.mjs';
import { buildPressureGuardValues, installPressureGuardLaunchAgent, loadPressureGuardLaunchAgent } from './runtime-pressure.mjs';
import { consentToInstall } from './setup-prompts.mjs';
import { cleanupLegacyGlobalConstruct } from './install/legacy-global-cleanup.mjs';
import { isMainModule } from './roots.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();

function printHelp() {
  console.log(`Construct install — machine setup (once per machine)

Usage:
  construct install [--footprint=project|user|both] [--yes] [--dry-run] [--no-launch-agent] [--reconfigure] [--with-docling] [--cleanup-legacy-global]

Flags:
  --footprint=<f>   project | user | both — see ADR-0029 (semantics) and ADR-0071
                      (this flag name). A bare \`construct install\` with no
                      --footprint hard-errors naming this flag (construct-vzg2i.3);
                      it no longer silently exits 0 having written nothing.
                      NOTE: this is unrelated to \`construct scope\` (the org
                      profile command, lib/scopes/lifecycle.mjs).
                      project: no-op + footprint guidance (only when passed
                               explicitly); Construct's project artifacts are
                               written by \`construct init\` inside a repo.
                      user:    write machine-scope state (~/.construct/, MCP configs,
                               ~/.claude/* via consent-gated sync).
                      both:    print project guidance, then run user-scope install.
  --scope=<s>       deprecated alias for --footprint (same values, same
                      semantics). Prints a one-line deprecation notice
                      pointing at --footprint; kept working for existing
                      scripts. See ADR-0071.
  --yes             accept detected defaults without prompting
  --dry-run         print the install plan and exit without writing anything
  --no-launch-agent skip macOS LaunchAgent background service registration
  --reconfigure     re-prompt for service consent, ignoring cached answers
  --with-docling    eagerly provision the docling document-extraction venv now
                      (heavy, ~10 min via uv; otherwise provisioned lazily on
                      first document ingest)
  --with-embeddings warm the embedding model + LanceDB vector store dir now
                      (loads from local cache only, offline-safe; otherwise
                      both provision lazily on first semantic-search use)
  --cleanup-legacy-global
                    remove legacy user-global Construct adapters/MCP/history
                      before setup; does not uninstall a global construct CLI

What --footprint=user does:
  - creates ~/.config/construct/config.env
  - ensures OpenCode config exists
  - configures managed defaults for local vector retrieval (LanceDB)
  - checks required runtime tools and installs cm and cass when available
  - wires Memory, GitHub, and telemetry configuration
  - runs construct sync --global (which writes ~/.claude/* per consent)
  - runs construct doctor

For project setup (once per repo): construct init`);
}

function runConstruct(argsList, { optional = false } = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT_DIR, 'bin', 'construct'), ...argsList], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0 && optional) {
    console.log(`\nOptional setup step skipped: construct ${argsList.join(' ')}`);
    return;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findCommand(command) {
  const result = spawnSync('zsh', ['-lc', `command -v ${command}`], {
    encoding: 'utf8',
    env: process.env,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function defaultVectorIndexPath(homeDir = HOME) {
  // LanceDB storage path
  return path.join(stateDir(homeDir), 'vector', 'lancedb');
}

export async function buildManagedSetupValues({ homeDir = HOME, env = process.env } = {}) {
  const modelInfo = await getEmbeddingModelInfo({ env });

  const values = {
    CONSTRUCT_TRACE_BACKEND: env.CONSTRUCT_TRACE_BACKEND || 'local',
    CONSTRUCT_LANCEDB_PATH: env.CONSTRUCT_LANCEDB_PATH || defaultVectorIndexPath(homeDir),
    CONSTRUCT_VECTOR_MODEL: env.CONSTRUCT_VECTOR_MODEL || modelInfo.model,
    ...buildPressureGuardValues({ env }),
  };
  
  if (env[DEPLOYMENT_MODE_ENV_KEY] && getDeploymentMode(env) !== DEFAULT_DEPLOYMENT_MODE) {
    values[DEPLOYMENT_MODE_ENV_KEY] = getDeploymentMode(env);
  }

  if (env.CONSTRUCT_TELEMETRY_URL) values.CONSTRUCT_TELEMETRY_URL = env.CONSTRUCT_TELEMETRY_URL;
  if (env.CONSTRUCT_TELEMETRY_PUBLIC_KEY) values.CONSTRUCT_TELEMETRY_PUBLIC_KEY = env.CONSTRUCT_TELEMETRY_PUBLIC_KEY;
  if (env.CONSTRUCT_TELEMETRY_SECRET_KEY) values.CONSTRUCT_TELEMETRY_SECRET_KEY = env.CONSTRUCT_TELEMETRY_SECRET_KEY;

  if (env.DATABASE_URL) values.DATABASE_URL = env.DATABASE_URL;
  return values;
}

function runQuiet(command, args, { env = process.env, spawn = spawnSync } = {}) {
  const result = spawn(command, args, {
    env,
    stdio: 'ignore',
  });
  return result;
}

export function commandExists(command, { env = process.env, spawn = spawnSync } = {}) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return runQuiet(checker, [command], { env, spawn }).status === 0;
}

function summarizeSpawnFailure(result, fallback) {
  return (result.stderr || result.stdout || fallback).trim().split('\n')[0];
}

export function ensureCmInstalled({ env = process.env, spawn = spawnSync } = {}) {
  if (commandExists('cm', { env, spawn })) {
    return { status: 'available', message: 'cm already installed.' };
  }

  if (commandExists('brew', { env, spawn })) {
    const result = runQuiet('brew', ['install', 'dicklesworthstone/tap/cm'], { env, spawn });
    if (result.status === 0 && commandExists('cm', { env, spawn })) {
      return { status: 'installed', message: 'Installed cm via Homebrew.' };
    }
    return {
      status: 'failed',
      message: summarizeSpawnFailure(result, 'brew install failed'),
      installCommand: 'brew install dicklesworthstone/tap/cm',
    };
  }

  return {
    status: 'missing',
    message: 'Homebrew not available.',
    installCommand: 'brew install dicklesworthstone/tap/cm',
  };
}

const CASS_MIN_VERSION = '0.4.0';

function parseSemver(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function semverGte(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return true;
    if (x[i] < y[i]) return false;
  }
  return true;
}

function getCassVersion({ env, spawn }) {
  const result = runQuiet('cass', ['--version'], { env, spawn });
  if (result.status !== 0) return null;
  const match = String(result.stdout || '').match(/cass\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function ensureCassInstalled({ env = process.env, spawn = spawnSync } = {}) {
  if (commandExists('cass', { env, spawn })) {
    const version = getCassVersion({ env, spawn });
    if (version && semverGte(version, CASS_MIN_VERSION)) {
      return { status: 'available', message: `cass ${version} already installed.` };
    }
    return {
      status: 'outdated',
      message: `cass ${version || 'unknown'} is older than required ${CASS_MIN_VERSION}.`,
      installCommand: 'brew upgrade dicklesworthstone/tap/cass || brew install dicklesworthstone/tap/cass',
    };
  }

  if (commandExists('brew', { env, spawn })) {
    const result = runQuiet('brew', ['install', 'dicklesworthstone/tap/cass'], { env, spawn });
    if (result.status === 0 && commandExists('cass', { env, spawn })) {
      runQuiet('cass', ['index'], { env, spawn });
      return { status: 'installed', message: 'Installed cass via Homebrew and ran cass index.' };
    }
    return {
      status: 'failed',
      message: summarizeSpawnFailure(result, 'brew install failed'),
      installCommand: 'brew install dicklesworthstone/tap/cass && cass index',
    };
  }

  if (commandExists('cargo', { env, spawn })) {
    const result = runQuiet('cargo', ['install', 'cass'], { env, spawn });
    if (result.status === 0 && commandExists('cass', { env, spawn })) {
      runQuiet('cass', ['index'], { env, spawn });
      return { status: 'installed', message: 'Installed cass via cargo and ran cass index.' };
    }
    return {
      status: 'failed',
      message: summarizeSpawnFailure(result, 'cargo install failed'),
      installCommand: 'cargo install cass && cass index',
    };
  }

  return {
    status: 'missing',
    message: 'Neither Homebrew nor cargo available.',
    installCommand: 'brew install dicklesworthstone/tap/cass && cass index',
  };
}

function warnIfGlobalCommandIsUnavailable() {
  const globalConstruct = findCommand('construct');
  if (!globalConstruct) {
    console.log('\nInstall warning: `construct` is not on PATH yet.');
    console.log('  From this checkout, run: npm install -g .');
    return;
  }

  const version = spawnSync(globalConstruct, ['version'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (version.status !== 0 || !/^construct v\d+\./.test(version.stdout.trim())) {
    console.log(`\nInstall warning: PATH resolves \`construct\` to ${globalConstruct}, but it does not look like this CLI.`);
    console.log('  Reinstall from this checkout with: npm install -g .');
  }
}

function ensureOpenCodeConfig() {
  const current = readOpenCodeConfig();
  if (current.config) return current.file;
  writeOpenCodeConfig({
    $schema: 'https://opencode.ai/config.json',
    mcp: {},
    agent: {},
  }, getCanonicalOpenCodeConfigPath());
  return getCanonicalOpenCodeConfigPath();
}

export { ensureGitHooksPath } from './git-hooks-path.mjs';

export function ensureLibSymlink({ homeDir = HOME, rootDir = ROOT_DIR } = {}) {
  const target = path.join(configDir(homeDir), 'lib');
  const source = path.join(rootDir, 'lib');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { stat = null; }
  if (!stat) {
    fs.symlinkSync(source, target, 'dir');
    return { status: 'created', target, source };
  }
  if (stat.isSymbolicLink()) {
    const current = fs.readlinkSync(target);
    if (current === source) return { status: 'kept', target, source };
    fs.unlinkSync(target);
    fs.symlinkSync(source, target, 'dir');
    return { status: 'replaced', target, source, previous: current };
  }
  return {
    status: 'conflict',
    target,
    message: `${target} exists and is not a symlink — leaving alone.`,
  };
}

const VALID_FOOTPRINTS = new Set(['project', 'user', 'both']);
const DEFAULT_FOOTPRINT = 'project';

// --footprint is canonical (ADR-0071); --scope is a deprecated alias kept
// working for existing scripts/CI. When both are passed, --footprint wins.
// usedAlias signals runSetup to print a one-line deprecation notice.

function parseFootprintFlag(args) {
  let footprintValue = null;
  let scopeValue = null;
  for (const a of args) {
    if (a === '--footprint') return { invalid: '--footprint requires a value (project|user|both)' };
    if (a.startsWith('--footprint=') && footprintValue === null) footprintValue = a.slice('--footprint='.length);
    if (a === '--scope') return { invalid: '--scope requires a value (project|user|both)' };
    if (a.startsWith('--scope=') && scopeValue === null) scopeValue = a.slice('--scope='.length);
  }
  if (footprintValue !== null) {
    if (!VALID_FOOTPRINTS.has(footprintValue)) return { invalid: `--footprint=${footprintValue} is not one of project|user|both` };
    return { footprint: footprintValue, explicit: true, usedAlias: false };
  }
  if (scopeValue !== null) {
    if (!VALID_FOOTPRINTS.has(scopeValue)) return { invalid: `--scope=${scopeValue} is not one of project|user|both` };
    return { footprint: scopeValue, explicit: true, usedAlias: true };
  }
  return { footprint: DEFAULT_FOOTPRINT, explicit: false, usedAlias: false };
}

// Bare `construct install` (no --footprint) hard-errors rather than falling
// through to the project-footprint no-op below, so a first run never silently
// exits 0 having written nothing. An explicit `--footprint=project` still
// reaches the guidance-only no-op — that's a deliberate documented choice
// (ADR-0029).

function printBareInvocationError() {
  console.error('Construct install — no footprint specified.');
  console.error('──────────────────────────────────────');
  console.error('A bare `construct install` no longer silently writes nothing. Pick a footprint:');
  console.error('  construct install --footprint=user     machine-scope setup (most first installs want this)');
  console.error('  construct install --footprint=both     project guidance, then user-scope setup');
  console.error('  construct install --footprint=project  explicit no-op — prints project guidance only');
  console.error('(--scope=<value> also works as a deprecated alias for --footprint.)');
}

function printDeprecatedScopeAliasNotice() {
  console.error('Deprecation notice: --scope is deprecated for `construct install`; use --footprint instead (same values). See ADR-0071.');
}

function printProjectFootprintGuidance() {
  console.log('Construct install — footprint: project (no-op)');
  console.log('────────────────────────────────────────');
  console.log('Project artifacts are written by `construct init` inside a repo.');
  console.log('To install machine-scope state on this user account:');
  console.log('  construct install --footprint=user');
  console.log('To do both project (guidance) and user-scope install:');
  console.log('  construct install --footprint=both');
}

function runLegacyGlobalCleanup({ homeDir, dryRun }) {
  const result = cleanupLegacyGlobalConstruct({ homeDir, dryRun });
  const action = dryRun ? 'would remove' : 'removed';
  console.log(`Legacy global cleanup: ${result.removed.length ? `${action} ${result.removed.length} item(s)` : 'nothing detected'}`);
  for (const item of result.removed.slice(0, 20)) {
    console.log(`  - ${item}`);
  }
  if (result.removed.length > 20) {
    console.log(`  - ...and ${result.removed.length - 20} more`);
  }
  return result;
}

// Dry-run renders the user-scope plan as intent only — every line names a write,
// network call, or service registration that the real run would perform — and
// returns before touching disk so the preview is provably side-effect-free.

function printInstallPlan({ footprint, homeDir, withDocling, withEmbeddings, noLaunchAgent, cleanupLegacyGlobal }) {
  console.log('Construct install — dry-run (no changes written)');
  console.log('────────────────────────────────────────────────');
  console.log(`Footprint: ${footprint}`);
  if (cleanupLegacyGlobal) {
    console.log('\nLegacy global cleanup:');
    runLegacyGlobalCleanup({ homeDir, dryRun: true });
  }
  if (footprint === 'project') {
    console.log('\nWould not run user-scope setup. Re-run without --dry-run to apply cleanup only.');
    return;
  }
  if (footprint === 'both') {
    console.log('  · would print project-footprint guidance, then run the user-scope plan below');
  }
  console.log('\nWould write:');
  console.log(`  · ${getUserEnvPath(homeDir)} (user config, managed defaults)`);
  console.log(`  · ${getCanonicalOpenCodeConfigPath(homeDir)} (OpenCode config)`);
  console.log(`  · ${path.join(configDir(homeDir), 'lib')} → ${path.join(ROOT_DIR, 'lib')} (hook lib symlink)`);
  console.log(`  · ${path.join(stateDir(homeDir), 'workspace')} (workspace docs scaffold)`);
  if (withEmbeddings) console.log(`  · ${path.dirname(defaultVectorIndexPath(homeDir))} (LanceDB vector store dir)`);
  console.log('\nWould check / install runtime tooling:');
  console.log('  · cm (memory CLI) and cass (session search) when available on PATH');
  if (withEmbeddings || withDocling) console.log('\nWould reach the network / external services:');
  if (withEmbeddings) console.log('  · embedding model warmup (loads from local cache; offline-safe, no download)');
  if (withDocling) console.log('  · docling Python venv provisioning via uv (~10 min)');
  console.log('  · construct sync --quiet, construct sync --global, construct doctor');
  if (process.platform === 'darwin' && !noLaunchAgent) {
    console.log('\nWould register macOS LaunchAgent:');
    console.log(`  · ${path.join(homeDir, 'Library', 'LaunchAgents', 'dev.construct.pressure-release.plist')} (consent-gated)`);
  }
  console.log('\nNo files were written. Re-run without --dry-run to apply.');
}

export async function runSetup({ rootDir = ROOT_DIR, args = [], homeDir = HOME } = {}) {
  const argSet = new Set(args);
  const isYes = argSet.has('--yes');
  const reconfigure = argSet.has('--reconfigure');
  const cleanupLegacyGlobal = argSet.has('--cleanup-legacy-global');

  if (argSet.has('--help') || argSet.has('-h')) {
    printHelp();
    return;
  }

  const KNOWN_FLAGS = new Set(['--yes', '--dry-run', '--no-launch-agent', '--reconfigure', '--with-docling', '--with-embeddings', '--cleanup-legacy-global', '--help', '-h']);
  const dryRun = argSet.has('--dry-run');
  const withDocling = argSet.has('--with-docling');
  const withEmbeddings = argSet.has('--with-embeddings');
  const unknownFlags = args.filter((a) => {
    if (!a.startsWith('-')) return false;
    if (a.startsWith('--footprint=') || a === '--footprint') return false;
    if (a.startsWith('--scope=') || a === '--scope') return false;
    return !KNOWN_FLAGS.has(a);
  });
  if (unknownFlags.length) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    printHelp();
    throw new Error(`Unknown setup flag(s): ${unknownFlags.join(', ')}`);
  }

  const footprintResult = parseFootprintFlag(args);
  if (footprintResult.invalid) {
    console.error(footprintResult.invalid);
    printHelp();
    throw new Error(`Invalid setup footprint: ${footprintResult.invalid}`);
  }
  if (footprintResult.usedAlias) {
    printDeprecatedScopeAliasNotice();
  }
  const footprint = footprintResult.footprint;

  if (dryRun) {
    if (footprint === 'project' && !cleanupLegacyGlobal) {
      printProjectFootprintGuidance();
      return;
    }
    printInstallPlan({ footprint, homeDir, withDocling, withEmbeddings, noLaunchAgent: argSet.has('--no-launch-agent'), cleanupLegacyGlobal });
    return;
  }

  // Forward-migrate model tier overrides stranded in the pre-XDG legacy config
  // before any legacy-global cleanup deletes ~/.construct, so an upgrade keeps
  // the user's tier selection without a manual copy.
  const modelMigration = migrateLegacyModelConfig({ homeDir });
  if (modelMigration.performed) {
    console.log(`Migrated ${Object.keys(modelMigration.migrated).join(', ')} from ${modelMigration.legacyPath} → ${modelMigration.xdgPath}`);
  }

  const credentialMigration = migrateLegacyCredentialConfig({ homeDir });
  if (credentialMigration.performed) {
    console.log(`Migrated credentials ${Object.keys(credentialMigration.migrated).join(', ')} from ${credentialMigration.legacyPath} → ${credentialMigration.xdgPath}`);
  }

  if (cleanupLegacyGlobal) {
    runLegacyGlobalCleanup({ homeDir, dryRun: false });
    if (footprint === 'project') {
      printProjectFootprintGuidance();
      return;
    }
  }

  if (footprint === 'project') {
    if (!footprintResult.explicit) {
      printBareInvocationError();
      throw new Error('construct install requires an explicit --footprint (bare invocation is no longer a silent no-op)');
    }
    printProjectFootprintGuidance();
    return;
  }

  if (footprint === 'both') {
    printProjectFootprintGuidance();
    console.log('');
  }

  console.log('Construct setup');
  console.log('────────────────');
  console.log(`Footprint: ${footprint}`);

  const envPath = ensureUserConfig(homeDir);
  const opencodePath = ensureOpenCodeConfig();
  const libLink = ensureLibSymlink({ homeDir, rootDir });

  console.log(`User config: ${envPath}`);
  console.log(`OpenCode config: ${opencodePath}`);
  if (libLink.status === 'created' || libLink.status === 'replaced') {
    console.log(`Hook lib link: ${libLink.target} → ${libLink.source} (${libLink.status})`);
  }
  warnIfGlobalCommandIsUnavailable();

  const cmInstall = ensureCmInstalled({ env: process.env });
  if (cmInstall.status === 'installed' || cmInstall.status === 'available') {
    console.log(`Memory CLI: ${cmInstall.message}`);
  } else {
    console.log(`Memory CLI: ${cmInstall.message}`);
    if (cmInstall.installCommand) console.log(`  Install with: ${cmInstall.installCommand}`);
  }

  const cassInstall = ensureCassInstalled({ env: process.env });
  if (cassInstall.status === 'installed' || cassInstall.status === 'available') {
    console.log(`Session search: ${cassInstall.message}`);
  } else {
    console.log(`Session search: ${cassInstall.message}`);
    if (cassInstall.installCommand) console.log(`  Install with: ${cassInstall.installCommand}`);
  }

  const telemetryResult = process.env.CONSTRUCT_TELEMETRY_URL
    ? { status: 'configured', note: `remote export configured (${process.env.CONSTRUCT_TELEMETRY_URL})` }
    : { status: 'local', note: 'local JSONL traces in the machine-scoped state root; remote export optional' };
  console.log(`Telemetry: ${telemetryResult.note}`);

  // The embedding model and LanceDB vector store dir are provisioned lazily
  // by default (construct-rf26.17): a project that never runs semantic
  // search never pays for the ONNX model cache or an index directory. Both
  // provision on first real use (`construct ingest`, first observation
  // store/search) exactly like docling below. --with-embeddings opts into
  // warming both up now instead of at first query.
  if (withEmbeddings) {
    fs.mkdirSync(path.dirname(defaultVectorIndexPath(homeDir)), { recursive: true });
    try {
      const warm = await warmupEmbeddingModel({ env: process.env });
      if (warm.degraded) {
        console.log(`Embeddings: degraded fallback (${warm.fallbackReason || 'model unavailable'}) — semantic search will use the hashing backend`);
      } else {
        console.log(`Embeddings: ${warm.model} ready (${warm.dimensions}d, warmed in ${warm.durationMs}ms)`);
      }
    } catch (err) {
      console.log(`Embeddings: warmup skipped (${err?.message || 'unknown error'}) — model will load on first use`);
    }
  } else {
    console.log('Embeddings: will provision on first semantic-search use (pass --with-embeddings to warm up now)');
  }

  // Docling (document/PDF extraction) provisions a pinned Python venv via uv,
  // which is heavy (~10 min) and only needed for document ingest — so it stays
  // lazy by default and is provisioned eagerly only when the user opts in with
  // --with-docling. First document ingest still auto-provisions if skipped.
  if (withDocling) {
    try {
      const { ensureDoclingVenv } = await import('./runtime/uv-bootstrap.mjs');
      console.log('Docling: provisioning Python venv (uv) — this can take several minutes…');
      const docling = await ensureDoclingVenv();
      console.log(`Docling: ready (${docling.fresh ? 'provisioned' : 'already present'} at ${docling.venvDir})`);
    } catch (err) {
      console.log(`Docling: provisioning skipped (${err?.message || 'unknown error'}) — will provision on first document ingest`);
    }
  }

  const { isCheapestProviderEnabled, selectCheapestForAllTiers, setCheapestProviderPreference } =
    await import('./model-cheapest-provider.mjs');
  const cheapestAlreadyEnabled = isCheapestProviderEnabled(envPath, { env: process.env });
  if (!cheapestAlreadyEnabled) {
    const cheapestConsent = await consentToInstall({
      name: 'cheapest-provider',
      isYes,
      force: reconfigure,
      alreadyConfigured: false,
      envPath,
      defaultYes: false,
    });
    if (cheapestConsent.decision) {
      try {
        const { applyToEnv } = await import('./model-router.mjs');
        const selections = await selectCheapestForAllTiers({ env: process.env });
        const applied = {};
        for (const tier of MODEL_TIERS) {
          if (selections[tier]?.modelId) applied[tier] = selections[tier].modelId;
        }
        if (Object.keys(applied).length > 0) {
          applyToEnv(envPath, applied);
          console.log('\nCheapest providers applied:');
          for (const [tier, model] of Object.entries(applied)) {
            const label = selections[tier]?.providerLabel || '';
            console.log(`  ${tier.padEnd(11)} ${model} (${label})`);
          }
        }
        setCheapestProviderPreference(envPath, true);
      } catch (err) {
        console.log(`Cheapest provider: skipped (${err?.message || 'unknown error'})`);
      }
    }
  }

  ensureWorkspace(homeDir);

  const managedValues = await buildManagedSetupValues({
    homeDir,
    env: process.env,
  });
  writeEnvValues(envPath, managedValues);
  
  let pressureGuardAgent = null;
  let pressureGuardLoad = null;
  if (process.platform === 'darwin' && !argSet.has('--no-launch-agent')) {
    const laConsent = await consentToInstall({
      name: 'launchagent',
      question: 'Install background pressure-release service (macOS LaunchAgent)?',
      isYes,
      force: reconfigure,
      alreadyConfigured: fs.existsSync(path.join(homeDir, 'Library', 'LaunchAgents', 'dev.construct.pressure-release.plist')),
      alreadyConfiguredNote: 'Background pressure-release service already installed.',
      envPath,
    });
    if (laConsent.decision) {
      pressureGuardAgent = installPressureGuardLaunchAgent({
        homeDir,
        rootDir,
        intervalSeconds: Number(managedValues.CONSTRUCT_PRESSURE_GUARD_INTERVAL_SECONDS || 300),
        nodePath: process.execPath,
      });
      pressureGuardLoad = loadPressureGuardLaunchAgent({ plistPath: pressureGuardAgent.plistPath });
    }
  }

  if (isYes) {
    runConstruct(['mcp', 'add', 'memory', '--auto'], { optional: true });
    runConstruct(['mcp', 'add', 'github', '--auto'], { optional: true });
  }

  runConstruct(['sync', '--quiet']);
  runConstruct(['sync', '--global']);
  runConstruct(['doctor']);

  const setupTs = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const setupLogPath = path.join(doctorRoot(), `setup-${setupTs}.log`);
  try {
    fs.mkdirSync(path.dirname(setupLogPath), { recursive: true });
    const logLines = [
      `Construct setup completed ${new Date().toISOString()}`,
      `Config: ${getUserEnvPath(HOME)}`,
      `OpenCode: ${getCanonicalOpenCodeConfigPath(HOME)}`,
    ];
    fs.writeFileSync(setupLogPath, logLines.join('\n') + '\n');
  } catch { /* best effort */ }

  console.log('\n────────────────────────────────────');
  console.log('Setup complete.');

  console.log('\nLocal services:');
  console.log('  Traces:      local JSONL (machine-scoped state root)');
  console.log(`  Vector:      LanceDB (embedded)`);
  console.log(`    ${managedValues.CONSTRUCT_LANCEDB_PATH}`);
  console.log(`  Credentials are saved to ${getUserEnvPath(homeDir)} for later reference.`);

  console.log('\nNext steps:');
  console.log('  construct provider add github     # Connect GitHub repository data');
  console.log('  construct doctor                  # Verify all systems');
  console.log(`\nSetup log: ${setupLogPath}`);
}

function ensureUserConfig(homeDir = HOME) {
  ensureUserConfigDir(homeDir);
  const envPath = getUserEnvPath(homeDir);
  if (!fs.existsSync(envPath)) writeEnvValues(envPath, {});
  return envPath;
}

export function ensureWorkspace(homeDir = HOME) {
  const wsPath = path.join(stateDir(homeDir), 'workspace');
  const docsPath = path.join(wsPath, 'docs');
  for (const lane of WORKSPACE_DOCS_LANES) {
    fs.mkdirSync(path.join(docsPath, lane), { recursive: true });
  }
  const snapshotPath = path.join(wsPath, 'snapshot.md');
  if (!fs.existsSync(snapshotPath)) fs.writeFileSync(snapshotPath, '# Snapshot\n\nNo snapshot yet.\n');
  const roadmapPath = path.join(wsPath, 'roadmap.md');
  if (!fs.existsSync(roadmapPath)) fs.writeFileSync(roadmapPath, '# Roadmap\n\nNo roadmap generated yet.\n');
  return wsPath;
}

if (isMainModule(import.meta.url)) {
  runSetup({ args: process.argv.slice(2) });
}
