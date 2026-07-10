---
title: Core
description: Core commands for Construct.
---

# Core

| Command | What it does |
|---|---|
| `construct approvals` | Manage pending MCP tool approvals |
| `construct dev` | Start services for development |
| `construct docs` | Documentation commands |
| `construct doctor` | Check installation health |
| `construct init` | Project setup (once per repo): scaffold .cx/, AGENTS.md, plan.md, adapters |
| `construct install` | Machine setup (footprint per ADR-0029/ADR-0071): --footprint=project\|user\|both, default project |
| `construct intake` | View and process the active profile's intake queue (queue label varies by profile) |
| `construct oracle` | Oracle meta-controller — fleet health review and bounded-auto maintenance |
| `construct recommendations` | View and manage artifact recommendations |
| `construct sandbox` | Isolated tmpdir-based environment for QA / specialist dry-runs |
| `construct scope` | Manage the active org scope and its lifecycle (draft, promote, archive, health) |
| `construct status` | Show system health and credentials |
| `construct stop` | Stop all running services |
| `construct sync` | Sync agent adapters to AI tools |
| `construct workers` | List registered team workers and heartbeat freshness |

## construct approvals

Manage pending MCP tool approvals

**Usage**

```bash
construct approvals list|approve|deny|status
```

**Subcommands**

- `list` — List pending approvals with tool name, requestedAt, requestedBy
- `approve <id>` — Approve a pending approval by id
- `deny <id> [--reason=...]` — Deny a pending approval by id
- `status <id>` — Show the full status of a specific approval

## construct dev

Start services for development

**Usage**

```bash
construct dev [--select] [--only=memory,opencode,...]
```

**Options**

| Flag | Description |
|---|---|
| `--select` | Pick which services to start from an interactive checklist |
| `--only=<a,b,c>` | Start only the named services (telemetry, memory, opencode, copilot-bridge) |

## construct docs

Documentation commands

**Usage**

```bash
construct docs check|verify|update
```

**Subcommands**

- `check` — Check for missing how-to guides
- `verify` — Validate documentation quality
- `update` — Regenerate AUTO-managed regions

## construct doctor

Check installation health

**Usage**

```bash
construct doctor [<status|logs|tick|report|consistency|watch|stop|credentials>] [--fix-legacy-agents]
```

**Subcommands**

- `status` — Doctor daemon status
- `logs` — Tail doctor daemon logs
- `tick` — Run one doctor daemon check cycle now
- `report` — Print the latest health report
- `consistency` — Run cross-surface consistency checks
- `watch` — Start the doctor daemon (continuous checks)
- `stop` — Stop the doctor daemon
- `credentials` — Diagnose provider credential resolution

**Options**

| Flag | Description |
|---|---|
| `--fix-legacy-agents` | Sweep legacy cx-*.md agents at user scope and re-sync |

## construct init

Project setup (once per repo): scaffold .cx/, AGENTS.md, plan.md, adapters

**Usage**

```bash
construct init [path] [options]
```

**Options**

| Flag | Description |
|---|---|
| `--yes` | Accept all defaults (non-interactive) |
| `--no-start` | Do not start services after init |
| `--commit-bootstrap` | Keep the beads bootstrap commit (default: leave files uncommitted) |
| `--with-<host>` | Force an adapter set (claude|codex|opencode|vscode|cursor|copilot); default writes detected hosts only |
| `--all-hosts` | Write every adapter set regardless of what is installed |
| `--interactive, -i` | Enable interactive setup with project detection |
| `--quiet, -q` | Minimal output |
| `--verbose, -v` | Detailed output |
| `--with-docs=adrs,rfcs` | Enable specific doc lanes (comma-separated) |
| `--with-all-docs` | Enable all documentation lanes |
| `--with-adrs` | Enable Architecture Decision Records |
| `--with-rfcs` | Enable RFCs (design reviews) |
| `--with-runbooks` | Enable operational runbooks |
| `--with-postmortems` | Enable incident postmortems |
| `--with-architecture` | Create architecture.md |

## construct install

Machine setup (footprint per ADR-0029/ADR-0071): --footprint=project|user|both, default project

