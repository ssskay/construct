/**
 * lib/embed/presets/pm-repos.mjs — deterministic engineering-signals analysis
 * for the `pm-repos` embed preset (product-manager watching GitHub + Jira
 * directly; see the embed-capability manifest schema decision record).
 *
 * Pure deterministic `reasoningExecutor(plan, ctx)` that the embed capability
 * tick accepts: reads the product-manager specialist's bound provider
 * snapshot slice (GitHub + Jira sections, already binding-scoped and
 * filter-narrowed by the caller) and surfaces two engineering signals a PM
 * cannot see from Jira/Confluence alone:
 *
 *   1. stalled pull requests — open PRs with no activity past a threshold,
 *      which stall a roadmap item silently.
 *   2. unlinked in-progress issues — Jira issues marked in-progress with no
 *      linked pull request, a gap between "claimed started" and observable
 *      engineering work.
 *
 * The output packet validates against the `pm-engineering-signals` output
 * contract. No writeIntent is emitted — the preset is artifact-only,
 * mirroring `pm-feedback`: a digest for a human PM to act on, never a
 * provider write.
 *
 * Every load-bearing claim carries provenance: a source id (owner/repo#number
 * for a PR, the Jira issue key) the reader can re-verify. A finding with no
 * covering source is never emitted.
 */

const GITHUB_PROVIDER = 'github';
const JIRA_PROVIDER = 'atlassian-jira';

// A PR with no update in this many days is reported stalled.
const STALE_PR_DAYS = 7;
const STALE_PR_MS = STALE_PR_DAYS * 24 * 60 * 60 * 1000;

const IN_PROGRESS_STATUSES = new Set(['in progress', 'in-progress']);

function sectionItems(sections, providerId) {
  const section = (sections || []).find((s) => s.provider === providerId);
  return Array.isArray(section?.items) ? section.items : [];
}

function prId(pr) {
  const repo = pr?.repo ?? 'unknown/unknown';
  const number = pr?.number ?? 'unknown';
  return `${repo}#${number}`;
}

// Normalize raw GitHub PR items into the shape the analysis reasons over.

export function inventoryPullRequests(prs) {
  if (!Array.isArray(prs)) return [];
  return prs.map((pr) => ({
    id: prId(pr),
    repo: pr?.repo ?? 'unknown',
    number: pr?.number ?? 'unknown',
    title: pr?.title ?? '[untitled]',
    state: pr?.state ?? 'unknown',
    draft: Boolean(pr?.draft),
    author: pr?.author ?? 'unknown',
    createdAt: pr?.createdAt ?? 'unknown',
    updatedAt: pr?.updatedAt ?? 'unknown',
    url: pr?.url ?? 'unknown',
    sourcePr: pr,
  }));
}

// Normalize raw Jira issue items into the shape the analysis reasons over.

export function inventoryIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    key: issue?.key ?? issue?.id ?? 'unknown',
    summary: issue?.summary ?? '[untitled]',
    status: issue?.status ?? 'unknown',
    updated: issue?.updated ?? issue?.updatedDate ?? 'unknown',
    linkedPrs: Array.isArray(issue?.linkedPrs) ? issue.linkedPrs : [],
    sourceIssue: issue,
  }));
}

// Open PRs with no update past STALE_PR_MS relative to `now`.

export function findStalledPRs(inventoriedPRs, now) {
  const findings = [];
  for (const pr of inventoriedPRs) {
    if (pr.state !== 'open') continue;
    const updated = Date.parse(pr.updatedAt);
    if (!Number.isFinite(updated)) continue;
    const ageMs = now - updated;
    if (ageMs < STALE_PR_MS) continue;

    const staleDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    findings.push({
      kind: 'stalled-pr',
      pr: pr.id,
      staleDays,
      evidence: { pr: pr.id, updatedAt: pr.updatedAt, staleDays },
      statement: `${pr.id} (${pr.title}) has had no activity for ${staleDays} day(s) — stalled (source ${pr.id}).`,
    });
  }
  return findings;
}

// Jira issues marked in-progress with zero linked pull requests.

export function findUnlinkedInProgressIssues(inventoriedIssues) {
  const findings = [];
  for (const issue of inventoriedIssues) {
    const status = String(issue.status ?? '').toLowerCase();
    if (!IN_PROGRESS_STATUSES.has(status)) continue;
    if (issue.linkedPrs.length > 0) continue;

    findings.push({
      kind: 'unlinked-in-progress',
      issue: issue.key,
      evidence: { issue: issue.key, status: issue.status },
      statement: `${issue.key} (${issue.summary}) is In Progress with no linked pull request (source ${issue.key}).`,
    });
  }
  return findings;
}

/**
 * Pure deterministic PM engineering-signals analysis: reads sections,
 * produces the output packet (contract shape) plus the structured analysis.
 * No write proposals — this preset is artifact-only, mirroring pm-feedback.
 */
export function analyzePmRepos(sections, { now = Date.now(), generatedAt } = {}) {
  const prs = sectionItems(sections, GITHUB_PROVIDER);
  const issues = sectionItems(sections, JIRA_PROVIDER);

  const inventoriedPRs = inventoryPullRequests(prs);
  const inventoriedIssues = inventoryIssues(issues);

  const stalledPrs = findStalledPRs(inventoriedPRs, now);
  const unlinkedIssues = findUnlinkedInProgressIssues(inventoriedIssues);

  const provenance = [
    ...inventoriedPRs.map((pr) => pr.id),
    ...inventoriedIssues.map((issue) => issue.key),
  ];

  const analysis = {
    generatedAt: generatedAt ?? new Date(now).toISOString(),
    inventoriedPRs,
    inventoriedIssues,
    stalledPrs,
    unlinkedIssues,
  };

  const summary = [
    `Watched ${inventoriedPRs.length} pull request(s) and ${inventoriedIssues.length} Jira issue(s).`,
    `Found ${stalledPrs.length} stalled PR(s).`,
    `Found ${unlinkedIssues.length} in-progress issue(s) with no linked PR.`,
  ].join(' ');

  // Each contract field is a section wrapper ({ count, items/findings }) so a
  // legitimately empty section still counts as present under the output
  // contract — an absent section signals a broken producer, an empty one
  // signals "checked, nothing found".
  const outputPacket = {
    prs: { count: inventoriedPRs.length, items: inventoriedPRs },
    issues: { count: inventoriedIssues.length, items: inventoriedIssues },
    stalledPrs: { count: stalledPrs.length, findings: stalledPrs },
    unlinkedIssues: { count: unlinkedIssues.length, findings: unlinkedIssues },
    provenance: { count: provenance.length, sources: provenance },
    summary,
  };

  return { analysis, outputPacket, writeProposals: [], summary };
}

/**
 * F5 reasoningExecutor: wraps analyzePmRepos for the embed capability tick;
 * accepts plan for F5 contract compatibility. Always returns an empty
 * writeProposals array — this preset never proposes a provider write.
 */
export function createPmReposReasoningExecutor(config = {}) {
  return async function pmReposReasoningExecutor(_plan, ctx = {}) {
    const { outputPacket, summary } = analyzePmRepos(ctx.sections ?? [], config);
    return { outputPacket, writeProposals: [], summary };
  };
}

export default createPmReposReasoningExecutor;
