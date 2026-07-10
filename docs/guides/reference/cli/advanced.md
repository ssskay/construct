---
title: Advanced
description: Advanced commands for Construct.
---

# Advanced

| Command | What it does |
|---|---|
| `construct auth:status` | Check auth status |
| `construct backup` | System backups |
| `construct beads` | Task queue management |
| `construct beads:stats` | Show beads counters and drift summary |
| `construct ci` | Local CI mirror: run CI jobs locally or view recent run status |
| `construct completions` | Shell completion scripts |
| `construct config` | Deployment mode configuration |
| `construct decisions` | Index load-bearing decisions and their enforcement bindings |
| `construct deployment` | Deployment posture tools (capability parity contract) |
| `construct diff` | Show agent changes since HEAD |
| `construct embed` | Embed mode management |
| `construct gates:audit` | Audit policy gates |
| `construct hooks:health` | Check hook health |
| `construct list` | List all agents |
| `construct monitor` | One-command setup for continuous monitoring-as-a-role: sources.targets + embed.yaml roles + capability enable + daemon start |
| `construct policy` | Show active policy gates with enforcement details |
| `construct provider` | Provider management |
| `construct role` | Role framework management |
| `construct roles:list` | List installed role contracts |
| `construct roles:set` | Activate a role contract |
| `construct scheduler` | Manage scheduled background jobs (tag-mining, doc-hygiene, skill-rollup) |
| `construct skills` | Skill relevance detection |
| `construct sources` | Manage typed integration source targets in construct.config.json |
| `construct templates` | List doc templates and register custom document classes (project-tier overlay; builtin manifest untouched) |
| `construct uninstall` | Remove Construct state |
| `construct update` | Reinstall this checkout |
| `construct upgrade` | Upgrade to latest npm version |
| `construct validate` | Validate registry structure |
| `construct version` | Show version |

## construct auth:status

Check auth status

**Usage**

```bash
construct auth:status
```

## construct backup

System backups

**Usage**

```bash
construct backup create|restore
```

## construct beads

Task queue management

**Usage**

```bash
construct beads <list|show|create|update|close|drift|stats>
```

## construct beads:stats

Show beads counters and drift summary

**Usage**

```bash
construct beads:stats
```

## construct ci

Local CI mirror: run CI jobs locally or view recent run status

**Usage**

```bash
construct ci <preview|status|list>
```

**Options**

| Flag | Description |
|---|---|
| `--job=<name>` | Run a single CI job by id or name fragment |
| `--list` | List all jobs without running them |
| `--full` | Include Docker/Trivy steps (requires Docker daemon) |

## construct completions

Shell completion scripts

**Usage**

```bash
construct completions <bash|zsh|install>
```

## construct config

Deployment mode configuration

**Usage**

```bash
construct config <get|set>
```

## construct decisions

Index load-bearing decisions and their enforcement bindings

**Usage**

```bash
construct decisions [list|validate|json|check|baseline|golden]
```

**Options**

| Flag | Description |
|---|---|
| `list` | Show decisions with status and enforcement (default) |
| `validate` | Validate registry structure; exit 1 on error |
| `check` | Fail on dangling markers, enforcement/supersede/linkage/precedence drift |
| `baseline` | Print the enforced baseline; --write to regenerate it |
| `golden` | Check the CLI/agent/hook surface snapshot; --write to regenerate it |
| `json` | Emit the full registry as JSON |

## construct deployment

Deployment posture tools (capability parity contract)

**Usage**

```bash
construct deployment parity
```

**Options**

| Flag | Description |
|---|---|
| `parity` | Show and validate capability parity across solo/team/enterprise |
| `--json` | Emit the parity contract as JSON |

## construct diff

Show agent changes since HEAD

**Usage**

```bash
construct diff
```

## construct embed

Embed mode management

**Usage**

```bash
construct embed start|stop|status|list|enable|disable|dry-run
```

**Subcommands**

- `start` — Fork the detached embed daemon
- `stop` — Stop the running embed daemon
- `status [<id>] [--json]` — Daemon status, or per-capability bindings/filter/runtime/last-tick with an id
- `list [--json]` — Available embed capabilities and per-project enabled state (ADR-0061)
- `enable <id>` — Enable an embed capability: validate and write .cx/embed/<id>.manifest.json
- `disable <id>` — Disable an embed capability (idempotent)
- `dry-run <id> [--json]` — Resolve the specialist→providers→filter→framework→authority→runtime chain; no side effects

## construct gates:audit

Audit policy gates

**Usage**

```bash
construct gates:audit
```

## construct hooks:health

Check hook health

**Usage**

```bash
construct hooks:health
```

## construct list

List all agents

**Usage**

```bash
construct list
```

## construct monitor

