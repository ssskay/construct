/**
 * tests/functional/fixtures/embed-daemon-inbox-tick-runner.mjs — child process
 * driver for embed-daemon-inbox-loop.functional.test.mjs (construct-b2t01.3).
 *
 * Boots the real EmbedDaemon (lib/embed/daemon.mjs), lets its scheduler run,
 * and polls the filesystem for the inbox-watcher Job #9's durable output
 * (an intake packet under .cx/intake/pending|quarantine and an observation
 * under .cx/observations) instead of sleeping for the job's full 2-minute
 * interval. Job #9 is registered with `runImmediately: true` (daemon.mjs),
 * so `Scheduler.start()` fires its first tick synchronously-scheduled but
 * asynchronously-resolved — this script polls in short intervals until that
 * fire-and-forget tick lands or a bounded timeout elapses.
 *
 * Reads CX_ROOT_DIR (project root, inbox/ already seeded by the parent test)
 * and TICK_TIMEOUT_MS from env. Prints one JSON line to stdout on success or
 * failure and exits 0/1 accordingly. No network: config carries zero sources
 * so ProviderRegistry.fromEnv() resolves only credential-free providers.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EmbedDaemon } from '../../../lib/embed/daemon.mjs';
import { EMPTY_CONFIG } from '../../../lib/embed/config.mjs';

const rootDir = process.env.CX_ROOT_DIR;
const timeoutMs = Number(process.env.TICK_TIMEOUT_MS || 15_000);
const pollIntervalMs = 150;

function readJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

function findArtifacts() {
  const pending = readJsonFiles(join(rootDir, '.cx', 'intake', 'pending'));
  const quarantine = readJsonFiles(join(rootDir, '.cx', 'intake', 'quarantine'));
  const observations = readJsonFiles(join(rootDir, '.cx', 'observations'))
    .filter((o) => o.tags?.includes('inbox') && o.tags?.includes('ingested-doc'));
  return { pending, quarantine, observations };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const daemon = new EmbedDaemon({
    config: EMPTY_CONFIG,
    rootDir,
    workspaceDir: rootDir,
    env: process.env,
  });

  await daemon.start();

  const deadline = Date.now() + timeoutMs;
  let artifacts = findArtifacts();
  while ((artifacts.pending.length + artifacts.quarantine.length === 0 || artifacts.observations.length === 0) && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    artifacts = findArtifacts();
  }

  daemon.stop();

  const packetCount = artifacts.pending.length + artifacts.quarantine.length;
  const ok = packetCount > 0 && artifacts.observations.length > 0;

  process.stdout.write(JSON.stringify({
    ok,
    packetCount,
    pendingCount: artifacts.pending.length,
    quarantineCount: artifacts.quarantine.length,
    observationCount: artifacts.observations.length,
    pending: artifacts.pending,
    quarantine: artifacts.quarantine,
    observations: artifacts.observations,
  }) + '\n');

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.stack || String(err) }) + '\n');
  process.exit(1);
});
