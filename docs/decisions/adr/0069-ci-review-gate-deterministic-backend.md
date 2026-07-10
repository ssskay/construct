<!--
cx_doc_id and body_hash are stamped by construct on commit; omitted in this draft.
-->
# ADR-0069: The CI review gate runs a deterministic diff review, not a persona invocation

- **Date**: 2026-07-09
- **Status**: accepted
- **Deciders**: Gerald Dagher (owner)
- **Supersedes**: none
- **Relates to**: `.github/workflows/pr-review.yml` (the gate), `lib/review-pr.mjs` (the backend this ADR introduces), `lib/mcp/tools/project.mjs` (the `summarizeDiff`/`scanFile` heuristics it reuses), GitHub issue #359 / bead `construct-h7501` (the report that surfaced the gap)

<!-- Owning specialist: cx-architect. -->

## Problem

`pr-review.yml` — whose `review` job is a required-to-merge check on staging — invoked `construct review --pr=<n> --persona=cx-reviewer --output=.cx/pr-review.json` on every PR. That entry point never existed: the workflow landed in commit `20d39395` (W5 self-loop closures, 2026-05-26) without touching `bin/construct`, and `construct review` has been a telemetry performance report since the initial commit (`4a113b54`). Every invocation hit the Usage error, the step's `|| true` masked it, the fallback JSON was written, and the bot posted "construct review produced no output — manual review still required" on every PR — a required gate that stayed green while reviewing nothing (reported as GitHub issue #359).

A real cx-reviewer pass cannot run inside this gate. The only code path that produces reviewer findings with a verdict is the orchestration worker (`lib/orchestration/worker.mjs`), which calls provider HTTP APIs directly and throws `PROVIDER_KEY_MISSING` without a key; its INLINE/HOST backends instead require a driving host model. A fork-PR runner has neither — fork-triggered workflows receive no repo secrets — so any LLM-backed design makes the gate impossible to pass for exactly the outside contributors it gates.

## Options considered

1. **Reintroduce an LLM PR-diff review entry point and give CI a provider key.** Rejected: repo secrets are never exposed to fork-triggered workflows, so the gate would still be unrunnable for fork PRs; splitting behavior (LLM for in-repo, nothing for forks) reproduces the dishonesty this ADR removes, and puts a metered API spend on every push.
2. **Drop the job and remove `review` from the required checks.** Honest, but loses the per-PR review artifact and the Construct-on-Construct surface entirely, and requires a branch-protection change that nothing in-repo can verify.
3. **Repoint the gate at a deterministic backend that runs under fork constraints.** Chosen — see below.

## Decision

`construct review pr --base=<ref> [--output=<file>]` (`lib/review-pr.mjs`) is the gate's backend. Its contract:

1. **Fork-runnable by construction.** No model, no credentials, no network beyond `git fetch` of the base ref: diff shape via `summarizeDiff`, per-file findings via `scanFile`'s secret and quality heuristics (both already shipped in `lib/mcp/tools/project.mjs`; the CLI subcommand is the first non-MCP exposure).
2. **Merge-base semantics.** The diff is `<base>...HEAD`, so the review sees only the PR's own changes, never base-branch drift since the fork point.
3. **Findings are advisory; failure to run is not.** The command exits non-zero only when the review itself cannot run (missing/unknown ref, not a repository) — never on findings, because blocking enforcement belongs to the dedicated gates (secret scanning, lint suite). The workflow drops `|| true` and the fallback JSON: a review that cannot run fails the job visibly.
4. **Honest labeling.** The posted summary is titled `construct review pr (deterministic, read-only)`, not a persona attribution. An LLM cx-reviewer pass remains a local/orchestration capability where provider keys legitimately exist.
5. **Bounded scanning, no silent caps.** At most 200 changed files are scanned per review; anything dropped is stated in the summary.

Delivery is unchanged from the fork-safe split introduced for issue #359's sibling fix (PR #358): job summary for fork PRs, inline comment for in-repo PRs.

## Consequences

- The `review` required check now attests something true: a deterministic review ran over the PR's own diff and reported its findings.
- The findings are intentionally shallow (secret patterns, file/function-length heuristics). Depth stays with human review and the local cx-reviewer orchestration path; this gate never claims otherwise.
- If a metered LLM pass is ever wanted for in-repo PRs, it layers on as a separate, non-required job — this gate's contract does not change.
