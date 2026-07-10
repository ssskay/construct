---
intake: none
---

# cdsp.01 — Substrate Reconciliation Audit

Captured: 2026-07-09 · Bead: `construct-pteo2.1` · Epic: `construct-pteo2` (Condition-driven specialist participation)

This is a research artifact only — no code changes. Every claim below traces to a command
output or `file:line` observed directly in this worktree (branch `worktree-agent-a0be0e606f4483185`,
an ancestor of `staging` — confirmed below) or to a `bd show` record. Where nothing resolved, the
row says `unknown` explicitly rather than guessing, per this repo's no-fabrication rule
(`lib/comment-lint.mjs`).

## 0. Environment / branch check

```
$ git rev-parse HEAD staging
49cd3996223e0d6c6a432d1a5ab0af50976eefed   # HEAD (this worktree)
86438bd790cefd3646c813aecf4f135801ef94ca   # staging

$ git merge-base HEAD staging
49cd3996223e0d6c6a432d1a5ab0af50976eefed   # == HEAD, so HEAD is an ancestor of staging
```

HEAD is one merge commit behind `staging` (staging = HEAD + `#364 fix/acceptance-pack-race`,
19 files changed, none of them touch the primitives below). So file-content checks against the
working tree in this audit accurately reflect `staging`'s state for these primitives.

`.beads/issues.jsonl` does **not exist** in this checkout — `.beads/config.yaml` confirms this
repo runs Dolt-backed beads with JSONL export disabled by default (`export.git-add: false`,
`no-db: false`); the file is gitignored and only regenerated as an optional local export. `bd show`
/ `bd list` (the live Dolt-backed record) were used instead as the authoritative equivalent, per
the bead's own instruction to "run `bd show construct-pteo2.1` for the live record."

## 1. Matrix

