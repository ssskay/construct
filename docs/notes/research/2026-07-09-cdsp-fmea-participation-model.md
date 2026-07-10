---
intake: none
---

# cdsp.80 — FMEA Challenge of the Condition-Driven Participation Model

Captured: 2026-07-09 · Bead: `construct-pteo2.19` · Epic: `construct-pteo2` (Condition-driven specialist participation) · Role: `cx-reviewer` devil's-advocate pass, methodology per `skills/roles/devil-advocate.md`

This is a research artifact only — no runtime code changes. Every failure mode below is grounded in a
`file:line` read directly in this worktree, in `docs/decisions/adr/0070-participation-pipeline-and-rules-schema.md`
(ADR-0070, the design this FMEA challenges), or in `schemas/participation-rules.schema.json`. Where a
mechanism does not exist yet (it is scoped to a still-open child bead), the row says so explicitly rather
than describing code that isn't there, per this repo's no-fabrication rule (`lib/comment-lint.mjs`).

## Method

Per `skills/roles/devil-advocate.md`'s FMEA pass: for each failure mode, name the effect and the cause,
then score **severity** (how bad the effect, 1–10), **occurrence** (how likely the cause, 1–10), and
**detection** (how likely the failure is caught before harm — high score = hard to detect, 1–10). RPN =
severity × occurrence × detection. Ranked by RPN, not by which objection came to mind first. Highest-RPN
modes get a concrete mitigation naming the bead that should carry it; lower-RPN modes get an explicit
accept-with-rationale instead of a speculative fix.

## What is being challenged

