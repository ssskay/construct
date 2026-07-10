#!/usr/bin/env node
/**
 * bin/construct-postinstall.mjs — npm postinstall hook for consumer projects.
 *
 * When a downstream project pins `@geraldmaron/construct` as a (dev)Dependency
 * and runs `npm install`, npm fetches Construct into the project's
 * `node_modules/` and then runs this script. Its job: regenerate the project's
 * `.claude/agents/` and `.claude/settings.json` from the bundled registry so
 * the project clone is fully runnable without a manual `construct init`.
 *
 * The script is a no-op in three cases:
 *
 *   1. The install is happening inside the Construct repo itself.
 *   2. CONSTRUCT_SKIP_POSTINSTALL=1 is set.
 *   3. The install target has no package.json (monorepo nested installs).
 *
 * Staging itself lives in `lib/install/stage-project.mjs` so `construct init`
 * can call the same code path for opt-in adoption after a clone.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageProjectAdapters } from '../lib/install/stage-project.mjs';
import { syncProjectAdapters } from '../lib/adapters-sync.mjs';
import { missingIgnorePatterns, isConstructPackageRepo } from '../lib/host-disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || ''; }
  catch { return ''; }
})();

const log = (msg) => process.stdout.write(`[construct-postinstall] ${msg}\n`);

// Failures go to stderr as a prominent, actionable block so they are visible in
// npm output instead of scrolling past as a benign-looking line. The script
// stays exit-0 by design (see the staging catch): best-effort adapter staging
// must not hard-fail a consumer's `npm install` — the package is installed and
// usable, and `construct init` completes staging on demand.

const fail = (msg, hint) => {
  process.stderr.write(`\n[construct-postinstall] WARNING: ${msg}\n`);
  if (hint) process.stderr.write(`[construct-postinstall]   -> ${hint}\n`);
  process.stderr.write('\n');
};

if (process.env.CONSTRUCT_SKIP_POSTINSTALL === '1') {
  log('skipping (CONSTRUCT_SKIP_POSTINSTALL=1)');
  process.exit(0);
}

const initCwd = process.env.INIT_CWD || process.cwd();

// Skip when installing inside the Construct repo itself, but still wire up
// the local commit template so contributors get the right editor scaffolding.
try {
  const pkgRealRoot = statSync(PKG_ROOT).isDirectory() ? PKG_ROOT : null;
  if (pkgRealRoot && pkgRealRoot.startsWith(initCwd) && initCwd === PKG_ROOT) {
    log('Construct tool repo — syncing project adapters for dogfooding');
    if (existsSync(path.join(PKG_ROOT, '.gitmessage')) && existsSync(path.join(PKG_ROOT, '.git'))) {
      const cfg = spawnSync('git', ['config', 'commit.template', '.gitmessage'], {
        cwd: PKG_ROOT,
        stdio: 'ignore',
      });
      if (cfg.status === 0) log('configured git commit.template -> .gitmessage');
    }
    try {
      syncProjectAdapters({ projectRoot: PKG_ROOT, packageRoot: PKG_ROOT, log });
    } catch (err) {
      fail(`Tool-repo adapter sync failed: ${err.message}`, 'Run `npm run adapters` manually.');
    }

    process.exit(0);
  }
} catch { /* fall through */ }

// ADR-0029: machine-scope writes are opt-in. The postinstall hook for a global
// install prints footprint guidance and exits; `~/.claude/CLAUDE.md`,
// `~/.claude/settings.json`, and `~/.construct/*` land only when the user runs
// `construct install --footprint=user` (ADR-0071 renamed --scope to
// --footprint; --scope keeps working as a deprecated alias), so the consent
// point is visible.

if (process.env.npm_config_global === 'true' || process.env.npm_config_global === true) {
  log('global install detected; machine-scope setup is opt-in (ADR-0029)');
  log('to wire ~/.construct/* and the front-door agent, run:');
  log('  construct install --footprint=user');
  log('to set up a project, cd into it and run:');
  log('  construct init');
  process.exit(0);
}

// Project install path: require a package.json at the install target so
// monorepo nested installs don't accidentally trigger staging in the wrong
// directory.

const consumerPkgPath = path.join(initCwd, 'package.json');
if (!existsSync(consumerPkgPath)) {
  log(`no package.json at ${initCwd}; skipping`);
  process.exit(0);
}

let consumerPkg = {};
try { consumerPkg = JSON.parse(readFileSync(consumerPkgPath, 'utf8')); } catch { /* empty */ }
if (consumerPkg.name === '@geraldmaron/construct') {
  log('install target is the Construct package itself; skipping');
  process.exit(0);
}

// Track every project mutation for the itemized receipt written at the end.
// npm has no uninstall lifecycle hook so the manifest is the only machine-readable
// record of what the hook touched and how to revert it (CX-AUDIT-PACKAGE-004).
const mutations = [];

try {
  const stageResult = stageProjectAdapters({
    projectRoot: initCwd,
    packageRoot: PKG_ROOT,
    pkgVersion: PKG_VERSION,
    log,
  });
  mutations.push({ path: '.construct', type: 'stage', synced: stageResult.synced });

  // ADR-0027: Ensure .gitignore covers the newly staged adapters (construct-f6l6).
  // Idempotent: missingIgnorePatterns returns only patterns not already present.
  const giPath = path.join(initCwd, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const missing = missingIgnorePatterns(existing);
  if (missing.length > 0) {
    const HEADER = '# Construct — generated adapters, launcher, and runtime state.';
    const SUBHEADER = '# Machine-specific, recreated by `construct sync`; never source (ADR-0027).';
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const block = `${prefix}\n${HEADER}\n${SUBHEADER}\n${missing.join('\n')}\n`;
    const { appendFileSync } = await import('node:fs');
    appendFileSync(giPath, block, 'utf8');
    mutations.push({ path: '.gitignore', type: 'append', patterns: missing });
    log(`appended ${missing.length} Construct ignore pattern(s) to .gitignore`);
  }

  // Write the itemized mutation receipt so consumers can audit and revert what the
  // hook touched. Write is best-effort: a manifest failure must never break an install.
  try {
    mkdirSync(path.join(initCwd, '.construct'), { recursive: true });
    const manifest = {
      pkgVersion: PKG_VERSION,
      ts: new Date().toISOString(),
      files: mutations.map((m) => m.path),
      mutations,
      recovery: 'npx construct init --repair',
    };
    writeFileSync(
      path.join(initCwd, '.construct', 'install-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    log('wrote .construct/install-manifest.json');
  } catch { /* manifest write must not fail the install */ }
} catch (err) {
  fail(`Adapter staging failed: ${err.message}`, 'The package is installed; run `npx construct init` in this project to complete setup.');
  // Intentionally exit 0: staging is best-effort completion, and a non-zero exit
  // here would fail the consumer's entire `npm install`. The failure is loud on
  // stderr above and recoverable via `construct init`.
  process.exit(0);
}