| Primitive | Owning bead | Branch it landed on | On staging? | Evidence |
|---|---|---|---|---|
| ca4 — proactive activation ("watchers") | `construct-ca4` (CLOSED, P1) | merged to mainline pre-`staging` split | **yes** | `git log --oneline --all --grep="proactive activation" -i` → `93f14f33 feat(activation): proactive activation framework + contract-postcondition tests` (May 13 2026, adds `requestSignals`/`triggersOn`-style signal fields to `lib/orchestration-policy.mjs`). `git merge-base --is-ancestor 93f14f33 staging` → `ON_STAGING`. **Caveat**: no bead or commit anywhere in `git log --all` ties `construct-ca4` to `lib/doctor/watchers/` — that directory (`bd-watch.mjs`, `consistency.mjs`, `cost.mjs`, `source-targets.mjs`, etc., confirmed via `git ls-files lib/doctor/watchers`) was built incrementally by unrelated beads (`construct-760c.8`, `construct-d1r7.3`, `construct-rf26.12`, `construct-iwfz.4`, per `git log --oneline --all -- lib/doctor/watchers`). The epic description for `construct-pteo2` itself confirms the real gap: "WATCHERS still hardcoded despite closed `construct-lyxx`... `construct-ca4` shipped only the 5-watcher subset of its own `triggersOn` vision" (`lib/orchestration/routing-tables.mjs:29`) — i.e. ca4 landed a *partial* signal-routing primitive, not a file-watcher subsystem. |
| lyxx — declarative routing | `construct-lyxx` (CLOSED, P1, "Piece A: declarative routing") | merged to mainline pre-`staging` split | **yes** | `git log --oneline --all --grep="declarative routing" -i` → `e4159ef3 refactor: declarative routing tables resolved from registry` (May 29 2026) plus its merge `090457db`. Commit body: "Routing data... now lives on specialist entries in `specialists/registry.json` and is resolved at startup by `lib/orchestration/routing-tables.mjs`." `git merge-base --is-ancestor e4159ef3 staging` → `ON_STAGING`. Confirmed live in `lib/orchestration/routing-tables.mjs:2,8,15,23,67-69` (resolver reads `loadRegistry()`, throws if registry malformed — no hardcoded `EVENT_OWNERSHIP`/`DOC_OWNERSHIP` constants remain). |
| oracle swarm recruiter (6dc3) | `construct-6dc3` (CLOSED, P2, "Refactor Oracle routing to utilize dynamic swarm assembly") | **unknown — no commit or branch found** | **no** | `bd show construct-6dc3` marks the bead CLOSED but carries **no close-reason field** (unlike every other bead audited here, which all record a landing commit in their close reason). `git log --oneline --all --grep="construct-6dc3"` → empty. `git log --oneline --all --grep="GAP_ROUTES"` and `--grep="dynamic swarm"` → empty. A branch scan (`for b in $(git branch -a...); do git show "$b:lib/oracle/routing.mjs" \| grep requiredSkills; done`) across every local/remote branch → **zero matches** for `requiredSkills` in `lib/oracle/routing.mjs` on any branch. Current `lib/oracle/routing.mjs:13-44` still hardcodes `GAP_ROUTES` as `{ primary: 'cx-...', secondary: 'cx-...' }` pairs — exactly the shape the bead's own description says to replace. What **did** land is the bead's dependency, `construct-m7k2.7` ("Oracle oversight + optional swarm, additive dispatch") via `7d10a7a5 feat(m7k2): oracle swarm dispatch and ADR surface amendments`, confirmed `ON_STAGING` — this gave `lib/oracle/dispatch.mjs:40,64` a `dispatch.mode === 'swarm'` branch, but the GAP_ROUTES→requiredSkills dynamic-recruitment refactor that is 6dc3's actual scope was never implemented anywhere in git history despite the bead being closed. Treat 6dc3 as **stranded/undone work misfiled as closed**, not as a branch-reconciliation problem — there is nothing to cherry-pick. This matches the epic's own substrate note: "`lib/oracle/dispatch.mjs` EXISTS (reusable recruiter seed, `construct-6dc3`)" — i.e. only the seed (m7k2.7), not 6dc3's dynamic-skill routing. |
| org-api / org-studio (d1r7.13 / d1r7.14) | `construct-d1r7.13` (CLOSED, P0) / `construct-d1r7.14` (CLOSED, P1) | `refactor/consolidate-project-config-dir` | **no** | `git ls-files lib/org-studio lib/registry/org-api.mjs` → **empty output** (verified live, see §2). `git log --oneline --all --grep="construct-d1r7.13"` → `ff1803b0 ADR-0071 + ADR-0072: RichDocument IR and no-code org authoring API`. `git log --oneline --all --grep="construct-d1r7.14"` → `d984277d feat(studio): Org Studio — visual no-code specialist/team/contract editor`, plus its dependency `a29cde85 Implement lib/registry/org-api.mjs core module per ADR-0072` (bead `construct-bnmv`). All three (`ff1803b0`, `a29cde85`, `d984277d`) resolve only to `refactor/consolidate-project-config-dir` (local + `origin/refactor/consolidate-project-config-dir`); `git merge-base --is-ancestor <sha> staging` → `NOT_ON_STAGING` for all three. `bd show construct-d1r7.14` close reason: "Org Studio visual no-code editor landed (`d984277d`)... `construct studio` launches a zero-dependency `node:http` server (`lib/org-studio/server.mjs`)... over `lib/registry/org-api.mjs`" — closed as done, but the code is stranded off `staging`. |
| routePath (d1r7.15) | `construct-d1r7.15` (CLOSED, P0, "Expose specialist route path across CLI, MCP, traces, and UI") | `refactor/consolidate-project-config-dir` | **no** | `grep -n routePath lib/orchestration/*.mjs` → **empty output** (verified live, see §2 — no `routePath` symbol anywhere in `lib/orchestration/`). `git log --oneline --all --grep="construct-d1r7.15"` → `69ea7853 Expose routePath across CLI, MCP, traces, and handoffs`. Same branch/ancestry check as above: only on `refactor/consolidate-project-config-dir`, `NOT_ON_STAGING`. `bd show construct-d1r7.15` depends on `construct-d1r7.13` (org-api) — same stranded branch, so this and the org-api/org-studio row are one physical branch to reconcile, not three. |
| executable postconditions (rf26.12) | `construct-rf26.12` (CLOSED, P1, "Contracts become delegation specs; convert checkable prose postconditions to executable checks") | merged to mainline pre-`staging` split | **yes** | `git log --oneline --all --grep="construct-rf26.12"` → `5ccfafd4 feat(contracts): classify postconditions executable\|advisory, wire output-shape + nested schema enforcement`. Its follow-on fix `41afbd0f fix(contracts): classify 3 contracts added after the rf26.12 audit snapshot` also found via the same `d1r7` grep sweep. Both: `git merge-base --is-ancestor <sha> staging` → `ON_STAGING`. `bd show construct-rf26.12` close reason confirms 39/123 postconditions classified executable, 72 advisory, "0 unclassified," verified against `tests/contracts-coverage.test.mjs` etc. **Caveat** (from the epic description, not independently re-verified in this pass): "rf26.12 executable postconditions exist but nothing calls them in-run" — the classification landed; wiring the classified checks into the live run/authoring path is `construct-pteo2.14` (cdsp.50), still open. |