One-command setup for continuous monitoring-as-a-role: sources.targets + embed.yaml roles + capability enable + daemon start

**Usage**

```bash
construct monitor --as <capability-id> --targets <provider:value>[,...] [--secondary <role>] [--config <path>] [--no-start] [--supervise]
```

**Options**

| Flag | Description |
|---|---|
| `--as <capability-id>` | Embed capability to enable (see `construct embed list`); its specialist becomes embed.yaml roles.primary |
| `--targets <spec>[,<spec>...]` | Comma-separated provider:value targets (e.g. github:org/repo, jira:PROJ, slack:channel:intent); repeatable |
| `--secondary <role>` | Set embed.yaml roles.secondary |
| `--config <path>` | embed.yaml path (default: ./embed.yaml) |
| `--no-start` | Assemble config and enable the capability but do not start the daemon |
| `--supervise` | Also install OS-level supervision (construct embed supervise) after starting |

## construct policy

Show active policy gates with enforcement details

**Usage**

```bash
construct policy show
```

**Options**

| Flag | Description |
|---|---|
| `--json` | Output as JSON |

## construct provider

Provider management

**Usage**

```bash
construct provider list|status|health|validate|test|add|configure
```

**Subcommands**

- `list` — List all resolved providers with capabilities and health
- `status [--json]` — Alias of list with breaker state, degradation, and active filter columns
- `health [id] [--json]` — Run health probes; exits non-zero if any probe fails
- `validate <path|id> [--strict] [--json]` — Validate a manifest file or provider id against the B1 schema
- `info <id>` — Show a single provider's metadata and config schema
- `test <id>` — Run one provider's health probe; exits non-zero on failure
- `add <id> [--json]` — Scaffold instance config from the provider's configSchema defaults, persisted to .cx/providers/<id>.json
- `configure <id> [--key.path value ...] [--json]` — Merge + validate instance config (incl. ADR-0060 filter block) against configSchema; rejects with the schema path on failure
- `plugins <add|remove> <id> [<package>] [--global]` — Register or remove a plugin provider override
- `new <name> [--capabilities=...]` — Scaffold a new provider module

## construct role

Role framework management

**Usage**

```bash
construct role <list|latest|show|status|resolve|prune|reset>
```

## construct roles:list

List installed role contracts

**Usage**

```bash
construct roles:list
```

## construct roles:set

Activate a role contract

**Usage**

```bash
construct roles:set <role>
```

## construct scheduler

Manage scheduled background jobs (tag-mining, doc-hygiene, skill-rollup)

**Usage**

```bash
construct scheduler <list|run|runner>
```

## construct skills

Skill relevance detection

**Usage**

```bash
construct skills <scope|apply|suggest|routing>
```

**Subcommands**

- `scope` — Show skill scope for the active profile
- `apply` — Apply skill profile to host config
- `suggest` — Rank skills for an intent string
- `routing` — Dump machine-readable routing table

## construct sources

Manage typed integration source targets in construct.config.json

**Usage**

```bash
construct sources list|add|remove|validate|sync
```

**Subcommands**

- `list` — Show config targets, legacy env merge, corpus freshness, and effective set
- `add <provider> <id> <selector-json>` — Add a typed target (directory, github, jira, linear, slack)
- `remove <id>` — Remove a config target by id
- `validate` — Validate sources.targets in construct.config.json
- `sync [<id>]` — Clone/fetch the content cache for corpus targets

## construct templates

List doc templates and register custom document classes (project-tier overlay; builtin manifest untouched)

**Usage**

```bash
construct templates list|register <type>
```

**Subcommands**

- `list` — Show shipped templates and project overrides
- `register <type> [--description "..."] [--from <file>] [--force]` — Register a custom doc class: writes .cx/templates/docs/<type>.md + a project artifact-manifest overlay entry

## construct uninstall

Remove Construct state

**Usage**

```bash
construct uninstall [--dry-run] [--yes] [--all] [--keep-state] [--scope=project|machine|all]
```

**Options**

| Flag | Description |
|---|---|
| `--dry-run` | Print the plan and exit; change nothing |
| `--yes` | Remove auto-risk (✓) categories without prompting |
| `--all` | Combined with --yes: also remove ask-risk (◐) categories (project data, machine config) |
| `--keep-state` | Only remove the launcher + adapters; preserve .cx/, ~/.config/construct, Postgres |
| `--scope=<...>` | Limit to project | machine | all (default: all) |

## construct update

Reinstall this checkout

**Usage**

```bash
construct update
```

## construct upgrade

Upgrade to latest npm version

**Usage**

```bash
construct upgrade
```

## construct validate

Validate registry structure

**Usage**

```bash
construct validate
```

## construct version

Show version

**Usage**

```bash
construct version | construct --version
```