ADR-0070's four-stage pipeline — **recruit** (`when(signals)` matches a `participationRules` rule) →
**collaborate** (squad reviews within group `decisionRights`) → **execute** (specialist runs; skill/flavor
adapts style) → **enforce** (`gate: advisory` by default; `gate: enforced` requires an `enforcementScope`
naming a `decisionRight` the recruiting team's own registry entry declares) — and its three named insertion
points: `routeRequest` (`lib/orchestration/flow-selection.mjs:280`), `runConstructArtifactLoop`
(`lib/artifact-loop-core.mjs:311`), `invokeWorkflow` (`lib/embedded-contract/workflow-invoke.mjs:204`).
Today only `routeRequest` has any live condition→specialist mechanism (`WATCHERS`/`evaluateWatchConditions`,
`lib/orchestration/routing-tables.mjs:29-39,145-159`); the other two insertion points, `participationRules`
itself, the collaborate stage, and the enforce stage's blocking behavior are all still-open child beads
(cdsp.20/.21/.30/.40/.41/.42/.60/.61). This FMEA treats the ADR's *design* as the thing under stress test —
several failure modes below describe gaps in the design or in the substrate the design will be wired into,
not bugs in code that doesn't exist yet.

## FMEA table (ranked by RPN)

| # | Failure mode | Effect | Cause (grounded) | Sev | Occ | Det | RPN | Mitigation / accept-with-rationale |
|---|---|---|---|---|---|---|---|---|
| 1 | **Unbounded recruitment fan-out** (over-recruitment cost/latency) | Every matched rule appends to the specialist list with no upper bound; a run's contract-chain and dispatch cost scale linearly with however many rules happen to match, including rules added by a project's own `.cx/specialists/` overlay outside registry review. | `augmentSpecialists` (`lib/orchestration/flow-selection.mjs:110-147`) is purely additive — every branch does `list = [x, ...list]` — and `participationRules` is designed as a second, parallel recruit source layered on top of the same additive list (ADR-0070 §Decision, stage 1). Neither the schema (`schemas/participation-rules.schema.json`) nor `augmentSpecialists` declares a maximum recruited-role count per run. | 7 | 6 | 6 | **252** | Add a hard cap on total recruited roles per run (e.g., in `augmentSpecialists` or wherever `participationRules` folds in under cdsp.20/cdsp.30) with a trace warning when the cap is hit, and emit a fan-out count to telemetry so cdsp.41's execution-honesty aggregation and cdsp.60's Org Studio canvas can surface it, rather than discovering it as an incident. Scope this into cdsp.20 (`construct-pteo2.5`), the recruiter-generalization bead. |
| 2 | **Model-spend blowup with no budget check at the recruit boundary** | A recruited specialist executed via `invokeWorkflow` triggers its own model resolution (`resolveEmbeddedModel`) and, when `oracle` dispatch mode is `swarm`, potentially several specialists' worth of model calls per matched gap (`lib/oracle/dispatch.mjs:40,64`); nothing bounds spend at the point recruitment happens, only at two specific daemon call sites. | Verified directly: `lib/policy/unattended-budget.mjs` (landed `f4d65975`, "fail-closed unattended budget governance for daemon LLM spend") is wired into exactly two call sites — `lib/embed/daemon.mjs`'s telemetry probe and `lib/telemetry/llm-judge.mjs`'s per-trace judge scoring (`git show f4d65975 --stat`). `grep -rn "unattended-budget" lib --include="*.mjs"` outside that file returns **no matches** — `routeRequest`, `invokeWorkflow`, and the not-yet-built `participationRules` evaluator are not consulted by this budget mechanism at all. An interactive session has an operator to notice runaway spend; the `runConstructArtifactLoop`/`author_artifact` recruit path (cdsp.30, still open) does not, and is exactly the kind of unattended path `f4d65975`'s own rationale ("a daemon tick has no operator present to notice runaway spend") already argues needs a fail-closed budget. | 8 | 5 | 6 | **240** | Before cdsp.30 (`construct-pteo2.8`, `author_artifact` recruits) closes, extend `lib/policy/unattended-budget.mjs`'s fail-closed default to the recruit-triggered execution path, or explicitly document why author_artifact's recruit path is exempt (e.g., it always runs inside an interactive session today). This is the concrete gate this FMEA is required to set for cdsp.30 per the epic's own GATES clause. |
| 3 | **Overlay resolution is filesystem-order-dependent, not deterministic** | Two `.cx/specialists/` overlay files that both declare a rule with the same id (or the same `watchCondition`/event/doc ownership) silently resolve to whichever file `readdirSync` happens to list last — an OS/filesystem detail, not a defined precedence — so the same registry on two machines (or the same machine after an unrelated filesystem operation) can recruit a different specialist for identical input. | Verified: `loadOverlays()` (`lib/orchestration/routing-tables.mjs:51-63`) calls `readdirSync(overlayDir)` with **no `.sort()`** before iterating, and `apply()`'s duplicate check (`routing-tables.mjs:87-92,95-99`) only errors on registry-vs-registry duplicates (`source === 'registry'`) — overlay-vs-overlay conflicts hit "last writer wins" (the file's own header comment, `routing-tables.mjs:72-74`) with an undefined "last." `participationRules` is designed to live on exactly this same overlay precedent (ADR-0070 §Decision: "or a `.cx/specialists/` project overlay, following lyxx's existing overlay precedent"), so it inherits this non-determinism unless the evaluator sorts explicitly. | 6 | 4 | 8 | **192** | Two-line fix, high leverage: sort `readdirSync(overlayDir)` output before iterating in `loadOverlays()`, and extend the existing duplicate-ownership error (currently registry-only) to also fire across two overlay files, matching the pattern already used for registry-vs-registry conflicts. Cheap enough to land ahead of or alongside cdsp.20 rather than deferred. |
| 4 | **Hierarchy/decision-right conflict: a squad can self-declare enforcement authority ADR-0070 says it shouldn't have** | `enforcementScope.team` in a `participationRules` rule can name a squad directly; nothing validates that the squad's claimed `decisionRight` is actually delegated by its owning group, so a squad could gate a release on a decision ADR-0070's own hierarchy semantics ("a squad ... does not unilaterally hold enforcement authority beyond what its owning group grants") say it must not unilaterally hold. | Verified: `design-team.json` (`kind: "squad"`, `groupId: "product-group"`) lists its own `decisionRights` (`intake-triage`, `design-approval`, `scope-change`, `evidence-requirement`) independent of any group-side grant record. `lib/registry/validator.mjs`'s `checkDecisionHasPolicy` (line 239) only checks that a claimed `decisionRight` has a matching policy id — it does **not** cross-check a squad's `decisionRights` against its parent group's, and `grep -n "groupId.*decisionRights\|delegat" lib/registry/validator.mjs` finds no such check anywhere in the file. `schemas/participation-rules.schema.json`'s `enforcementScope` (lines 43-52) requires only `{team, decisionRight}` with no `kind` constraint, so nothing in the schema itself distinguishes "team = group" from "team = squad" for enforcement purposes, even though ADR-0070's prose draws that distinction. | 8 | 4 | 5 | **160** | Before cdsp.42 (`construct-pteo2.13`, the enforced sign-off gate) reaches parity with its own acceptance criteria ("only teams with the decisionRight can block"), add a registry-assembly check that a squad's `decisionRights` entry used in an `enforcementScope` is also present on its owning group's `decisionRights` (or explicitly and separately grant squads standalone enforcement authority, as a deliberate, documented design choice rather than a silent gap). This is the concrete gate this FMEA sets for cdsp.20/.21 per the epic's GATES clause — the recruiter must not let an `enforcementScope` reference an undelegated squad right. |
| 5 | **`signalExpr`'s agnosticism is prose-only, not structural** (agnosticism violation) | `dimension`/`recruit.specialists` are structurally closed (12-value enum) so a rule cannot invent a 13th role even by accident — but `when.signalExpr` is declared "free-form" with no equivalent structural constraint, so nothing stops a future rule from embedding a host-, model-, or provider-specific literal (e.g., a Claude-Code-only environment check) once cdsp.3 externalizes the signal grammar, silently reintroducing the per-platform branching ADR-0033 was written to eliminate. | Verified in the schema itself: `schemas/participation-rules.schema.json`'s `signalExpr` description reads "Free-form now; `construct-pteo2.3` is scoped to define the expression grammar and the full externalized signal vocabulary this references" (lines 99-101) — i.e., today's schema imposes no vocabulary restriction at all. `rosterSpecialist` (lines 126-141), by contrast, is a closed enum specifically so "no 13th role" is a schema-validation failure rather than a convention — ADR-0070's own §Rationale argues this exact point ("a validation-time restriction is strictly more reliable than a convention a future author could miss under pressure") but does not yet apply it to `signalExpr`. | 7 | 5 | 4 | **140** | cdsp.3 (`construct-pteo2.3`, signal-set expansion) should define `signalExpr`'s grammar as a fixed vocabulary over `requestSignals` fields only (mirroring the closed `rosterSpecialist` enum), and `registry:validate --unified` should reject any `signalExpr` token outside that allow-list — applying ADR-0070's own "structural, not prose" argument to this field too, not just to the roster. |
| 6 | **Infinite/oscillating recruitment loop once join/leave lands** | A recruited specialist's own output could itself satisfy another rule's `when` condition (or re-satisfy its own), and nothing in the substrate defines a fixed point or a re-evaluation cap, so a multi-turn artifact revision could recruit/re-recruit without converging — inflating cost (compounding modes #1/#2) or never reaching the enforce stage. | Today's `evaluateWatchConditions` is a single deterministic pass per `routeRequest` call over signals computed once (`requestSignals(...)`, `flow-selection.mjs:297-298`) — genuinely loop-free as currently wired. But the epic explicitly scopes "join/leave as signals evolve" to cdsp.11 (artifact-content signals, still open) and cdsp.40 (`construct-pteo2.11`, collaboration/join-leave swarm, still open); neither that bead's description nor ADR-0070 states a termination condition for re-evaluating signals as an artifact's body changes across turns. This mode does not exist in shipped code today — it is a design gap in beads not yet built. | 8 | 5 | 3 | **120** | cdsp.40 must specify convergence explicitly before it ships: cap re-evaluation passes per artifact revision, and a specialist that already signed off in the current revision must not be re-recruitable by a rule matching content that only restates its own prior comment. Log every re-evaluation pass so a runaway loop is detectable in trace output, not just in cost after the fact. Accept-with-rationale for *this bead* (cdsp.19/FMEA): the fix belongs to cdsp.40's design, not to code that exists today. |
| 7 | **Advisory-default sign-off lets a high-risk artifact ship unsigned, indistinguishable from a low-risk one that correctly needed no sign-off** | Under the binding default (`gate: advisory`), a missing recruited-reviewer sign-off on a PRD with real cost/legal/security implications produces the identical `warnings` array entry as a missing sign-off on a trivial doc — `artifact-release-gate.mjs` gates on `errors`, not `warnings` (line 115-116: `ok: dedupeGateErrors(errors).length === 0`), so both ship with `ok: true`. | Verified: `missingRequiredReviewers` (`lib/artifact-release-gate.mjs:103-112`) only ever pushes to `warnings`, never `errors`, for any docType under today's substrate — there is no severity gradient by risk. `readAgentLogReviewers`/`missingRequiredReviewers` (`lib/artifact-reviewers.mjs:15-28,57-68`) treats *presence* of the specialist id anywhere in `.cx/agent-log.jsonl` as "seen" — see mode #8, the same presence-only weakness compounds here: even a "warned" case could be silenced by a prepare-only log line. cdsp.42 (`construct-pteo2.13`) is scoped to add the enforced path but explicitly gates it behind `enforcementScope`/team `decisionRights` opt-in — advisory stays the shipped default for every team that hasn't opted in, by design (user decision, ADR-0070 §Context: "the sign-off gate defaults to `advisory`... never a global switch and never the schema's default"). | 9 | 7 | 7 | **441 — highest RPN in this analysis** | See the dedicated **Advisory-default probe** section below — this is the acceptance-bar item the bead explicitly requires an answer for, not a one-line mitigation. |
| 8 | **Prepare-only masking: "seen in the agent log" is a weak proxy for "genuinely reviewed"** | A recruited reviewer that ran but produced no load-bearing sign-off content (or ran only a prepare-only stub) is indistinguishable, to today's gate, from one that actually reviewed — both satisfy `missingRequiredReviewers`'s check and neither is flagged. | Verified: `readAgentLogReviewers` (`lib/artifact-reviewers.mjs:15-28`) builds its `seen` set from any JSONL line where `row.agent \|\| row.specialist` matches — no check on the line's content, no distinction from a genuinely substantive review. This is precisely the gap cdsp.41 (`construct-pteo2.12`, "Execution honesty for recruited participants," still open, P0) is scoped to close: its own acceptance criteria state "a recruited-but-unexecuted reviewer surfaces as prepared/degraded, never as a completed review." The `artifact-completion-states.md` ladder already has the right vocabulary for this (a **degradation** — "a check that could not run" — "records the miss with a typed reason... does **not** advance the ladder"); `missingRequiredReviewers` does not yet speak that vocabulary. | 8 | 6 | 6 | **288** | This is the concrete gate this FMEA sets for cdsp.20/.21/.30 per the epic's own GATES clause: cdsp.41's `shapeRun`/LMCP-F4 aggregation must produce a typed distinction (mirroring the existing `degraded`/`missing-dependency`-style reasons in `artifact-completion-states.md`) between "specialist never ran," "specialist ran, prepare-only," and "specialist ran and produced a sign-off," and `missingRequiredReviewers` must be extended to read that distinction rather than raw agent-log presence before cdsp.42's enforced path can be trusted to block on anything real. |
| 9 | **Background LLM route-verification is non-deterministic relative to the deterministic route it verifies, and the two can silently diverge without either surface being wrong** | `routeRequestVerified` returns the deterministic keyword-based route immediately, then fires an LLM verifier in the background that logs to `~/.cx/intent-verifications.jsonl` for offline tuning only — a caller that reads the returned route sees a different (and reproducible) answer than what the async verifier eventually judged, with no mechanism connecting the two back into a single decision for `participationRules`, if a future rule's `signalExpr` is ever scored by that verifier's output. | Verified: `routeRequestVerified` (`lib/orchestration/flow-selection.mjs:385-388`) calls `routeRequest` synchronously then `verifyRoute` (`lib/intent-classifier.mjs:259`), whose own file header states the verifier "fires in the background and writes... verdict to `~/.cx/intent-verifications.jsonl` for offline tuning" (lines 8, 15-18) — the dispatched route "never waits on a model round-trip" by design (`flow-selection.mjs:381-384`). This is a deliberate, documented latency/determinism trade-off for today's use (offline tuning signal), not a bug — but `participationRules`'s `signalExpr` generalization (cdsp.3) has not yet stated whether it will ever consult LLM-scored signals synchronously; if it does, that would import non-determinism into the recruit stage itself, unlike today's keyword-only `routeRequest`, which is pure and reproducible. | 5 | 3 | 5 | **75** | Accept-with-rationale: today's mechanism is deliberately async and non-blocking, and does not affect what actually gets recruited. The only actionable item is forward-looking — cdsp.3 should state explicitly that `signalExpr` evaluation stays synchronous/deterministic (no LLM-scored signal in the recruit-stage boolean expression), so this mode never activates; no code change needed today. |

## Advisory-default probe (acceptance-bar item)

**Does advisory-default let a high-risk artifact ship unsigned?** Yes, unambiguously, under the substrate
verified above. `artifact-release-gate.mjs`'s `ok` field is computed from `errors` only
(`dedupeGateErrors(errors).length === 0`, line 115-116); `missingRequiredReviewers` only ever contributes to
`warnings` (line 111) for any docType under today's code, regardless of the artifact's actual risk surface
(cost implications, legal/compliance flags, security blast radius). A PRD whose body reveals six-figure cost
implications and a PRD proposing a typo fix, if both nominally require a `cx-reviewer` sign-off per
`releaseGate.requiredReviewers`, produce the identical `ok: true, warnings: [...]` result when neither
reviewer's id appears in `.cx/agent-log.jsonl`. This is not a bug in the advisory-default decision itself —
advisory-by-default is a deliberate, correctly-scoped user decision (ADR-0070 §Context, §Rejected
alternatives: "an opt-out default means every existing team registry entry silently gains a blocking gate...
with no team having affirmatively asked for it") — the gap is that nothing *upstream* of the gate currently
routes a genuinely high-risk artifact toward a team that has opted into enforcement, and nothing *at* the
gate currently distinguishes a high-risk unsigned artifact from a low-risk one in its reporting, so a human
skimming `warnings` output has no signal to prioritize.

**Escalation criteria — when should a team require `gate: enforced` instead of `advisory`?** Per ADR-0070's
structural constraint, enforcement is only realized when the recruiting team's own registry entry lists the
matching `decisionRight` in its `decisionRights` array (`schemas/participation-rules.schema.json` lines
38-52) — so this is a per-team registry decision, not a global policy this FMEA can set unilaterally. Based
on the risk surfaces already named as first-class signals in this codebase (`requestSignals`'s
`authOrPayments`, `blastRadius`, `riskFlags.security`/`riskFlags.architecture`, `flow-selection.mjs:239-243`;
the existing `wide-blast-radius`/`auth-payments-non-narrow`/`architecture-without-metric` watchers,
`routing-tables.mjs:30-38`), a team should opt a `participationRules` rule into `gate: enforced` when **all**
of the following hold for the recruit condition it governs:

1. **The recruit condition already correlates with an existing high-severity signal** — `blastRadius: wide`,
   `authOrPayments: true` with non-narrow blast radius, or `riskFlags.security`/`riskFlags.architecture` —
   i.e., the rule recruits for a concern this codebase already treats as high-stakes elsewhere, not a novel
   risk category invented solely for the enforcement decision.
2. **The team recruited under the rule owns a `decisionRight` a downstream release genuinely cannot proceed
   without** (e.g., `cx-security` and `security-policy`/`architecture` for an auth/payments change) — not a
   `decisionRight` claimed opportunistically to gain blocking power over unrelated work. This is exactly
   what the not-yet-built delegation check from mode #4 above should validate structurally, so this criterion
   is enforceable rather than aspirational.
3. **Mode #8's prepare-only distinction has landed** (cdsp.41) — enforcing a gate before the substrate can
   reliably tell "reviewer ran and signed off" from "reviewer's id merely appears in the log" means the
   enforced gate blocks (or fails to block) on a signal that cannot yet be trusted; per the epic's own GATES
   clause, cdsp.42 already depends on cdsp.41 for exactly this reason (`construct-pteo2.13` DEPENDS ON
   `construct-pteo2.12`).
4. **The team has explicit escalation capacity** — its registry entry's `escalationPath`
   (`schemas/scope.schema.json`-shaped, e.g. `design-team.json`'s `["product-manager", "architect",
   "orchestrator"]`) resolves to real roles, so a blocked release has a defined next step rather than a dead
   end.

Conversely, a team should **not** flip to `enforced` merely because a rule recruits it often, or because a
single incident occurred — occurrence alone does not imply the decision right is genuinely load-bearing for
release safety, and an over-eager enforced gate is exactly the failure ADR-0070's own rejected-alternatives
section already warns against ("every existing team registry entry silently gains a blocking gate... the
opposite of the 'opt-in per team' instruction").

## Gate status

Per `construct-pteo2` epic acceptance criterion 5 ("challenge beads (FMEA + threat) have mitigations recorded
before build beads close") and this bead's own GATES clause, the following are the load-bearing mitigations
this document records for the three blocked beads:

- **`construct-pteo2.5` (cdsp.20, recruiter generalization)**: must address mode #1 (fan-out cap), mode #2
  (budget check at the recruit boundary), and mode #4 (squad-vs-group enforcement delegation check) before
  close, or record its own explicit accept-with-rationale for any it defers.
- **`construct-pteo2.6` (cdsp.21, coverage — every specialist/team recruitable)**: must address mode #4
  (delegation check) since broader coverage widens the surface for an undelegated squad to claim enforcement.
- **`construct-pteo2.8` (cdsp.30, `author_artifact` recruits)**: must address mode #2 (unattended-budget
  extension to the recruit-triggered execution path) before close, since this is the first insertion point
  that runs recruitment outside a routed CLI/MCP call an interactive operator is watching.

Modes #3 (overlay ordering), #5 (`signalExpr` agnosticism), #6 (join/leave convergence), #7 (advisory-default
probe — addressed above, feeds `construct-pteo2.13`), #8 (prepare-only masking — already `construct-pteo2.12`'s
explicit scope), and #9 (accept-with-rationale, no action) are recorded here for the beads named in each row
above; none of them independently blocks cdsp.20/.21/.30's close criteria beyond what is stated.

## References

- `docs/decisions/adr/0070-participation-pipeline-and-rules-schema.md` (the design this FMEA challenges)
- `schemas/participation-rules.schema.json` (the schema whose structural constraints modes #5 and #7 probe)
- `lib/orchestration/flow-selection.mjs:110-147,280-388` (`augmentSpecialists`, `routeRequest`,
  `routeRequestVerified` — modes #1, #9)
- `lib/orchestration/routing-tables.mjs:29-39,51-63,72-113,145-159` (`WATCHERS`, `loadOverlays`, `apply`,
  `evaluateWatchConditions` — modes #3, #6)
- `lib/policy/unattended-budget.mjs`, `git show f4d65975 --stat` (mode #2)
- `lib/registry/validator.mjs:239-275` (`checkDecisionHasPolicy`, `checkForbiddenDecisions` — mode #4)
- `specialists/org/groups/engineering-group.json`, `specialists/org/teams/design-team.json` (mode #4)
- `lib/artifact-release-gate.mjs:63-120`, `lib/artifact-reviewers.mjs:15-68` (modes #7, #8)
- `docs/guides/reference/artifact-completion-states.md` (the degradation vocabulary mode #8's mitigation reuses)
- `lib/intent-classifier.mjs:8-22,210-272` (mode #9)
- `skills/roles/devil-advocate.md` (FMEA methodology this document follows)
- `docs/notes/research/2026-07-09-cdsp-substrate-reconciliation-audit.md` (construct-pteo2.1, the substrate audit this analysis builds on)
