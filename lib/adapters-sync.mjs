/**
 * lib/adapters-sync.mjs — project adapter sync for the Construct tool repo and
 * `npm run adapters`. Detects installed hosts, runs sync-specialists --project,
 * and is invoked from postinstall when developing inside the package itself.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectHostCapabilities } from './host-capabilities.mjs';
import { isConstructPackageRepo } from './host-disposition.mjs';
import { stageProjectAdapters } from './install/stage-project.mjs';
import { isMainModule } from './roots.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(MODULE_DIR, '..');

const HOST_ID_MAP = {
  'Claude Code': 'claude',
  OpenCode: 'opencode',
  Codex: 'codex',
  'VS Code': 'vscode',
  Cursor: 'cursor',
  Copilot: 'copilot',
};

export function resolveAdapterHosts({ forceAll = false, extra = [] } = {}) {
  if (forceAll) return ['claude', 'opencode', 'codex', 'vscode', 'cursor', 'copilot'];
  const hosts = new Set(extra);
  for (const entry of detectHostCapabilities()) {
    if (entry.availability !== 'installed') continue;
    const id = HOST_ID_MAP[entry.host];
    if (id) hosts.add(id);
  }
  if (hosts.size === 0) hosts.add('claude');
  return [...hosts];
}

export function syncProjectAdapters({
  projectRoot = process.cwd(),
  packageRoot = PKG_ROOT,
  hosts = null,
  log = () => {},
} = {}) {
  const resolvedHosts = hosts ?? resolveAdapterHosts({ forceAll: isConstructPackageRepo(projectRoot) });
  return stageProjectAdapters({
    projectRoot,
    packageRoot,
    pkgVersion: null,
    log,
    hosts: resolvedHosts,
  });
}

export function runAdaptersScript({ cwd = process.cwd(), hosts = null } = {}) {
  const result = syncProjectAdapters({ projectRoot: cwd, hosts, log: (m) => process.stdout.write(`[adapters] ${m}\n`) });
  return result.synced ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const forceAll = args.has('--all-hosts');
  const hosts = forceAll ? resolveAdapterHosts({ forceAll: true }) : null;
  const code = runAdaptersScript({ cwd: process.cwd(), hosts });
  process.exit(code);
}
