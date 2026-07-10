import { loadRegistry } from '../registry/loader.mjs';
/**
 * lib/decisions/golden.mjs — behavioral golden snapshot of core surfaces.
 *
 * Pins the surfaces whose silent change is a drift hazard: the CLI command set,
 * the specialist roster, and hook execution order. buildSurfaceSnapshot computes
 * the live surface from source; a committed snapshot (tests/fixtures/golden/
 * surface.json) is the expectation. A mismatch fails the suite until the snapshot
 * is regenerated on purpose (`construct decisions golden --write`) — the same
 * conscious-update discipline as the enforced baseline (bead wvbf.5).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'];

function hookName(command) {
  const m = command.match(/hooks\/([\w-]+)\.mjs/);
  if (m) return m[1];
  if (/node\s+-e/.test(command)) return 'inline';
  return 'cmd';
}

export async function buildSurfaceSnapshot({ repoRoot = REPO_ROOT } = {}) {
  const snapshot = { commands: [], agents: [], hooks: {} };

  // The command surface comes from the CLI_COMMANDS registry module, not a
  // text scan of its source: the earlier regex scan paired `subcommands:` item
  // names with the NEXT command's `core:` field, minting phantom commands and
  // swallowing real ones, so the pinned set never matched the true surface.

  const { CLI_COMMANDS } = await import(pathToFileURL(join(repoRoot, 'lib', 'cli-commands.mjs')).href);
  snapshot.commands = CLI_COMMANDS
    .map((c) => ({ name: c.name, core: c.core === true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const registry = loadRegistry({ rootDir: repoRoot });
  snapshot.agents = Object.values(registry.specialists || {}).map((s) => s.name).sort();

  const settings = JSON.parse(readFileSync(join(repoRoot, 'platforms', 'claude', 'settings.template.json'), 'utf8'));
  for (const event of HOOK_EVENTS) {
    const entries = settings.hooks?.[event] || [];
    const ordered = [];
    for (const entry of entries) {
      for (const h of entry.hooks || []) ordered.push(hookName(h.command));
    }
    snapshot.hooks[event] = ordered;
  }

  return snapshot;
}

function snapshotPath(repoRoot) {
  return join(repoRoot, 'tests', 'fixtures', 'golden', 'surface.json');
}

export async function compareSurfaceSnapshot({ repoRoot = REPO_ROOT } = {}) {
  const file = snapshotPath(repoRoot);
  if (!existsSync(file)) return { ok: false, diffs: ['no committed snapshot — run: construct decisions golden --write'] };
  const expected = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
  const actual = JSON.stringify(await buildSurfaceSnapshot({ repoRoot }));
  if (expected === actual) return { ok: true, diffs: [] };
  return { ok: false, diffs: ['surface snapshot drift — review the change, then regenerate with: construct decisions golden --write'] };
}

export async function writeSurfaceSnapshot({ repoRoot = REPO_ROOT } = {}) {
  writeFileSync(snapshotPath(repoRoot), JSON.stringify(await buildSurfaceSnapshot({ repoRoot }), null, 2) + '\n');
}

export async function runGoldenCli(args = []) {
  if (args.includes('--write')) {
    await writeSurfaceSnapshot();
    process.stdout.write('✓ wrote surface golden snapshot\n');
    return;
  }
  const { ok, diffs } = await compareSurfaceSnapshot();
  if (ok) {
    process.stdout.write('✓ surface matches the golden snapshot\n');
    return;
  }
  for (const d of diffs) process.stderr.write(`✗ ${d}\n`);
  process.exit(1);
}
