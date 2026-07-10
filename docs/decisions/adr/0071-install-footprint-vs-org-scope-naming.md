<!--
cx_doc_id and body_hash are stamped by construct on commit; omitted in this draft.
-->
# ADR-0071: Rename install "scope" to "footprint"; keep org-scope vocabulary as-is

- **Date**: 2026-07-09
- **Status**: accepted
- **Deciders**: Gerald Dagher (owner)
- **Extends**: ADR-0029 (install scopes and hook budgets — introduced the `--scope=project|user|both` flag this ADR renames), ADR-0027 (host-project footprint and non-destructive scaffolding — the "footprint" vocabulary this ADR adopts for the flag)
- **Relates to**: `docs/guides/concepts/profile-lifecycle.md` and CLAUDE.md's "Profiles are research artifacts" section (org-scope/profile vocabulary, left unchanged by this ADR)

## Problem

Two unrelated concepts in Construct are both named "scope," and they collide in the first five minutes of use.

1. **Install-scope**: `construct install [--scope=project|user|both]`, defined in `lib/setup.mjs`. `parseScopeFlag` (`lib/setup.mjs:305-315`) reads `--scope=<value>`; a bare `construct install` with no `--scope` hard-errors via `requireExplicitScope` (`lib/setup.mjs:322-330`), printing `Construct install — no scope specified.` and three `--scope=<value>` examples. `printHelp` (`lib/setup.mjs:48-87`) documents `--scope=<s>  project | user | both — see ADR-0029` at line 55. This is a *where does Construct write* axis: project (no-op + guidance), user (machine-scope state), both.

2. **Org-scope / profile**: `construct scope create <id>` / `construct scope set rnd` / `construct scope show|list|set`, implemented in `lib/scopes/lifecycle.mjs`. The module's own header defines it: "A scope is a curated description of an org's work loop, intake taxonomy, role set, and rebrand language." This is a specialist-roster profile — CLAUDE.md's "Profiles are research artifacts, not JSON exercises" section confirms org-scopes ARE profiles, selecting flows + skill emphasis over the fixed 12-role roster.

`README.md` puts both in front of a first-time reader within ~20 lines: line 13 (`construct scope show|list|set <id>` to switch profiles) and line 31 (`construct install --scope=user --yes`). `docs/guides/start/connect-your-editor.mdx` layers on a *third* sense of "scope" — sync scope (`--global` vs project, describing which host-config tier `construct sync` writes to) — using the bare word "scope" repeatedly (lines 6, 8, 40, 42, 43, 51, 110, 122) without ever disambiguating it from the other two. A new user reads "scope" three times in the first-run path with three different referents and no signal that they differ.

## Context

