---
title: Start embed mode
description: Continuous monitoring + snapshot production while you work.
---

Embed mode is a background daemon that watches what you feed Construct and does what needs doing: polling providers, maintaining docs, updating the roadmap, and routing work through the right approval gates. You configure targets and roles; Construct handles the rest.

Monitoring is poll-based by design — there is no inbound webhook receiver. See the [ADR-0061 amendment](../../decisions/adr/0061-lmcp-p1-embed-capability-schema-runtime-placement.md#amendment-2026-07-09--monitoring-is-poll-based-by-design-webhook-is-a-declared-unimplemented-capability-slot) for why, what the declared `webhook` provider capability is for today, and the criteria that would justify building a real receiver.

## Before you start

You need at least one provider configured in `~/.config/construct/config.env`. Jira and GitHub are the most common starting points.

Check current status:

```sh
construct embed status
```

If the output shows `stopped`, you are ready to start.

## Configure targets and roles (optional but recommended)

Edit `~/.config/construct/embed.yaml` to tell embed which repos and workspaces to maintain:

```yaml
targets:
  - type: repo
    ref: github.com/your-org/your-repo
    path: /path/to/local/clone   # optional — enables direct filesystem writes
  - type: workspace              # fallback always present at ~/.local/state/construct/workspace

roles:
  primary: architect             # sets the analysis lens
  secondary: product-manager     # secondary orientation (optional)
```

Available role names match the specialist agents in the registry (e.g. `architect`, `product-manager`, `engineer`, `sre`, `security`). You can also set roles from the **Config** section in the dashboard.

**Targets** tell embed where to route artifacts. Remote-only targets (no local `path`) receive docs via provider APIs. Local targets get direct filesystem writes.

## Start the daemon

```sh
construct embed start
```

This spawns a detached background process. Logs go to stderr and the process continues after you close the terminal.

The daemon runs ten scheduled jobs:

| Job | What it does | Interval |
|-----|-------------|----------|
| snapshot | Polls all providers, writes `.cx/snapshot.md` | Per config (default: 5 min) |
| provider-health | Logs degraded providers, backs off failing ones | 5 min |
| session-distill | Extracts session summaries into the observation store | 10 min |
| self-repair | Removes stale locks, heals broken state files | 15 min |
| approval-expiry | Expires stale approval queue items | 1 hour |
  | eval-dataset-sync | Syncs scored telemetry traces to Dataset items | 1 hour |
| prompt-regression-check | Detects low-quality score clusters per prompt | 1 hour |
| inbox-watcher | Ingests new files from `inbox/` | 2 min |
| roadmap | Reconciles open items + observations → `docs/roadmap.md` | 1 hour |
| docs-lifecycle | Detects stale/missing docs, auto-fixes low-risk gaps, queues high-risk changes | 30 min |

## How docs are maintained

The `docs-lifecycle` job scans each target's `docs/` directory and classifies gaps:

| Risk | Doc types | Action |
|------|-----------|--------|
| Low | notes, roadmap, status updates, cross-refs | Written autonomously |
| High | ADRs, PRDs, memos, intake | Queued for approval before writing |

Approve or reject queued changes from the **Approvals** tab in the dashboard, or via:

```sh
construct embed approvals
```

## Dashboard notifications

Every job action emits a toast notification in the dashboard started by `construct dev`. Notifications are typed: `info`, `success`, `warning`, `error`.

To also receive embed notifications in Slack, set a webhook URL in `~/.config/construct/config.env`:

```sh
SLACK_EMBED_WEBHOOK_URL=https://hooks.slack.com/services/…
```

## Check that it is running

```sh
construct embed status
```

Expected output includes `running`, the daemon PID, and pending approval count.

## Stop the daemon

```sh
construct embed stop
```

## View the latest snapshot

```sh
cat ~/.cx/snapshot.md
```

Or open the dashboard at `http://localhost:4242` and go to the **Snapshot** tab.

## Change the storage root

By default all data is stored under `~/.cx/`. To use a different location:

```sh
export CX_DATA_DIR=/mnt/construct-data
construct embed start
```

See [Override the storage root](./override-storage-root.md) for details.
