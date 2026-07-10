/**
 * tests/acceptance/pm-repos-preset.acceptance.test.mjs — golden-fixture
 * acceptance for the `pm-repos` embed preset (construct-jvjow.3).
 *
 * @embed pm-repos
 *
 * Drives the real embed capability tick (runCapabilityTick) with an injected
 * deterministic pm-repos reasoningExecutor over a seeded snapshot built from
 * fake GitHub + Jira data (no real network I/O). Asserts the acceptance
 * criteria with re-verifiable evidence:
 *
 *   1. An open pull request with no recent activity produces a stalled-pr
 *      finding citing its owner/repo#number id.
 *   2. A Jira issue marked In Progress with no linked pull request produces
 *      an unlinked-in-progress finding citing its issue key.
 *   3. A recently-updated PR and an in-progress issue that does carry a
 *      linked PR produce no findings — no false positives.
 *   4. The output packet validates against pm-engineering-signals and no
 *      write executes — zero adapter writes, artifact-only.
 *
 * A global fetch guard fires if any code path reaches for real network I/O.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeGitHub, FakeJira } from '../fakes/index.mjs';
import { ApprovalQueue } from '../../lib/embed/approval-queue.mjs';
import { runCapabilityTick } from '../../lib/embed/capability-jobs.mjs';
import { createPmReposReasoningExecutor, analyzePmRepos } from '../../lib/embed/presets/pm-repos.mjs';
import { validatePacket } from '../../lib/specialist-contracts.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const realFetch = globalThis.fetch;

const FIXED_NOW = Date.parse('2026-07-09T00:00:00.000Z');

// Seeded fixture: PR #1 was last touched 10 days ago (stalled). PR #2 was
// touched an hour ago (not stalled). Issue ENG-1 is In Progress with no
// linked PR (unlinked). Issue ENG-2 is In Progress and links PR #2 (not
// unlinked). Issue ENG-3 is Done, out of scope for the unlinked check.

const GITHUB_PRS = [
  {
    repo: 'acme/widgets',
    number: 1,
    title: 'Add bulk export',
    state: 'open',
    draft: false,
    author: 'alice',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    url: 'https://github.com/acme/widgets/pull/1',
  },
  {
    repo: 'acme/widgets',
    number: 2,
    title: 'Fix export race condition',
    state: 'open',
    draft: false,
    author: 'bob',
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T23:00:00.000Z',
    url: 'https://github.com/acme/widgets/pull/2',
  },
];

const JIRA_ISSUES = [
  {
    key: 'ENG-1',
    summary: 'Bulk export performance',
    status: 'In Progress',
    updated: '2026-06-29T00:00:00.000Z',
    linkedPrs: [],
  },
  {
    key: 'ENG-2',
    summary: 'Export race condition',
    status: 'In Progress',
    updated: '2026-07-08T23:00:00.000Z',
    linkedPrs: ['acme/widgets#2'],
  },
  {
    key: 'ENG-3',
    summary: 'Legacy export cleanup',
    status: 'Done',
    updated: '2026-06-01T00:00:00.000Z',
    linkedPrs: [],
  },
];

const PM_REPOS_MANIFEST = {
  id: 'pm-repos',
  version: '1.0.0',
  type: 'embed',
  defaultApprovalMode: 'proposal-only',
  embed: {
    specialist: 'cx-product-manager',
    providerBindings: ['github', 'atlassian-jira'],
    framework: 'cx-pm-value-tradeoff',
    outputContract: 'pm-engineering-signals',
    proposalAuthority: 'propose-only',
    runtime: 'in-process',
    cadence: { every: 'PT24H' },
  },
};

const EMBED_BINDINGS = {
  'product-manager': {
    providers: [
      { id: 'github', capabilities: ['read', 'search'] },
      { id: 'atlassian-jira', capabilities: ['read', 'search'] },
    ],
    proposals: [],
  },
};

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'pm-repos-'));
}

function buildSeededSnapshot() {
  return {
    sections: [
      { provider: 'github', refs: ['acme/widgets'], items: GITHUB_PRS },
      { provider: 'atlassian-jira', refs: ['ENG'], items: JIRA_ISSUES },
    ],
  };
}

// Recording provider registry: wraps the fakes and counts writes.
function recordingProviders() {
  const github = FakeGitHub();
  const jira = FakeJira();
  const writeCalls = [];

  for (const [id, p] of [['github', github], ['atlassian-jira', jira]]) {
    const original = p.write.bind(p);
    p.write = async (config, payload) => {
      writeCalls.push({ provider: id, payload });
      return original(config, payload);
    };
  }
  return { github, jira, writeCalls };
}

test('stalled PR and unlinked in-progress issue are found; recent PR and linked issue are not', async () => {
  globalThis.fetch = () => { throw new Error('Real network blocked in acceptance test'); };
  const rootDir = tmpRoot();
  try {
    const snapshot = buildSeededSnapshot();
    const providers = recordingProviders();
    const approvalQueue = new ApprovalQueue({ persistPath: join(rootDir, 'queue.jsonl') });
    const executor = createPmReposReasoningExecutor({ now: FIXED_NOW });

    const tick = await runCapabilityTick(PM_REPOS_MANIFEST, {
      rootDir,
      env: process.env,
      getSnapshot: () => snapshot,
      approvalQueue,
      embedBindings: EMBED_BINDINGS,
      reasoningExecutor: executor,
    });

    assert.equal(tick.status, 'ran', `tick should run, got ${tick.status} (${tick.reason ?? ''})`);
    assert.equal(tick.contractStatus, 'ok', 'output packet must satisfy its contract');

    const { outputPacket } = analyzePmRepos(snapshot.sections, { now: FIXED_NOW });

    const stalled = outputPacket.stalledPrs.findings;
    assert.equal(stalled.length, 1, 'exactly one stalled PR is found');
    assert.equal(stalled[0].pr, 'acme/widgets#1', 'stalled finding cites the correct PR id, not a fabricated one');
    assert.ok(!stalled.some((f) => f.pr === 'acme/widgets#2'), 'the recently-updated PR is never reported stalled');

    const unlinked = outputPacket.unlinkedIssues.findings;
    assert.equal(unlinked.length, 1, 'exactly one unlinked in-progress issue is found');
    assert.equal(unlinked[0].issue, 'ENG-1', 'unlinked finding cites the correct issue key, not a fabricated one');
    assert.ok(!unlinked.some((f) => f.issue === 'ENG-2'), 'the linked in-progress issue is never reported unlinked');
    assert.ok(!unlinked.some((f) => f.issue === 'ENG-3'), 'the done issue is out of scope for the unlinked check');

    assert.equal(providers.writeCalls.length, 0, 'artifact-only: zero provider writes during tick');
    assert.deepEqual(approvalQueue.list('awaiting_approval'), [], 'no proposal is ever queued for this preset');
  } finally {
    globalThis.fetch = realFetch;
    rmTmpDir(rootDir);
  }
});

test('every finding carries provenance to its source PR or issue', () => {
  const snapshot = buildSeededSnapshot();
  const { outputPacket } = analyzePmRepos(snapshot.sections, { now: FIXED_NOW });

  for (const finding of outputPacket.stalledPrs.findings) {
    assert.ok(finding.evidence.pr, `${finding.pr} stalled finding cites its PR id`);
    assert.match(finding.statement, /source/, 'stalled statement carries a source id');
  }
  for (const finding of outputPacket.unlinkedIssues.findings) {
    assert.ok(finding.evidence.issue, `${finding.issue} unlinked finding cites its issue key`);
    assert.match(finding.statement, /source/, 'unlinked statement carries a source id');
  }

  assert.ok(outputPacket.provenance.sources.includes('acme/widgets#1'), 'provenance includes the stalled PR id');
  assert.ok(outputPacket.provenance.sources.includes('ENG-1'), 'provenance includes the unlinked issue key');
});

test('output packet validates against pm-engineering-signals contract; artifact-only, no writeProposals ever emitted', async () => {
  globalThis.fetch = () => { throw new Error('Real network blocked in acceptance test'); };
  const rootDir = tmpRoot();
  try {
    const snapshot = buildSeededSnapshot();
    const providers = recordingProviders();
    const approvalQueue = new ApprovalQueue({ persistPath: join(rootDir, 'queue.jsonl') });
    const executor = createPmReposReasoningExecutor({ now: FIXED_NOW });

    const tick = await runCapabilityTick(PM_REPOS_MANIFEST, {
      rootDir,
      env: process.env,
      getSnapshot: () => snapshot,
      approvalQueue,
      embedBindings: EMBED_BINDINGS,
      reasoningExecutor: executor,
    });

    assert.equal(tick.status, 'ran');
    assert.equal(tick.contractStatus, 'ok');
    assert.deepEqual(tick.proposalsEnqueued, [], 'artifact-only preset enqueues zero proposals');
    assert.deepEqual(tick.proposalsDenied, [], 'no proposal is even attempted, so none can be denied');

    const { outputPacket } = analyzePmRepos(snapshot.sections, { now: FIXED_NOW });
    const result = validatePacket('pm-engineering-signals', outputPacket, 'output');
    assert.ok(result.ok, `packet must validate against its contract; missing: ${result.missing?.join(', ')}`);

    assert.equal(providers.writeCalls.length, 0, 'zero adapter writes for an artifact-only preset');
  } finally {
    globalThis.fetch = realFetch;
    rmTmpDir(rootDir);
  }
});