**Usage**

```bash
construct install [--footprint=project|user|both] [--yes] [--dry-run] [--no-launch-agent] [--reconfigure] [--with-docling]
```

**Options**

| Flag | Description |
|---|---|
| `--footprint=<f>` | project (default, no-op + guidance) | user (writes ~/.config/construct/, MCP, ~/.claude/* via consent) | both |
| `--scope=<s>` | deprecated alias for --footprint (same values); prints a deprecation notice — see ADR-0071 |
| `--yes` | Apply defaults without prompts (only meaningful with --footprint=user|both) |
| `--dry-run` | Preview the install plan (footprints, files, services) without writing anything |
| `--no-launch-agent` | Skip background macOS LaunchAgent registration |
| `--reconfigure` | Re-prompt for service consent, ignoring cached answers |
| `--with-docling` | Eagerly provision the docling document-extraction venv now (heavy, ~10 min; else lazy on first ingest) |

## construct intake

View and process the active profile's intake queue (queue label varies by profile)

**Usage**

```bash
construct intake list|show|done|skip|reopen|integrate|classify
```

**Subcommands**

- `list` — List pending packets
- `show <id>` — Show one packet (triage, related docs, excerpt, tag suggestions)
- `done <id> [--output=<path>]` — Mark processed; optionally stamp the produced artifact
- `skip <id> [--reason=…]` — Drop without action; preserves audit trail
- `reopen <id>` — Move a processed or skipped packet back to pending
- `integrate <id> <github|jira|confluence> [--publish-issues]` — Create an external ticket from a packet (--publish-issues unlocks the demo-source gate)
- `classify --json [--text|--file|<stdin>]` — Classify an artifact and return a role-aware plan without enqueuing (embedded contract)

## construct oracle

Oracle meta-controller — fleet health review and bounded-auto maintenance

**Usage**

```bash
construct oracle start|status|review|pending|approve|gaps|reconcile
```

## construct recommendations

View and manage artifact recommendations

**Usage**

```bash
construct recommendations list|show|dismiss|stats
```

## construct sandbox

Isolated tmpdir-based environment for QA / specialist dry-runs

**Usage**

```bash
construct sandbox create|list|delete|prune [--profile=<id>]
```

**Subcommands**

- `create [--profile=<id>]` — Create a new sandbox under ~/.cx/sandboxes/
- `list` — List existing sandboxes, newest first
- `delete <id>` — Remove one sandbox by id
- `prune [--days=N]` — Remove sandboxes older than N days (default 7)

## construct scope

Manage the active org scope and its lifecycle (draft, promote, archive, health)

**Usage**

```bash
construct scope show|list|set|create|drafts|archive|health
```

**Subcommands**

- `show` — Show the active scope
- `list` — List curated scopes
- `set <id>` — Switch the active scope (writes construct.config.json)
- `create <id> [--display=…] [--role=…] [--department=…] [--yes|--dry-run]` — Scaffold a draft scope; previews and confirms by default, prompts interactively when no flags
- `drafts` — List in-progress draft scopes
- `archive <id> --reason="..."` — Move a curated scope into archive/scopes/<id>/
- `health <id> [--days=N]` — Per-scope observation + outcome rollup

## construct status

Show system health and credentials

**Usage**

```bash
construct status
```

**Options**

| Flag | Description |
|---|---|
| `--json` | Output full status payload as JSON |

## construct stop

Stop all running services

**Usage**

```bash
construct stop
```

## construct sync

Sync agent adapters to AI tools

**Usage**

```bash
construct sync [--project] [--dry-run] [--no-docs] [--compress-personas]
```

**Options**

| Flag | Description |
|---|---|
| `--project` | Write project-local Claude adapters into the current repo only |
| `--dry-run` | Preview adapter changes without writing files |
| `--no-docs` | Skip AUTO docs regeneration after syncing adapters |
| `--compress-personas` | Write compressed runtime persona prompts without changing the source prompts |

## construct workers

List registered team workers and heartbeat freshness

**Usage**

```bash
construct workers <list> [--json]
```

**Options**

| Flag | Description |
|---|---|
| `--json` | Output worker list as JSON |
