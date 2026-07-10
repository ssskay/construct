/**
 * lib/review-pr.mjs — deterministic PR-diff review backing `construct review pr`
 * and the CI `review` gate (.github/workflows/pr-review.yml).
 *
 * Reviews HEAD against a base ref under the constraint set of a fork-PR
 * runner: zero repo secrets and zero model access. Diff shape comes from
 * summarizeDiff; per-file findings come from scanFile's secret and quality
 * heuristics over the added and modified files. Findings are advisory — the
 * command exits non-zero only when the review itself cannot run (bad ref,
 * not a repository), never on findings, because blocking enforcement belongs
 * to the dedicated gates (secret scanning, lint suite). ADR-0069 records the
 * decision that replaced the never-implemented cx-reviewer persona invocation
 * with this backend.
 */

import fs from 'node:fs';
import path from 'node:path';

import { scanFile, summarizeDiff } from './mcp/tools/project.mjs';

const MAX_SCANNED_FILES = 200;

export function reviewPrDiff({ baseRef, cwd = process.cwd() } = {}) {
  if (typeof baseRef !== 'string' || !baseRef.trim()) {
    return { error: 'baseRef is required' };
  }

  // Three-dot semantics (merge-base..HEAD) so the review sees only the PR's
  // own changes, never the base branch's drift since the fork point.

  const base = baseRef.trim();
  const diff = summarizeDiff({ base_ref: `${base}...HEAD`, cwd });
  if (diff.error) return { error: diff.error };

  const reviewable = diff.changes.filter((c) => c.status === 'A' || c.status === 'M');
  const scanned = reviewable.slice(0, MAX_SCANNED_FILES);
  const skipped = reviewable.length - scanned.length;

  const findings = [];
  for (const change of scanned) {
    const scan = scanFile({ cwd, file_path: change.file });
    if (scan.error) {
      findings.push({ severity: 'info', file: change.file, message: `${change.file}: not scanned (${scan.error})` });
      continue;
    }
    for (const secret of scan.secrets ?? []) {
      findings.push({
        severity: 'high',
        file: change.file,
        line: secret.line,
        message: `possible secret (${secret.pattern}) at ${change.file}:${secret.line}`,
      });
    }
    for (const issue of scan.quality_issues ?? []) {
      findings.push({
        severity: 'info',
        file: change.file,
        ...(issue.line ? { line: issue.line } : {}),
        message: `${issue.type} in ${change.file}: ${issue.detail}`,
      });
    }
  }

  const high = findings.filter((f) => f.severity === 'high').length;
  const counts = `${findings.length} finding${findings.length === 1 ? '' : 's'} (${high} high) across ${scanned.length} scanned file${scanned.length === 1 ? '' : 's'}.`;
  const cap = skipped > 0 ? ` ${skipped} additional changed file${skipped === 1 ? '' : 's'} not scanned (cap: ${MAX_SCANNED_FILES}).` : '';

  return {
    generated_by: 'construct review pr',
    base_ref: base,
    diff: { files_changed: diff.files_changed, insertions: diff.insertions, deletions: diff.deletions },
    scanned_files: scanned.length,
    skipped_files: skipped,
    summary: `Deterministic diff review — ${diff.summary} ${counts}${cap}`,
    findings,
  };
}

export function runReviewPrCli(argv, { cwd = process.cwd() } = {}) {
  let baseRef = null;
  let output = null;
  for (const arg of argv) {
    if (arg.startsWith('--base=')) baseRef = arg.slice('--base='.length);
    else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
    else return { exitCode: 1, error: `Unknown argument: ${arg}\nUsage: construct review pr --base=<ref> [--output=<file>]` };
  }
  if (!baseRef) {
    return { exitCode: 1, error: 'Usage: construct review pr --base=<ref> [--output=<file>]' };
  }

  const result = reviewPrDiff({ baseRef, cwd });
  if (result.error) return { exitCode: 1, error: result.error };

  const json = JSON.stringify(result, null, 2);
  let outputPath = null;
  if (output) {
    outputPath = path.resolve(cwd, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${json}\n`);
  }
  return { exitCode: 0, result, json, outputPath };
}
