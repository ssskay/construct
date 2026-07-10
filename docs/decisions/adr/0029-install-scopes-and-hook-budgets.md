---
intake: none
intake_rationale: contract decision recorded from a footprint-and-hook-cost audit (plan ~/.claude/plans/thoroughly-review-the-configurations-silly-meadow.md) tracking as bd epic construct-7w69; primary evidence is repository code (file:line cites below) and Anthropic primary-source docs.
last_verified_at: 2026-06-26
verified_by: construct · install-scope + init-no-project-secrets functional tests on branch feature/team-redesign
---

# ADR 0029: Install scopes and per-hook performance budgets

- **Date**: 2026-06-05
- **Status**: accepted
- **Deciders**: Construct·Architect
- **Supersedes**: none
- **Extends**: [ADR 0025](0025-explicit-activation-model.md) (explicit activation — extends the "aware, never ambient" doctrine from activation into install-scope opt-in), [ADR 0027](0027-host-project-footprint-and-non-destructive-scaffolding.md) (host-project footprint — completes the install/init boundary by adding scope opt-in for machine-side writes that ADR-0027 left as silent defaults).
- **Extended by**: [ADR 0071](0071-install-footprint-vs-org-scope-naming.md) renames this ADR's `--scope=project|user|both` install flag to `--footprint=project|user|both` (`--scope` keeps working as a deprecated alias) to resolve a naming collision with the unrelated `construct scope` org-profile command. The `project | user | both` semantics decided below are unchanged — only the flag spelling changed.

## Problem

`construct install` and the install/sync paths today write to a user's machine and to the user's global Claude Code config without an explicit, per-scope opt-in:

- `scripts/sync-specialists.mjs:826–856` writes a marker block into `~/.claude/CLAUDE.md` and **injects Construct's hooks into `~/.claude/settings.json`** whenever `sync` runs with `targetDir == null`. The global-scope path is reachable from `construct install` (via `lib/setup.mjs`), from `construct sync --global`, and historically from `bin/construct-postinstall.mjs`. There is no interactive disclosure, no itemized path list, and no way to install Construct on a machine for use in **one** project without also mutating the user's global Claude config.
- `lib/setup.mjs:511–523` (`runSetup`) unconditionally writes `~/.construct/config.env`, the `~/.construct/lib` symlink, `~/.config/opencode/opencode.json` MCP entries, and optionally the docker-compose for Postgres. The flag surface is `--yes` / `--no-docker` / `--reconfigure` — no `--scope` and no project-only mode.
- Construct's hook surface is **53 hooks** across 7 Claude Code event types (`platforms/claude/settings.template.json`, `lib/hooks/*.mjs`). Per-event budgets are not declared, not measured, and not enforced. The `Stop` event was opportunistically tuned in commit `411d1bd` (sync 150s → 15s) but no harness prevents the next hook addition from regressing it, and no harness covers `UserPromptSubmit`, `PreToolUse`, or `PostToolUse`.

Two specific hot-path costs went unmeasured until this audit:
- `lib/hooks/ci-status-check.mjs` spawns `gh run list` synchronously on every `UserPromptSubmit`, cached 60s. The cache miss is unbounded by Construct (depends on `gh` + network).
- `lib/hooks/pre-push-gate.mjs` runs `npm test` and `npm run build` synchronously for 180s before every `git push`. This is correct *as a gate* but is currently undeclared in any budget table, so it cannot be distinguished from accidental hot-path cost.

The decision-forcing tension is whether to leave install scope and hook cost as undocumented operational defaults — fix-forward only — or codify them as a contract with explicit opt-in and measured budgets.

## Context

