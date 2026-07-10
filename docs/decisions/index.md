---
title: Decisions
description: Architectural memory — ADRs, RFCs, PRDs.
---

Construct keeps three kinds of durable decision artifact, each with a numbered, append-only history.

## ADRs (Architecture Decision Records)

Short records of an architecturally significant decision that's already been made. Captures the choice, the alternatives considered, and the consequences.

Browse the [`docs/decisions/adr/`](https://github.com/geraldmaron/construct/tree/main/docs/decisions/adr) directory on GitHub.

Latest: [ADR-0071 — Install "footprint" vs org-scope naming](./adr/0071-install-footprint-vs-org-scope-naming.md) (renames `construct install --scope` to `--footprint`, resolving the collision with `construct scope`/org-profile vocabulary; extends ADR-0029, adopts the "footprint" term ADR-0027 already established). The 2026-07 orchestrator-worker refit (`plan.md`, epic `construct-rf26`) landed four decisions in sequence: [ADR-0064](./adr/0064-language-runtime-strategy.md) (Node core stays, Bun-compiled binary distribution, Python confined to one uv sidecar — supersedes implicit npm-only distribution), [ADR-0065](./adr/0065-orchestrator-worker-consolidation.md) (orchestrator + small core roster supersedes the 29-specialist role-crew org), [ADR-0066](./adr/0066-config-layer-project-footprint.md) (machine-scoped heavy state supersedes the in-project footprint disposition of ADR-0027), and [ADR-0067](./adr/0067-deterministic-flow-engine.md) (deterministic flow engine supersedes the chain-resolution role of `lib/orchestration-policy.mjs`). See also [ADR-0043 — Oracle meta-controller](./adr/0043-oracle-meta-controller.md) and [ADR-0039 — Interaction-surface model](./adr/0039-interaction-surface-model.md).

## RFCs (Request for Comments)

Proposals for significant changes that need feedback before commitment. Each RFC names a problem, surveys options, proposes a direction, and lays out a migration plan.

Browse the [`docs/decisions/rfc/`](https://github.com/geraldmaron/construct/tree/main/docs/decisions/rfc) directory on GitHub.

## PRDs (Product Requirements Documents)

Specifications for a feature or product — problem, audience, requirements, success criteria.

Browse the [`docs/specs/prd/`](https://github.com/geraldmaron/construct/tree/main/docs/specs/prd) directory on GitHub.

## How the lanes work

The plural directories (`templates/docs/prds/`, `templates/docs/rfcs/`, etc.) are init lane templates — `construct init` clones them into downstream projects. The singular directories (`docs/specs/prd/`, `docs/decisions/rfc/`, `docs/decisions/adr/`) hold *this* repo's numbered artifacts.