## 2. Raw verification command output (as required by the bead)

```
$ git ls-files lib/org-studio lib/registry/org-api.mjs
(no output)

$ grep -n routePath lib/orchestration/*.mjs
(no output)

$ ls lib/org-studio 2>&1; ls lib/registry/org-api.mjs 2>&1
"lib/org-studio": No such file or directory (os error 2)
"lib/registry/org-api.mjs": No such file or directory (os error 2)

$ git branch -a
  feat/construct-760c-2-multiroot-corpus
  feat/construct-760c-3-cross-project-synthesis
  feat/construct-760c-4-context-bindings
  feat/construct-760c-6-jira-contribution
  feat/construct-760c-8-sources-ux-docs
  main
  refactor/consolidate-project-config-dir
+ staging
  worktree-agent-* (5 active worktrees)
  remotes/origin/HEAD -> origin/main
  remotes/origin/deps/dependabot-remediation
  remotes/origin/feat/construct-760c-2-multiroot-corpus
  remotes/origin/feat/construct-760c-3-cross-project-synthesis
  remotes/origin/feat/construct-760c-4-context-bindings
  remotes/origin/feat/construct-760c-6-jira-contribution
  remotes/origin/feat/construct-760c-8-sources-ux-docs
  remotes/origin/fix/acceptance-pack-race
  remotes/origin/main
  remotes/origin/refactor/consolidate-project-config-dir
  remotes/origin/staging

$ git log --oneline --all --grep=ca4 -i
89783294 ci(deps): bump pinned action SHAs to current majors (supersedes #338-#342)   # false-positive match (unrelated PR numbers), not construct-ca4

$ git log --oneline --all --grep="construct-ca4" -i
(no output — no commit references the bead id directly)

$ git log --oneline --all --grep="proactive activation" -i
272de2e2 Release 1.0.1 — telemetry, init, CLI restructuring, database cleanup (#52)
c2aad0d9 feat: 2026 AI agent best practices and dogfooding configuration
93f14f33 feat(activation): proactive activation framework + contract-postcondition tests

$ git log --oneline --all --grep=lyxx -i
(no output on the bare fragment)

$ git log --oneline --all --grep="declarative routing" -i
090457db Merge pull request #110 from geraldmaron/release/coherence-bundle
e4159ef3 refactor: declarative routing tables resolved from registry

$ git log --oneline --all --grep=6dc3 -i
(no output)

$ git log --oneline --all --grep="swarm recruiter" -i
(no output)

$ git log --oneline --all --grep=d1r7 -i   (excerpt, full run showed 17 commits)
d984277d feat(studio): Org Studio — visual no-code specialist/team/contract editor (construct-d1r7.14)
69ea7853 Expose routePath across CLI, MCP, traces, and handoffs
a29cde85 Implement lib/registry/org-api.mjs core module per ADR-0072
ff1803b0 ADR-0071 + ADR-0072: RichDocument IR and no-code org authoring API

$ git log --oneline --all --grep=rf26 -i   (excerpt, full run showed 24 commits)
5ccfafd4 feat(contracts): classify postconditions executable|advisory, wire output-shape + nested schema enforcement (construct-rf26.12)
41afbd0f fix(contracts): classify 3 contracts added after the rf26.12 audit snapshot

$ git merge-base --is-ancestor e4159ef3 staging && echo YES || echo NO
YES
$ git merge-base --is-ancestor 93f14f33 staging && echo YES || echo NO
YES
$ git merge-base --is-ancestor 5ccfafd4 staging && echo YES || echo NO
YES
$ git merge-base --is-ancestor 41afbd0f staging && echo YES || echo NO
YES
$ git merge-base --is-ancestor d984277d staging && echo YES || echo NO
NO
$ git merge-base --is-ancestor a29cde85 staging && echo YES || echo NO
NO
$ git merge-base --is-ancestor 69ea7853 staging && echo YES || echo NO
NO
$ git merge-base --is-ancestor ff1803b0 staging && echo YES || echo NO
NO

$ git branch -a --contains d984277d   # (also true for a29cde85, 69ea7853, ff1803b0)
  refactor/consolidate-project-config-dir
  remotes/origin/refactor/consolidate-project-config-dir

$ for b in $(git branch -a | grep -v worktree | sed 's/^[* +]*//'); do
    git show "$b:lib/oracle/routing.mjs" 2>/dev/null | grep -c requiredSkills
  done   # every branch: 0 matches — confirms 6dc3's GAP_ROUTES refactor is nowhere in git history

$ grep -n "GAP_ROUTES\|primary\|secondary\|requiredSkills" lib/oracle/routing.mjs | head
13:const GAP_ROUTES = {
14:  'parity-drift': { primary: 'cx-engineer', secondary: 'cx-operations' },
...   # still hardcoded primary/secondary — the pre-6dc3 shape
```