- Construct's stated doctrine in [ADR 0025](0025-explicit-activation-model.md) is "aware, never ambient": activation requires explicit user action. The install path's silent global writes violate this doctrine at the machine layer; ADR-0025 explicitly addressed it only at the per-session activation layer.
- [ADR 0027](0027-host-project-footprint-and-non-destructive-scaffolding.md) §3 made `construct install` strictly machine-scoped (never touches `process.cwd()`) but did **not** introduce per-scope opt-in for the machine-side writes themselves. ADR-0027's `.construct-manifest` disposition model (`tracked` / `ignored` / `asked-before-modify`) is the natural foundation for extending the disposition contract with a `scope: project | user` axis.
- Anthropic's Claude Code documentation ([Hooks reference](https://code.claude.com/docs/en/hooks), [Best practices](https://code.claude.com/docs/en/best-practices), both fetched 2026-06-05) declares concrete budgets and an `async: true` escape valve: default timeouts are 600s (command/http/mcp_tool), 30s (prompt), 60s (agent). The hooks reference cites the 30s `UserPromptSubmit` timeout with the rationale "a stuck hook stalls the session." The `Stop` event auto-overrides after 8 consecutive blocks. These are upstream constraints, not Construct's invention.
- Community peer projects diverge on global-config policy:
  - `claude-task-master`: project-local default, `~/.claude/` only on user opt-in. Documentation ambiguity on this boundary was filed as a bug ([issue #1180](https://github.com/eyaltoledano/claude-task-master/issues/1180), accessed 2026-06-05).
  - `ruflo` (claude-flow): project-local only. Filed a measured 18–21s/prompt vs 4.8s/prompt slowdown (~4×) caused by 11 node-spawning hooks running per turn ([issue #1530](https://github.com/ruvnet/ruflo/issues/1530), accessed 2026-06-05).
  - SuperClaude: explicit global install at `~/.claude/` (~50MB), disclosed up-front via `pipx install` + `superclaude install` ([install docs](https://github.com/SuperClaude-Org/SuperClaude_Framework/blob/master/docs/getting-started/installation.md), accessed 2026-06-05).
  - Claudia (GUI): read-only on `~/.claude/`.
  The pattern: the credible peers either default to project-local or disclose global writes line-by-line. Silent global writes are the outlier.
- Community write-ups converge on **~500ms per `PostToolUse` hook** as the perceptual sluggishness threshold ([Pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns), [Blakecrosley](https://blakecrosley.com/blog/claude-code-hooks-tutorial), accessed 2026-06-05). The constraint is total wall time per event, not hook count — 95 fast hooks can outperform 2 slow ones.
- `lib/host-disposition.mjs` already encodes per-artifact disposition for the project scope. Extending its enum with a `scope` axis is mechanical; building parallel infrastructure for machine-scope disposition would duplicate without payoff.

## Decision

Construct's install and hook surfaces are governed by two additions to the existing footprint contract:

**1. Install is explicitly scoped.** `construct install` accepts `--scope=project | user | both`, defaulting to `project`. The default does no machine-state writes and instead prints a single line directing the user to either `construct init` (project artifacts) or `construct install --scope=user` (machine artifacts). The `user` scope writes the XDG user dirs (config `~/.config/construct/*`, state `~/.local/state/construct/*`, cache `~/.cache/construct/*`; each honors `$XDG_CONFIG_HOME` / `$XDG_STATE_HOME` / `$XDG_CACHE_HOME` — see ADR-0045 §B and `docs/guides/reference/config.md`), `~/.config/opencode/opencode.json`, `~/.codex/config.toml`, the hook-lib symlink at `~/.config/construct/lib`, and — only with an itemized interactive consent prompt (or `--yes` in non-interactive contexts) — the marker block in `~/.claude/CLAUDE.md` and the hook injection in `~/.claude/settings.json`. The `both` scope is `project` then `user`. `bin/construct-postinstall.mjs` never writes user scope on its own; it prints the same scope guidance and exits 0. `construct sync --global` reuses the user-scope writer and the same consent prompt.

**2. Every hook declares a measured p95 budget.** Each `lib/hooks/*.mjs` file header carries a `@p95ms <N>` line. Defaults are derived from Anthropic's primary-source budgets and the 500ms community perceptual threshold:

| Event | Default `@p95ms` | Rationale |
|---|---|---|
| `UserPromptSubmit` | 200 | Anthropic ceiling 30s; this is hot path — well below threshold |
| `PreToolUse` | 500 | Community perceptual threshold for hot path |
| `PostToolUse` | 500 | Community perceptual threshold for hot path |
| `Stop` (sync arm) | 500 | Sync portion only; async arms have their own budgets |
| `SessionStart` | 1000 | Run-once-per-session; less latency-sensitive |
| Gate hooks (user-invoked) | declared explicitly | e.g. `pre-push-gate.mjs` declares 180_000 (180s) as a deliberate quality gate |

A new harness `scripts/bench-hooks.mjs` measures p95 over N=20 runs per hook against a synthetic stdin matching the hook's event shape. A scheduled CI job (`tests/perf/hook-budgets.test.mjs`) fails when measured p95 exceeds the declared `@p95ms` by more than 2×. The harness is also a `construct doctor` lane so a developer can probe locally without waiting for CI.

Two immediate hot-path fixes ride with the budget rollout:
- `lib/hooks/ci-status-check.mjs` moves the `gh run list` spawn off the synchronous `UserPromptSubmit` path. The hook serves the cached value immediately and triggers a background refresh (stale-while-revalidate). The cache file path is unchanged.
- `lib/hooks/pre-push-gate.mjs` keeps its 180s sync behavior (correct as an explicit user-invoked gate) but declares `@p95ms 180000` in its header so the benchmark does not flag it.

The contract is implemented under bd epic `construct-7w69` with child issues `construct-hvns` (this ADR), and follow-up issues for: `--scope` flag + sync gating + tests; README + architecture footprint contract; hook budget headers + benchmark harness + ci-status-check async fix; hook budget CI gate.

## Rationale

The chosen position aligns Construct with the credible community defaults and the upstream Anthropic guidance without abandoning the operational properties that make Construct useful. Three load-bearing reasons:

1. **Project-local-by-default is the dominant pattern among performance-credible peers.** Both task-master and ruflo default to project-local; task-master's documentation ambiguity around the global boundary was treated as a bug by the community (#1180). The peers that *do* write globally (SuperClaude) disclose it explicitly with byte counts before mutation. Silent global writes are the outlier — extending ADR-0027's "disposition is explicit and enumerated" doctrine from project scope to machine scope is the consistent move.

2. **Hook cost is bounded by total wall time, not count — and only measured budgets keep it bounded.** Ruflo's #1530 is the load-bearing peer evidence: 11 node-spawning hooks turned the session into a 4× slowdown. Construct already has 53 hooks. The existing commit `411d1bd` proves the team will tune the budget when it visibly hurts; the failure mode this ADR addresses is the *invisible* regression — the next hook that adds 300ms to `UserPromptSubmit` without anyone noticing. Per-hook declared budgets + a scheduled measurement harness is the cheapest way to catch this class.

3. **The marker-block / disposition machinery already exists.** `lib/host-disposition.mjs` encodes per-artifact disposition for the project scope; the `--scope` axis extends an existing enum rather than introducing a parallel mechanism. `tests/hooks/no-skip-vars.test.mjs` is the precedent for AST-style hook-policy enforcement; the budget gate is modeled on it. The total new surface this ADR adds is small: one flag, one header convention, one harness, one nightly CI lane.

The community ~500ms perceptual threshold is cited because it represents the convergent empirical evidence across multiple independent practitioners; Anthropic's primary-source budgets are cited as the upstream ceiling (the latitude the platform itself grants). The chosen Construct budgets sit between the community threshold (the perceptual budget) and the upstream ceiling (the platform budget), giving the team a tightening dial without flagging legitimate gates.

## Rejected alternatives

- **Keep silent global writes; rely on `construct uninstall` to reverse them.** Minimizes setup friction. Rejected because it directly contradicts the "aware, never ambient" doctrine of [ADR 0025](0025-explicit-activation-model.md) and reproduces exactly the ambiguity that task-master's #1180 identified as a bug. Reversibility-after-the-fact is not a substitute for opt-in-before-the-fact; users discover the global writes only when they break.

- **Itemized consent prompt on every install (no `--scope` flag).** Match SuperClaude's pattern directly. Rejected because the SuperClaude pattern conflates two distinct decisions — *what scope* and *which paths* — into one wall-of-text prompt. A `--scope` flag makes the coarse decision explicit and cheap (a single argv token), and reserves the itemized prompt for the path-level disclosure within the user scope. It also makes non-interactive contexts (CI, container builds, `--yes`) cleanly expressible without bypassing the consent semantics.

- **Three install commands (`construct install-project`, `construct install-user`, `construct install-both`).** Maximally explicit at the verb level. Rejected because it triples the documentation surface for a decision that's structurally a single dimension (`scope`), creates command-name churn for users coming from `construct install` (which would have to become an alias or be removed), and breaks the existing `--yes`/`--reconfigure` flag ergonomics.

- **Declare hook budgets in `platforms/claude/settings.template.json` rather than file headers.** Co-locates budgets with hook registration. Rejected because the budget describes the hook's *implementation cost* (a property of the .mjs file), not its event binding (a property of settings.json). Co-locating with the implementation means a single file move/rename keeps the budget attached; co-locating with the registration would let budget and implementation drift apart. The header convention also reuses the existing file-header comment block per the project's comment convention — no new parsing target.

- **Measure budgets on every PR.** Catches regressions earlier. Rejected because hook benchmarking is variance-heavy (process spawn time, CI runner contention) and the 2× tolerance can still produce flaky PR signals. A scheduled nightly job + on-demand `construct doctor bench:hooks` gives a stable signal without teaching the team to ignore red builds (the [feedback_no_test_rewrite_to_hide_deviation](#) anti-pattern). Promoting to per-PR is a one-line config change once the noise floor is characterized.

- **Drop the `~/.claude/settings.json` global hook injection entirely.** Eliminates the most visible global write. Rejected because users who run Construct's `construct sync --global` deliberately want the hooks active outside any single project (e.g. for ad-hoc work in non-Construct-init'd repos). The right answer is opt-in disclosure, not removal — taking away an existing capability that some users rely on, rather than gating it, is a sharper regression than the silent default it would replace.

## Consequences

- A user running `npm install -g @anthropic-ai/construct` followed by `construct install` (no flag) sees a one-line scope guidance and zero mutation. The "install" verb stops being a load-bearing silent action.
- A user running `construct install --scope=user` on a fresh machine sees an itemized list of every path Construct will create or modify with byte sizes, accepts (or declines) interactively, and gets a deterministic exit code in non-interactive contexts when `--yes` is set. Documentation in the README's new "Footprint contract" section mirrors the same itemization.
- A developer touching `lib/hooks/*.mjs` must declare or update the `@p95ms` header. `tests/perf/hook-budgets.test.mjs` fails if the file lacks the header; a separate `tests/hooks/budget-header-required.test.mjs` enforces presence at unit-test speed without running the harness.
- `construct doctor` gains a `bench:hooks` lane usable for local probing. The lane is opt-in (not on by default) to keep `doctor` fast.
- The `bin/construct-postinstall.mjs` postinstall path becomes a no-op printer. Users who had the silent global write happen at `npm install` time will, on next upgrade, not have it happen — surfaced by `construct doctor` as a drift category (per ADR-0027 §4) with the precise `construct install --scope=user` remediation.
- `construct sync --global` and `construct install --scope=user|both` share the consent prompt and the user-scope writer. There is exactly one code path that mutates user scope.
- The hook budget gate adds a nightly CI job. Existing per-PR gates are unchanged. The benchmark harness produces a JSON report (`.cx/bench/hooks-<date>.json`) that `construct doctor` can read.
- ADR-0029's `@p95ms` convention extends to any future hook surface (e.g. if Construct ships hooks for other platforms). The convention is platform-agnostic by design.
- Backward-repair: a user upgrading from a Construct version that wrote `~/.claude/settings.json` hook injection silently can run `construct doctor` to see the drift. Removing the injection requires explicit `construct uninstall --scope=user` (or manual edit) — Construct never silently un-installs what it silently installed; reversal is also opt-in.

## Reversibility

Two-way door for the `--scope` flag: the default can be flipped from `project` back to `both` (current de-facto behavior) by changing one default value in `lib/setup.mjs`. The consent prompt, the user-scope writer, and `--scope=user|both` all remain functional regardless of the default. Reversing would be justified only if telemetry shows a high rate of users hitting the no-op `project` default and then re-running with `--scope=user|both` — the cost would be a regression to the ambient-install posture, not a code-shape change.

Two-way door for the budget headers: removing the gate is a one-line change in `tests/perf/hook-budgets.test.mjs`. The headers themselves are informational and survive gate removal. Lowering specific budgets (e.g. `@p95ms 200` → `@p95ms 100` for `UserPromptSubmit`) is a per-hook decision that does not require ADR amendment.

One-way door for the `bin/construct-postinstall.mjs` behavior change: users who relied on the silent postinstall global write to "just work" will need a one-time `construct install --scope=user` after the change lands. Communicated via CHANGELOG entry and the first-run `construct doctor` drift surface. Not literally irreversible but not worth reversing — the silent-postinstall posture is the exact pattern this ADR sets out to retire.

## References

- [ADR 0025](0025-explicit-activation-model.md) — Construct activation is explicit and host-initiated.
- [ADR 0027](0027-host-project-footprint-and-non-destructive-scaffolding.md) — Host project footprint & non-destructive scaffolding.
- [Anthropic — Claude Code Hooks reference](https://code.claude.com/docs/en/hooks) (accessed 2026-06-05)
- [Anthropic — Claude Code Best practices](https://code.claude.com/docs/en/best-practices) (accessed 2026-06-05)
- [claude-task-master #1180 — global config ambiguity](https://github.com/eyaltoledano/claude-task-master/issues/1180) (accessed 2026-06-05)
- [ruflo #1530 — 18–21s/prompt slowdown from hooks](https://github.com/ruvnet/ruflo/issues/1530) (accessed 2026-06-05)
- [SuperClaude install docs](https://github.com/SuperClaude-Org/SuperClaude_Framework/blob/master/docs/getting-started/installation.md) (accessed 2026-06-05)
- [Pixelmojo — Claude Code hooks production patterns](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns) (accessed 2026-06-05)
- bd epic `construct-7w69` (Install scopes + hook budgets — audit + remediation); this ADR: `construct-hvns`.
- Plan: `~/.claude/plans/thoroughly-review-the-configurations-silly-meadow.md`.