- ADR-0029 established `--scope=project|user|both` as the install-write-target axis and is still `Status: accepted` — this ADR extends it rather than reopening its substance (the project/user/both semantics are correct and unchanged; only the flag's name changes).
- ADR-0027 already introduced "footprint" as this repo's vocabulary for "where Construct writes on disk" — its own title is "host-project footprint and non-destructive scaffolding," and README.md's existing `#footprint-contract` section (referenced at README.md:34, :143) already documents the install-write-target axis under the word "footprint," not "scope." The rename this ADR makes is Construct catching its own flag name up to vocabulary the docs already settled on.
- `lib/scopes/lifecycle.mjs` and its `construct scope` subcommand are the *older*, more load-bearing usage: `specialists/org/scopes/<id>.json`, `schemas/scope.schema.json`, `docs/guides/concepts/profile-lifecycle.md`, and CLAUDE.md's protected-file guidance all use "scope" to mean the org profile. Renaming this side would touch a curated JSON schema, on-disk directory names (`specialists/org/scopes/`), and CLAUDE.md itself — a much larger and riskier surface than renaming one CLI flag family.
- Usage count (grepped 2026-07-09, this worktree): `--scope=` appears across 36 files (`.mjs`/`.md`/`.mdx`, excluding `node_modules`); `construct scope ` (the org-profile subcommand) appears across 19 files. Both are real surfaces; neither is trivially small, but install-scope's occurrences are concentrated in one flag family (`--scope=<value>`) versus org-scope's occurrences spanning a subcommand, a schema, a directory name, and CLAUDE.md's own text — install-scope is the cheaper and lower-risk side to rename.
- `docs/guides/start/connect-your-editor.mdx`'s "sync scope" (`--global` vs project-sync) is a third, distinct axis not covered by this ADR's flag rename (it's not a `lib/setup.mjs` flag) — flagged here as a follow-up doc-wording concern, not resolved by this decision.

## Decision

**Rename the install-write-target flag from `--scope` to `--footprint`.** Keep org-scope (`construct scope`, `lib/scopes/lifecycle.mjs`, `specialists/org/scopes/`) unchanged.

- New flag: `construct install --footprint=project|user|both` (same three values, same semantics, same defaults as today's `--scope`).
- `--footprint` aligns with vocabulary this repo already uses for exactly this axis: README's `#footprint-contract` section and ADR-0027/ADR-0066's "footprint" language. No new term is invented.
- `construct scope` (org-profile lifecycle) keeps its name. It is the more deeply embedded of the two — a schema, a directory name, and CLAUDE.md's own vocabulary — and CLAUDE.md already treats "profile" and "org-scope" as synonyms in prose, so a docs-side clarification (always say "org-scope" or "profile," never bare "scope," in first-run-adjacent text) is a lower-risk fix than a rename here.
- Backward compatibility during migration: `--scope` continues to work as a deprecated alias (parsed identically, with a one-line deprecation notice pointing at `--footprint`) until the follow-up implementation bead removes it — no silent breaking change to existing scripts/CI that pass `--scope=user`.
- First-five-minutes docs (`README.md`, `docs/guides/start/install.mdx`) must, wherever both concepts appear near each other, use "install footprint" and "org-scope / profile" as the two distinct terms rather than bare "scope" for either — this disambiguates by word choice even before the flag rename ships.

## Rationale

- **Cheaper side wins.** Install-scope's surface (one flag family, one module) is smaller and lower-risk to rename than org-scope's (schema + directory + CLAUDE.md-level vocabulary + external profile authors following `docs/guides/concepts/profile-lifecycle.md`).
- **Vocabulary already exists.** "Footprint" is not a new coinage — ADR-0027 and README's footprint-contract section already name this exact axis. Renaming to `--footprint` removes a synonym-drift problem (the flag says "scope," the docs describing the same thing say "footprint") rather than adding one.
- **Org-scope is the more correct use of the word.** "Scope" more naturally describes "the boundary of what a profile covers" (an org's roster/taxonomy scope) than "which machine tier gets written to." Keeping the more semantically apt usage and renaming the less apt one is the smaller net vocabulary distortion.

## Rejected alternatives

- **Rename org-scope instead (e.g. to "profile").** Rejected: CLAUDE.md already documents org-scopes under "Profiles are research artifacts" and uses "scope" and "profile" interchangeably in committed instructions; `specialists/org/scopes/` is a directory name baked into the profile-lifecycle docs and any project that has authored a custom scope via `construct scope create`. Renaming this side would require a schema migration (`schemas/scope.schema.json`) and a directory rename with far more external surface (any repo that ran `construct scope create <id>` already has `specialists/org/scopes/<id>.json` or a `.cx/org/scopes/<id>.json` on disk) than renaming a CLI flag.
- **Gate org-scope vocabulary out of first-run surfaces instead of renaming anything.** Rejected as the sole fix: it would leave the underlying flag named `--scope` forever, so any user who reaches `construct scope` later (which the roadmap wants adopted, not hidden) still collides with the install flag the moment both appear in the same session's history or `--help` output. A vocabulary rename resolves the collision permanently instead of just deferring first contact.
- **Do nothing; rely on context to disambiguate.** Rejected: this is the status quo the onboarding audit (parent epic `construct-ztksc`) flagged as a top trap. Context alone hasn't prevented the collision from surfacing in README.md within 20 lines today.

## Consequences

A follow-up implementation bead (filed as a child of `construct-ztksc`, see below) must: add `--footprint` as the canonical flag in `lib/setup.mjs` (`parseScopeFlag`/`printHelp`/`printInstallPlan`/error strings), keep `--scope` working as a deprecated alias for at least one release, update `README.md` and `docs/guides/start/install.mdx` to use `--footprint` as the primary example while still documenting the alias, and update ADR-0029's flag references to point at this ADR for the rename (ADR-0029's `project|user|both` semantics are otherwise unchanged and not superseded). `construct scope` and `lib/scopes/lifecycle.mjs` require no code change from this ADR; only doc wording (consistently saying "org-scope" or "profile" rather than bare "scope") needs to land in first-run-adjacent docs.

## Reversibility

Two-way door. `--footprint` and `--scope` coexisting as aliases costs nothing to reverse — either name can be dropped later without a data migration, since the flag only selects behavior at invocation time and writes no on-disk artifact that records which flag name was used. No schema, directory, or persisted state changes as part of this ADR.

## References

- `lib/setup.mjs:48-87` (`printHelp`, current `--scope` flag documentation), `lib/setup.mjs:305-315` (`parseScopeFlag`), `lib/setup.mjs:322-330` (bare-invocation hard-error), `lib/setup.mjs:359-372` (`printInstallPlan`)
- `lib/scopes/lifecycle.mjs:1-27` (module header defining org-scope; left unchanged by this ADR)
- `README.md:13,31,34,135,140,143,167,172,361` (both vocabularies appearing in the same first-run document)
- `docs/guides/start/connect-your-editor.mdx:6,8,40,42,43,51,110,122` (a third, unresolved "sync scope" usage, noted but out of scope for this ADR)
- ADR-0027 (host-project footprint — origin of "footprint" vocabulary this ADR adopts for the renamed flag)
- ADR-0029 (install scopes and hook budgets — the flag this ADR renames; semantics unchanged)
- CLAUDE.md, "Profiles are research artifacts, not JSON exercises" (org-scope/profile vocabulary, confirmed as the more deeply embedded usage this ADR leaves untouched)
