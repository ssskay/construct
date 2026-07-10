/**
 * tests/functional/embed-daemon-inbox-loop.functional.test.mjs —
 * end-to-end proof of the LIVE continuous-inbox loop (construct-b2t01.3,
 * closing epic construct-b2t01).
 *
 * Before this bead, the embed daemon's Job #9 (lib/embed/daemon.mjs
 * "inbox-watcher", scheduled every 2 minutes on `lib/embed/inbox.mjs`'s
 * InboxWatcher) was covered only indirectly — unit tests exercised
 * InboxWatcher.poll() and the Scheduler in isolation, but nothing booted the
 * real daemon and drove a file drop through it end to end.
 *
 * Coverage here: a child process (via the sterile env from
 * tests/helpers/sterile-env.mjs) spawns
 * tests/functional/fixtures/embed-daemon-inbox-tick-runner.mjs, which
 * constructs a real `EmbedDaemon`, calls the real `.start()` (registering
 * all scheduled jobs including Job #9), and lets the scheduler run. Job #9 is
 * registered with `{ runImmediately: true }` (lib/embed/daemon.mjs), so
 * `Scheduler.start()` fires its first tick synchronously rather than waiting
 * for the 2-minute interval — the runner polls the filesystem in short
 * intervals for that tick's durable output instead of sleeping for the full
 * interval or mocking the scheduler.
 *
 * Asserts two durable artifacts land within that first tick:
 *   - an intake packet (lib/intake/queue.mjs contract) under
 *     .cx/intake/pending/ or .cx/intake/quarantine/ (low-confidence
 *     classifications route to quarantine per lib/intake/quarantine.mjs,
 *     so the test accepts either — both are real packets, just gated
 *     differently)
 *   - an observation under .cx/observations/ carrying the ['inbox',
 *     'ingested-doc'] tags lib/embed/inbox.mjs's recordInboxObservation()
 *     stamps on every successful ingest
 *
 * No network: the daemon config carries zero sources, so
 * ProviderRegistry.fromEnv() only ever resolves the credential-free
 * `directory` adapter, and CONSTRUCT_EMBEDDING_MODEL=hashing keeps
 * observation-store's embedding write local.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const RUNNER = join(__dirname, 'fixtures', 'embed-daemon-inbox-tick-runner.mjs');

const dirs = [];
after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

function freshProject() {
  const root = mkdtempSync(join(tmpdir(), 'cx-embed-daemon-inbox-'));
  dirs.push(root);
  mkdirSync(join(root, '.cx'), { recursive: true });
  writeFileSync(join(root, '.cx', 'context.md'), '# test project\n');
  mkdirSync(join(root, 'inbox'), { recursive: true });
  return root;
}

function runDaemonTick(root, timeoutMs = 15_000) {
  const env = sterileSpawnEnv({
    HOME: root,
    USERPROFILE: root,
    CX_HOME_OVERRIDE: root,
    CX_ROOT_DIR: root,
    TICK_TIMEOUT_MS: String(timeoutMs),
    CONSTRUCT_EMBEDDING_MODEL: 'hashing',
    CX_INBOX_LIVE_WATCH: 'off',
    CONSTRUCT_EMBED_ROADMAP_ENABLED: '0',
  });
  return spawnSync(process.execPath, [RUNNER], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
  });
}

test('real EmbedDaemon scheduler ingests a dropped inbox file and records a packet + observation within one tick', () => {
  const root = freshProject();
  writeFileSync(
    join(root, 'inbox', 'decision-note.md'),
    '# ADR-b2t01\n\nDecision: adopt the continuous inbox-watch daemon loop as the sole intake path.\n',
  );

  const res = runDaemonTick(root);
  assert.equal(res.status, 0, `runner exited non-zero — stdout: ${res.stdout}\nstderr: ${res.stderr}`);

  const result = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(result.ok, true, `tick did not produce packet + observation: ${JSON.stringify(result)}`);
  assert.ok(result.packetCount > 0, 'at least one intake packet (pending or quarantine) was created');
  assert.ok(result.observationCount > 0, 'at least one inbox observation was recorded');

  const packet = result.pending[0] ?? result.quarantine[0];
  assert.ok(packet, 'a packet object is present in the runner output');
  assert.match(packet.intake?.sourcePath ?? '', /decision-note\.md$/, 'packet traces back to the dropped file');

  const observation = result.observations[0];
  assert.ok(observation, 'an observation object is present in the runner output');
  assert.match(observation.content ?? '', /decision-note\.md/, 'observation content references the dropped file');
});

test('a second dropped file on a fresh daemon boot is also ingested (not a one-shot fluke)', () => {
  const root = freshProject();
  writeFileSync(
    join(root, 'inbox', 'retro-notes.md'),
    '# Retro\n\nMeeting notes: the team agreed to simplify the intake UX.\n',
  );

  const res = runDaemonTick(root);
  assert.equal(res.status, 0, `runner exited non-zero — stdout: ${res.stdout}\nstderr: ${res.stderr}`);

  const result = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(result.ok, true, `tick did not produce packet + observation: ${JSON.stringify(result)}`);
  const packet = result.pending[0] ?? result.quarantine[0];
  assert.match(packet.intake?.sourcePath ?? '', /retro-notes\.md$/);
});
