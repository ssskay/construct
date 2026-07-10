/**
 * tests/sync-copilot-deselect.test.mjs — a sync that does not select the
 * copilot host must not touch prior Copilot outputs (construct-lqp4c).
 *
 * The old behavior ran syncCopilot with an empty write set on deselect, which
 * pruned every manifest-listed file in .github/prompts and .github/agents and
 * blanked the copilot-instructions managed block — the path by which the
 * tool-repo npm postinstall deleted the tracked .github/agents/construct.agent.md.
 * Drives the real script end to end: sync a project with copilot selected,
 * sync again without it, and every Copilot output must survive byte-identical.
 * Pruning stays explicit-consent-only, and `.github` is out of adapter-prune's
 * scope (lib/reconcile/adapter-prune.mjs).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { rmTmpDir } from './helpers/cleanup.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT_DIR, 'scripts', 'sync-specialists.mjs');

const dirs = [];
test.after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function runProjectSync(projectDir, homeDir, hosts) {
  const res = spawnSync(process.execPath, [SCRIPT, '--project'], {
    encoding: 'utf8',
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CONSTRUCT_SYNC_FORCE: '1',
      CONSTRUCT_SYNC_HOSTS: hosts,
      CONSTRUCT_EMBEDDING_MODEL: 'hashing',
      CONSTRUCT_EMBEDDING_DISABLE_LOCAL: '1',
    },
    timeout: 120_000,
  });
  assert.equal(res.status, 0, `sync --project (hosts=${hosts}) failed: ${res.stderr}`);
  return res;
}

test('a copilot-less sync leaves previously synced Copilot outputs untouched', () => {
  const home = mkTmp('cx-copilot-home-');
  const project = mkTmp('cx-copilot-proj-');

  runProjectSync(project, home, 'claude,copilot');

  const agentPath = path.join(project, '.github', 'agents', 'construct.agent.md');
  const manifestPath = path.join(project, '.github', 'agents', '.construct-manifest');
  const instructionsPath = path.join(project, '.github', 'copilot-instructions.md');
  assert.ok(fs.existsSync(agentPath), 'copilot sync must write .github/agents/construct.agent.md');
  const agentBefore = fs.readFileSync(agentPath, 'utf8');
  const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
  const instructionsBefore = fs.readFileSync(instructionsPath, 'utf8');
  assert.match(manifestBefore, /construct\.agent\.md/, 'manifest must list the agent file');
  const promptsBefore = fs.readdirSync(path.join(project, '.github', 'prompts'));
  assert.ok(promptsBefore.length > 0, 'copilot sync must write .github/prompts');

  runProjectSync(project, home, 'claude');

  assert.ok(fs.existsSync(agentPath), 'deselecting copilot must not delete the agent file');
  assert.equal(fs.readFileSync(agentPath, 'utf8'), agentBefore, 'agent file must survive byte-identical');
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore, 'manifest must survive byte-identical');
  assert.equal(fs.readFileSync(instructionsPath, 'utf8'), instructionsBefore, 'instructions managed block must not be blanked');
  assert.deepEqual(fs.readdirSync(path.join(project, '.github', 'prompts')), promptsBefore, 'prompts must survive');
});
