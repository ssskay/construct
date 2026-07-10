# construct documentation

> Required project state. All LLMs working in this repo, including Construct, must keep the core documents below current.

<!-- AUTO:core-docs -->
## Required core documents

| File | Purpose | Update when |
|---|---|---|
| `AGENTS.md` | Canonical agent operating contract | Workflow rules, tracker hierarchy, or repo-wide guardrails change |
| `.cx/context.md` | Human-readable resumable project context | Active work, decisions, architecture assumptions, or open questions change |
| `.cx/context.json` | Machine-readable resumable context | Context state needs to stay in sync with `.cx/context.md` |
| `docs/README.md` | Docs index and maintenance contract | Core docs set or maintenance expectations change |
| `docs/guides/concepts/architecture.mdx` | Canonical architecture and invariants | Runtime shape, contracts, boundaries, or major dependencies change |

`plan.md` is a local working document. `construct init` creates it for the active session, but it is gitignored and not committed; durable work belongs in the tracker (Beads or external).

Tracker hierarchy: external tracker (prefer Beads) for durable work, `plan.md` for the local working plan, and cass-memory via MCP `memory` for cross-session recall.

`AGENTS.md` is the canonical agent instruction file. On case-sensitive filesystems you may also add a lowercase `agents.md` shim for tools that require it.
All LLMs working in the repo, including Construct, must read these as project state, keep them current when work changes project reality, and prune stale sections instead of letting managed docs drift.
<!-- /AUTO:core-docs -->

## File format: `.md` vs `.mdx`

Use **`.md`** for every prose page (CommonMark + YAML frontmatter). Reserve **`.mdx`** only when a page embeds `@cx/ui` MDX components (`<FlowPipeline>`, `<RequestFlow>`, `<Callout>`, …). The docs site compiles both through the same pipeline: prose-only bodies are sanitized and rendered as Markdown; JSX pages stay on the MDX path (`apps/docs/lib/docs-source.ts` → `prepareDocBody`).

## Contents

- [Start](./guides/start/). Install, initialize a project, connect an editor, and run the first task
- [Architecture](./guides/concepts/architecture.mdx). Runtime shape, boundaries, and system map
- [Agents and personas](./guides/concepts/agents-and-personas.mdx). One public persona with specialists behind it
- [Deployment model](./guides/concepts/deployment-model.mdx). Solo, team, and enterprise topology
- [Prompt surface architecture](./guides/concepts/prompt-surfaces.mdx). Persona, specialist, skill, rule, and fixture surfaces
- [Knowledge layout](./guides/concepts/knowledge-layout.md). `.cx/` directory structure, inbox routing, and durable knowledge lanes
- [Project scopes](./guides/concepts/project-scopes.md). `.construct` vs `.cx` vs user home — what belongs in git
- [Intake and triage](./guides/concepts/intake-and-triage.mdx). How dropped signals become owner-assigned work
- [Gates and enforcement](./guides/concepts/gates-and-enforcement.mdx). Write-time, commit-time, and CI guardrails
- [Style](./STYLE.md). Voice, punctuation, structure rules (canonical reference for prose lint)
- [Branding](./guides/reference/branding.md). Visual identity, naming, voice, tone, and profile terminology
- [Learning loops](./guides/concepts/learning-loops.mdx). What is wired vs aspirational across A1-A4
- [Profile lifecycle](./guides/concepts/profile-lifecycle.md). Draft → promote → archive flow for org-type profiles
- [Persona and skill research](./guides/concepts/persona-research.md). Methodology grounded in Goodwin, Cooper, Galbraith STAR, Bloom
- [Release policy](./operations/maintenance/release-policy.md). When to tag
- [Release and deploy automation](./operations/maintenance/release-and-deploy.md). What fires when you tag, plus the failure-mode lookup
- [Templates and role anti-patterns](../templates/docs/README.md)
- [Runbooks](./operations/runbooks/)
- [ADRs](./decisions/adr/). Architecture decision records (public site lane)
- [PRD platform artifacts](./prd-platform/README.md). Draft and certified platform PRDs
- [Skills](../skills/). Domain knowledge organized by area (compliance, architecture, AI, development, devops, etc.)
- [Functional tests pattern](../tests/functional/README.md). When and how to add an end-to-end test

## Maintainer lanes (not on the public site)

These directories stay in git for Construct maintainers. They are excluded from the published docs site and not linked from README.

- [Audit snapshots](./operations/audit/). Dated alignment scorecards and baseline evidence
- [Research notes](./notes/research/). Competitive audits and synthesis reports; ADR-cited inputs in [decision-input](./notes/research/decision-input/)
- [PRDs](./specs/prd/). Draft product requirements for this repo
- [Roadmap](./roadmap.md). Generated placeholder (excluded from public site)
- [Tests audit](../tests/AUDIT.md). Category-by-category survey of test files

## How-to guides

Step-by-step operator guides for common tasks:

- [Quick start](./guides/cookbook/quick-start.md)
- [Use the inbox](./guides/cookbook/use-the-inbox.mdx)
- [Configure Slack](./guides/cookbook/configure-slack.md)
- [Configure GitHub](./guides/cookbook/configure-github.md)
- [Configure Jira and Confluence](./guides/cookbook/configure-jira-confluence.md)
- [Override the storage root (`CX_DATA_DIR`)](./guides/cookbook/override-storage-root.md)
- [Manage providers](./guides/cookbook/manage-providers.md)
- [Plug in your own LLM](./guides/cookbook/plug-in-your-own-llm.mdx)
- [Generate artifacts](./guides/cookbook/generate-artifacts.mdx)
- [Query the knowledge base](./guides/cookbook/query-the-knowledge-base.md)
- [Multi-project context — register, synthesize, contribute](./guides/cookbook/multi-project-context.md)
- [Observability and cost](./guides/cookbook/observability-and-cost.md)
- [Wireframe and drop commands](./guides/cookbook/wireframe-and-drop.md)
- [Distill and infer commands](./guides/cookbook/distill-and-infer.md)

## Command Coverage

Use the generated [CLI reference](./guides/reference/cli/) for exact flags and subcommands. The docs index intentionally points advanced commands to the reference when a dedicated tutorial would add little beyond the command help.

- Core: `construct docs`, `construct recommendations`, `construct sandbox`
- Workflows and knowledge: `construct customer`, `construct graph`, `construct integrations`, `construct reflect`, `construct tags`, `construct workflow`, `construct workspace`
- Models and integrations: `construct claude:allow`, `construct creds`, `construct ollama`
- Observability and diagnostics: `construct audit`, `construct llm-judge`, `construct telemetry`, `construct cleanup`
- Administration: `construct auth:status`, `construct backup`, `construct beads`, `construct completions`, `construct gates:audit`, `construct hooks:health`, `construct role`, `construct scheduler`, `construct uninstall`, `construct upgrade`

## Prompt surfaces

`docs/guides/concepts/prompt-surfaces.mdx` is the canonical reference for the prompt architecture.

It defines:

- the sole public persona surface
- internal specialist prompts and role overlays
- offline-only example fixtures
- the required fixture coverage policy

## Prompt examples

Shipped prompt example fixtures live under `examples/`.

They are the canonical place for:

- Construct public persona fixtures under `examples/personas/construct/**`
- internal role fixtures under `examples/internal/roles/**`
- labeled bad, boundary, and adversarial cases without bloating runtime prompts

## Maintenance

After updating the Construct repo checkout itself, run `construct update` from inside that checkout to reinstall the current source globally and refresh synced host adapters before continuing work.

When a managed file stops reflecting repo reality, update it or prune the stale section. Managed docs are not archives.

Parallel work rule: one writer per file. If multiple agent or harness sessions are active, coordinate ownership through the tracker and `plan.md` instead of editing the same file concurrently.

<!-- AUTO:catalog-sync -->
## Capability catalog (generated)

> Narrative docs index — this table is regenerated from `registry/capabilities.json`.
> Run `npm run docs:sync` after catalog changes. Do not hand-edit inside the AUTO markers.

Catalog census: 136 CLI commands, 46 npm scripts, 11 embedded workflows.

| Capability | Criticality | CLI surface | Verification |
|---|---|---|---|
| `ingest.adapter` | P0 | construct ingest | `tests/functional/node-native-extraction.functional.test.mjs` |
| `ingest.docling` | P1 | construct ingest --legacy-extractor=false | `tests/functional/mcp-ingest-resilience.functional.test.mjs` |
| `local.model.tier` | P1 | construct models resolve | `—` |
| `mcp.broker.connection` | P0 | — | `tests/functional/mcp-parity.functional.test.mjs` |
| `oracle.meta-review` | P1 | construct oracle review | `tests/functional/oracle-bounded-auto.functional.test.mjs` |
| `orchestration.routing` | P0 | construct orchestrate run | `tests/functional/orchestration-mcp.functional.test.mjs` |
| `surfaces.opencode-primary` | P1 | construct sync | `tests/functional/opencode-primary-surface.functional.test.mjs` |
| `workflow.architecture-review` | P1 | construct workflow invoke | `tests/functional/embedded-contract-workflow-invoke.functional.test.mjs` |
| `workflow.evidence-ingest` | P1 | construct workflow invoke | `tests/functional/embedded-contract-workflow-invoke.functional.test.mjs` |
| `workflow.prd-draft` | P1 | construct workflow invoke | `tests/functional/embedded-contract-workflow-invoke.functional.test.mjs` |
| `workflow.proposal-review` | P1 | construct workflow invoke | `tests/functional/embedded-contract-workflow-invoke.functional.test.mjs` |
| `workflow.research-synthesis` | P1 | construct ask | `tests/functional/embedded-contract-workflow-invoke.functional.test.mjs` |
| `workflow.risk-review` | P1 | construct workflow invoke | `tests/functional/embedded-contract-workflow-invoke.functional.test.mjs` |
<!-- /AUTO:catalog-sync -->

## Ownership

Maintained by: Construct contributors
Last updated: 2026-06-19
