---
cx_doc_id: 019ddb68-5aed-7979-8f84-32c426683a06
created_at: "2026-04-29T22:42:22.573Z"
updated_at: "2026-06-19T00:00:00.000Z"
generator: construct/init-docs
body_hash: "sha256:841cc5539956827500098cf3d7b479ef17aeecc3bc9a9c9ff0b7c05b03f28b95"
---
<!--
docs/decisions/adr/README.md: lane guide and status index for ADRs.
-->

# ADRs

Architecture decision records for decisions that have already been made.

## Status index

| ADR | Title | Status | Notes |
|---|---|---|---|
| [0001](./0001-zero-npm-core.md) | Zero npm dependencies in core | accepted | Foundational |
| [0002](./0002-layered-architecture.md) | Layered architecture with transport-agnostic provider abstraction | proposed | |
| [0003](./0003-provider-interface.md) | Transport-agnostic provider interface | accepted | |
| [0013](./0013-skills-on-disk-layout.md) | Skills on-disk layout | accepted | |
| [0014](./0014-local-embeddings-optional.md) | Local embeddings optional | accepted | |
| [0015](./0015-affirm-hybrid-architecture.md) | Affirm hybrid markdown + deterministic enforcement | proposed | Core split affirmed; org-shape audit superseded in part by ADR-0065 |
| [0016](./0016-capability-parity-contract.md) | Capability parity contract | proposed | |
| [0017](./0017-source-credibility-taxonomy.md) | Source credibility taxonomy | proposed | |
| [0018](./0018-document-quality-standard.md) | Document quality standard | proposed | |
| [0019](./0019-execution-capability-descriptive-contract.md) | Execution-capability descriptive contract | proposed | |
| [0020](./0020-local-orchestration-runtime.md) | Local orchestration runtime | proposed | |
| [0021](./0021-provider-worker-backend-and-pluggable-run-stores.md) | Provider worker backend and pluggable run stores | proposed | |
| [0022](./0022-orchestration-daemon-api.md) | Orchestration daemon API | proposed | |
| [0023](./0023-acp-agent.md) | Construct as ACP server | proposed | Server scope deferred |
| [0024](./0024-document-io-optional-capability.md) | Document I/O optional capability | accepted | |
| [0025](./0025-explicit-activation-model.md) | Explicit activation model | accepted | |
| [0026](./0026-beads-git-native-sync.md) | Beads git-native sync | accepted | |
| [0027](./0027-host-project-footprint-and-non-destructive-scaffolding.md) | Host/project footprint | accepted | Marker-block discipline affirmed; in-project heavy-state disposition superseded in part by ADR-0066 |
| [0028](./0028-js-yaml-frontmatter-exception.md) | JS YAML frontmatter exception | accepted | |
| [0029](./0029-install-scopes-and-hook-budgets.md) | Install scopes and hook budgets | proposed | |
| [0030](./0030-chain-of-thought-disclosure.md) | Chain-of-thought disclosure | accepted | |
| [0031](./0031-browser-automation-is-opt-in.md) | Browser automation is opt-in | proposed | |
| [0032](./0032-small-model-context-methodology.md) | Small-model context methodology | accepted | |
| [0033](./0033-platform-capability-registry.md) | Platform capability registry | accepted | |
| [0034](./0034-local-vs-cloud-methodology-split.md) | Local-vs-cloud methodology split | accepted | |
| [0035](./0035-test-strategy-extend-not-rebuild.md) | Test strategy — extend, not rebuild | superseded | ADR-0058 |
| [0036](./0036-document-ingestion-docling-mcp-evaluation.md) | Document ingestion — docling sidecar | accepted | |
| [0037](./0037-specialist-prompt-format.md) | Specialist prompt format | proposed | |
| [0038](./0038-adaptive-local-prompt-composition.md) | Adaptive local-model prompt composition | accepted | |
| [0039](./0039-interaction-surface-model.md) | Interaction-surface model | accepted | |
| [0042](./0042-llm-credential-resolution.md) | LLM credential resolution | accepted | |
| [0043](./0043-oracle-meta-controller.md) | Oracle meta-controller | accepted | |
| [0044](./0044-tool-repo-root-layout.md) | Tool-repo root layout hygiene | accepted | |
| [0045](./0045-config-scope-docs-taxonomy-intake.md) | Local/global config boundary, docs taxonomy, and a single intake zone | proposed | |
| [0046](./0046-modular-org-runtime-merge.md) | Modular org layout with runtime registry merge | accepted | |
| [0047](./0047-specialist-vs-flavor-model.md) | Specialist vs flavor taxonomy | accepted | |
| [0048](./0048-semantic-tool-discovery.md) | Semantic tool discovery | accepted | |
| [0049](./0049-cross-process-auth-once.md) | Cross-process auth-once for 1Password resolution | accepted | |
| [0050](./0050-worker-scoped-governed-web-capability.md) | Worker-scoped governed web capability (unified WebGrant) | accepted | |
| [0051](./0051-lmcp-a1-team-backend-git-queue.md) | LMCP-A1: git-queue as the team backend | accepted | |
| [0052](./0052-lmcp-a2-unified-provider-manifest.md) | LMCP-A2: unified extension/provider manifest architecture | accepted | |
| [0053](./0053-lmcp-a3-living-graph-architecture.md) | LMCP-A3: living graph architecture | accepted | |
| [0054](./0054-lmcp-a4-workflow-manifest-schema.md) | LMCP-A4: workflow manifest schema | accepted | |
| [0055](./0055-lmcp-a5-pack-schema-versioning-prompt-failure.md) | LMCP-A5: pack schema, versioning, prompt-failure rules | accepted | |
| [0056](./0056-lmcp-a6-policy-approval-identity-model.md) | LMCP-A6: policy/approval/identity model | accepted | |
| [0057](./0057-lmcp-a7-enterprise-baseline-cut-lines.md) | LMCP-A7: enterprise baseline cut lines | accepted | |
| [0058](./0058-lmcp-a8-test-suite-rebuild-strategy.md) | LMCP-A8: test-suite rebuild strategy (supersedes 0035) | accepted | |
| [0059](./0059-lmcp-a9-dependency-intent-rubric.md) | LMCP-A9: dependency-intent rubric | accepted | |
| [0060](./0060-lmcp-b10-provider-filter-dsl.md) | LMCP-B10: provider filter DSL semantics + config placement | accepted | |
| [0061](./0061-lmcp-p1-embed-capability-schema-runtime-placement.md) | LMCP-P1: embed-capability schema + runtime placement | accepted | |
| [0062](./0062-lmcp-f6-persona-reasoning-framework-format.md) | LMCP-F6: persona reasoning framework format | accepted | |
| [0063](./0063-host-subscription-execution-pickup-and-sampling.md) | Execution seats: host-subscription execution (pickup + sampling) | accepted | |
| [0064](./0064-language-runtime-strategy.md) | Language & runtime strategy — Node core, Bun-compiled distribution, Python sidecar | accepted | Supersedes implicit npm-only distribution |
| [0065](./0065-orchestrator-worker-consolidation.md) | Orchestrator-worker consolidation | accepted | Supersedes org-shape portions of ADR-0015; [roster-mapping appendix](./appendix-0065-roster-mapping.md) is a proposal pending review, not itself a decision |
| [0066](./0066-config-layer-project-footprint.md) | Config-layer project footprint — machine-scoped heavy state | accepted | Supersedes in-project heavy-state disposition of ADR-0027 |
| [0067](./0067-deterministic-flow-engine.md) | Deterministic flow engine | accepted | Supersedes chain-resolution role of orchestration-policy.mjs |
| [0068](./0068-ingestion-sidecar-process-contract.md) | Ingestion sidecar process contract | accepted | Formalizes the docling sidecar's existing shape; not a supersession |
| [0069](./0069-ci-review-gate-deterministic-backend.md) | CI review gate: deterministic diff review backend | accepted | |
| [0070](./0070-participation-pipeline-and-rules-schema.md) | Condition-driven participation: recruit/collaborate/execute/enforce pipeline + participationRules schema | proposed | Supersedes recruitment scope of construct-ca4's WATCHERS/evaluateWatchConditions |

## Starter templates

- [_template.md](./templates/_template.md)