`.beads/issues.jsonl` search commands (`grep -i "<fragment>" .beads/issues.jsonl`) were attempted
per the bead's instructions but the file does not exist in this checkout (see §0) — `ugrep`
returned `No such file or directory` for every fragment. `bd show` was used as the equivalent live
source and its output is quoted inline in §1.

## 3. Recommended cherry-pick / rebase order

Binding user decision (already made, not re-litigated here): **reconcile-first** — bring the
stranded work onto `staging` before building `cdsp` on top of it. The question this section
answers is *order*, based on dependency between the primitives themselves.

1. **`refactor/consolidate-project-config-dir` → `staging`, as one unit, first.**
   Justification: `ff1803b0` (org-api ADR) → `a29cde85` (org-api core, `construct-bnmv`) →
   `d984277d` (Org Studio UI, `construct-d1r7.14`) → `69ea7853` (routePath, `construct-d1r7.15`)
   are a strict, bead-declared dependency chain on this **one** branch (`bd show
   construct-d1r7.14` DEPENDS ON `construct-bnmv` + `construct-d1r7.13`; `bd show
   construct-d1r7.15` DEPENDS ON `construct-d1r7.13`). There is nothing to interleave with other
   branches for this step — rebase/cherry-pick the whole branch (or fast-forward-merge it) onto
   `staging` preserving its internal commit order, since routePath (`69ea7853`) is built to read
   the org-api/Org-Studio surface (`lib/registry/org-api.mjs`) that must exist first. This
   single branch reconciles 3 of the 6 audited primitives (org-api, Org Studio, routePath) in one
   move.

