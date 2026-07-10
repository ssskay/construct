---
title: Observability
description: Observability commands for Construct.
---

# Observability

| Command | What it does |
|---|---|
| `construct efficiency` | Show read efficiency, repeated files, and context-budget guidance |
| `construct eval-datasets` | Sync scored traces from the telemetry backend into eval datasets for prompt regression testing |
| `construct evals` | Show evaluator catalog for prompt and agent experiments |
| `construct feedback:history` | Show recorded outcome ratings |
| `construct feedback:record` | Record an outcome rating for a recent specialist invocation |
| `construct improvement` | Governed improvement loop — review, approve, and record apply/rollback for proposals |
| `construct llm-judge` | Run LLM-as-a-judge evaluations on unscored traces for continuous quality feedback |
| `construct optimize` | Prompt optimization using telemetry trace quality scores |
| `construct review` | Agent performance review from telemetry (run\|legacy), or a deterministic PR-diff review for CI (pr) |
| `construct telemetry` | Query telemetry traces and latency data |
| `construct telemetry-backfill` | Backfill sparse traces with observations (trace backend) |
| `construct telemetry-setup` | Configure telemetry backend credentials and trace export (OTLP or Langfuse-compatible) |

## construct efficiency

Show read efficiency, repeated files, and context-budget guidance

**Usage**

```bash
construct efficiency [--json]
```

## construct eval-datasets

Sync scored traces from the telemetry backend into eval datasets for prompt regression testing

**Usage**

```bash
construct eval-datasets
```

## construct evals

Show evaluator catalog for prompt and agent experiments

**Usage**

```bash
construct evals <list|run>
```

## construct feedback:history

Show recorded outcome ratings

**Usage**

```bash
construct feedback:history [--days=N]
```

## construct feedback:record

Record an outcome rating for a recent specialist invocation

**Usage**

```bash
construct feedback:record <id> --score=<0-1> [--note="..."]
```

## construct improvement

Governed improvement loop — review, approve, and record apply/rollback for proposals

**Usage**

```bash
construct improvement submit|review|pending|show|approve|apply|rollback|list
```

## construct llm-judge

Run LLM-as-a-judge evaluations on unscored traces for continuous quality feedback

**Usage**

```bash
construct llm-judge
```

## construct optimize

Prompt optimization using telemetry trace quality scores

**Usage**

```bash
construct optimize <agent>
```

## construct review

Agent performance review from telemetry (run|legacy), or a deterministic PR-diff review for CI (pr)

**Usage**

```bash
construct review [run|legacy|pr --base=<ref> [--output=<file>]]
```

**Subcommands**

- `run` — Generate the per-agent performance review from local session costs + telemetry
- `legacy` — Telemetry pipeline report (requires CONSTRUCT_TELEMETRY_* credentials)
- `pr` — Deterministic diff review vs a base ref — secret/quality heuristics, no model, no credentials (backs the CI review gate, ADR-0069)

## construct telemetry

Query telemetry traces and latency data

**Usage**

```bash
construct telemetry query <latency|top-slow|errors|trace>
```

## construct telemetry-backfill

Backfill sparse traces with observations (trace backend)

**Usage**

```bash
construct telemetry-backfill
```

## construct telemetry-setup

Configure telemetry backend credentials and trace export (OTLP or Langfuse-compatible)

**Usage**

```bash
construct telemetry-setup
```