2. **No second cherry-pick step exists for `6dc3`.**
   Justification: there is no commit or branch containing the dynamic-swarm-assembly
   (`GAP_ROUTES`→`requiredSkills`) implementation anywhere in `git log --all` (verified by the
   full-branch scan in §2). The bead is closed in `bd` but the work was never committed. This is
   not a reconciliation-order problem — it must be **re-opened and re-implemented** (tracked
   downstream as `construct-pteo2.5`, see §4), building on the `m7k2.7` swarm-dispatch seed
   (`7d10a7a5`, already on `staging`) and on step 1's routing surface (a `requiredSkills`-based
   `GAP_ROUTES` refactor should read specialist skills from the same registry-declared shape that
   `lyxx`'s resolver established, so it logically follows step 1's org-api landing even though
   there is no branch to pull for it).

3. **`ca4` and `lyxx` and `rf26.12` require no action.**
   Justification: all three are already ancestors of `staging` (confirmed `ON_STAGING` in §1/§2).
   They are the substrate the `cdsp` epic builds on directly — no reconciliation ordering applies,
   only the "still stub/partial" caveats noted in §1 (ca4's 5-watcher subset gap in
   `lib/orchestration/routing-tables.mjs:29`; rf26.12's classified-but-unwired postconditions).

**Net order: (1) cherry-pick/merge `refactor/consolidate-project-config-dir` onto `staging` in its
existing commit order (`ff1803b0` → `a29cde85` → `d984277d` → `69ea7853`) — this is the only real
reconciliation action available; (2) treat `6dc3`'s dynamic-swarm-assembly as net-new work on top
of the reconciled branch, not a merge.** `ca4`, `lyxx`, and `rf26.12` need no branch action.

## 4. Downstream `cdsp` beads and their substrate precondition

Source: `bd show construct-pteo2` children list (2026-07-09).

| cdsp bead | Title | Substrate precondition (from the matrix above) |
|---|---|---|
| `construct-pteo2.2` (cdsp.02) | ADR: participation pipeline + registry-declared `participationRules` schema | `lyxx` declarative routing (on staging) — the new schema must extend the registry-declared shape `lyxx` already established in `specialists/registry.json`, not reintroduce hardcoded constants. |
| `construct-pteo2.3` (cdsp.10) | Expand + externalize the signal set | `ca4` proactive activation (on staging, partial) — extends `requestSignals`/`triggersOn` beyond the 5-watcher subset currently hardcoded at `lib/orchestration/routing-tables.mjs:29`. |
| `construct-pteo2.4` (cdsp.11) | Artifact-content signals (post-draft) | `ca4` proactive activation (on staging) — same signal-set primitive, extended to read produced-artifact content rather than only request text. |
| `construct-pteo2.5` (cdsp.20) | Generalize the Oracle swarm recruiter → `lib/orchestration/recruiter.mjs` | `6dc3` oracle swarm recruiter — **blocked on re-implementation**, not reconciliation (see §3 step 2); builds on the `m7k2.7` swarm-dispatch seed already on staging (`lib/oracle/dispatch.mjs`). |
| `construct-pteo2.6` (cdsp.21) | Coverage: every specialist/team is recruitable | `6dc3` (same precondition as cdsp.20) plus `lyxx` declarative routing for registry-declared coverage. |
| `construct-pteo2.7` (cdsp.22) | Reference vertical: cost/financial participation | `6dc3` generalized recruiter (cdsp.20) as its direct prerequisite. |
| `construct-pteo2.8` (cdsp.30) | `author_artifact` recruits | `ca4`/`lyxx` signal+routing substrate (on staging) — wires `routeRequest` into the authoring path, which today never calls it per the epic description. |
| `construct-pteo2.9` (cdsp.31) | Workflows: `roleChain` is a floor, not a ceiling | `lyxx` declarative routing (on staging). |
| `construct-pteo2.10` (cdsp.32) | Skills reference the recruited set (cross-surface parity) | `lyxx` + `d1r7.15` routePath — **blocked**, routePath is stranded on `refactor/consolidate-project-config-dir` (§1/§3 step 1) and must be reconciled first. |
| `construct-pteo2.11` (cdsp.40) | Collaboration / join-leave (swarm) | `6dc3`/`m7k2.7` swarm substrate — same re-implementation blocker as cdsp.20. |
| `construct-pteo2.12` (cdsp.41) | Execution honesty for recruited participants | `rf26.12` executable postconditions (on staging, classified-but-unwired) — this bead is effectively the "wire it into the run path" follow-up the rf26.12 close reason already flagged as not done. |
| `construct-pteo2.13` (cdsp.42) | Enforced sign-off gate (advisory default, opt-in blocking) | `rf26.12` executable postconditions (on staging) as the mechanism the gate enforces against. |
| `construct-pteo2.14` (cdsp.50) | Enforce executable postconditions in the run/authoring path | `rf26.12` (on staging, direct precondition — this is exactly the "nothing calls them in-run" gap noted in §1). |
| `construct-pteo2.15` (cdsp.60) | Org Studio: participation-rules canvas | `d1r7.13`/`d1r7.14` org-api/Org Studio — **blocked**, stranded on `refactor/consolidate-project-config-dir` (§1/§3 step 1); this is the exact example the bead's own acceptance criteria cites ("cherry-pick before cdsp.60"). |
| `construct-pteo2.16` (cdsp.61) | CLI/MCP parity for participation rules | `d1r7.13` org-api (stranded, same precondition as cdsp.60) as the single writer both CLI and MCP must sit as thin envelopes over. |
| `construct-pteo2.17` (cdsp.70) | Orphan-sweep matrix across specialists/teams/skills/contracts | `lyxx` declarative routing (on staging) as the registry source of truth the sweep audits against. |
| `construct-pteo2.18` (cdsp.71) | Cross-surface parity + routePath reconcile | `d1r7.15` routePath — **blocked**, directly names the stranded primitive from §1/§3 step 1. |
| `construct-pteo2.19` (cdsp.80) | FMEA challenge of the participation model | No single primitive precondition — reviews the design once cdsp.02's ADR exists; indirectly depends on all of the above being either landed or explicitly flagged stranded (this audit). |
| `construct-pteo2.20` (cdsp.81) | Threat/abuse review: recruitment over untrusted content | `6dc3`/generalized recruiter (cdsp.20) as the mechanism under threat review. |
| `construct-pteo2.21` (cdsp.82) | Prior-art and substrate validation research brief | This audit (`cdsp.01`) directly — cdsp.82 is the research follow-up to the substrate state recorded here. |

## 5. Summary

- **On `staging` already**: `ca4` proactive activation (partial — 5-watcher subset only),
  `lyxx` declarative routing (complete for its scope), `rf26.12` executable postconditions
  (classified, not yet wired into the run path).
- **Stranded on `refactor/consolidate-project-config-dir`, needs cherry-pick/merge**: `d1r7.13`
  org-api, `d1r7.14` Org Studio, `d1r7.15` routePath — one branch, one reconciliation action,
  strict internal dependency order (`ff1803b0` → `a29cde85` → `d984277d` → `69ea7853`).
  Confirmed absent from the working tree: `git ls-files lib/org-studio lib/registry/org-api.mjs`
  returns nothing; `grep -n routePath lib/orchestration/*.mjs` returns nothing.
- **Closed in `bd` but never actually committed anywhere**: `6dc3` oracle swarm recruiter. No
  commit, no branch, `GAP_ROUTES` in `lib/oracle/routing.mjs` is still the pre-6dc3 hardcoded
  `primary`/`secondary` shape on every branch in this repository. This is not a merge-order
  problem — the work does not exist to reconcile.
