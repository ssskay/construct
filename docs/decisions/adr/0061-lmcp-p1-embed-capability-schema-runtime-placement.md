<!--
cx_doc_id and body_hash are stamped by construct on commit; omitted in this draft.
-->
# ADR-0061: Embed-capability schema + runtime placement — LMCP-P1

- **Date**: 2026-07-03
- **Status**: accepted
- **Deciders**: Gerald Dagher (owner), Construct maintainers (cx-architect)
- **Relates to**: ADR-0054 (workflow manifest schema), ADR-0055 (pack schema/versioning), ADR-0056 (policy/approval/authority), ADR-0060 (provider filter DSL — filter block), ADR-0062 (framework selection — F6, forthcoming)
- **Tracking**: LMCP-P1-DEC. Blocks LMCP-P2 (lifecycle surface), LMCP-F5. Confirms/amends P3–P6.

## Problem

Nothing defines what "an embedded specialist" *is* as configuration. From the current repo:

- `lib/embed/daemon.mjs` — `EmbedDaemon` registers a fixed set of scheduled, fire-and-forget jobs via `Scheduler.register`. There is no per-specialist concept and no enable/disable per specialist.
- `lib/embed/config.mjs` — carries `sources[]` and an `operatingProfile`, but has no `specialists` section.
- `lib/embedded-contract/workflow-invoke.mjs` — `invokeWorkflow()` returns the orchestration plan + output contract and states plainly (line ~171) that *"specialist reasoning is performed by the host agent runtime."* The daemon has **no LLM execution path of its own**.
- `lib/workflows/loader.mjs` (D1) — already loads three-tier `*.manifest.json` (builtin → pack → project, project wins) with validation. It is the natural reuse candidate.

So there is no schema that bundles provider bindings + filters + framework + workflow + write authority per specialist, no per-specialist toggle, and the runtime placement question — *where does embedded reasoning actually execute?* — is undecided.

User direction (2026-07-03): embeddability must be **configurable per specialist** and must **not force a heavyweight runtime dependency** just to turn the capability on.

## Decision

### 1. Embed-capability manifest — a workflow-manifest specialization (`type: "embed"`)

Reuse the D1 loader and its three-tier merge. An embed capability is a workflow manifest with `type: "embed"` and an `embed` block:

```jsonc
{
  "id": "operations",
  "type": "embed",
  "version": "1.0.0",
  "embed": {
    "specialist": "cx-operations",         // persona resolved via pack registry (E1)
    "providerBindings": ["github", "jira"], // provider ids (E4) this capability may read
    "filter": { /* ADR-0060 provider filter block */ },
    "framework": "cx-ops-triage",           // reasoning framework (ADR-0062 / F6)
    "outputContract": "proposal.v1",        // shape the reasoning must emit
    "proposalAuthority": "propose-only",    // ADR-0056 authority: propose-only | governed-write
    "cadence": { "every": "PT15M" },        // schedule; null = event-driven only
    "runtime": "auto"                       // auto | in-process | external | none — see §3
  }
}
```

The `embed` block references, rather than redefines: `specialist` resolves through the pack registry (E1); `filter` is the ADR-0060 block; `framework` is F6/ADR-0062; `proposalAuthority` is ADR-0056. This keeps one source of truth per concern and makes an embed capability a *composition* of already-decided contracts.

### 2. Config home — pack defaults, `.cx` overrides

- **Defaults** ship in the pack (E1): a specialist pack declares which embed capabilities it provides and their default `embed` block. Turning on a pack makes its embed capabilities *available*, not *active*.
- **Per-project enable/override** lives in `.cx` (git-tracked). `.cx/embed/<id>.manifest.json` (project tier of the D1 loader) enables a capability and overrides any field — cadence, filter, runtime. This mirrors ADR-0060's rule that per-engagement values live in reviewable project config.

`enabled` is explicit and per-specialist: nothing embedded runs until the project opts in.

### 3. Runtime placement — tiered, zero-extra-dependency default, honest skip when absent

The daemon has no LLM path today, and the user requires that enabling embeddability not drag in a heavyweight runtime. Resolution — a `runtime` selector with four values:

| `runtime` | Where reasoning executes | Dependency |
|-----------|--------------------------|------------|
| `in-process` | The daemon calls a provider model directly via the **existing model-resolution path** (the same path the rest of Construct already uses). | None beyond a configured model provider. **This is the zero-extra-dependency default.** |
| `external` | An external persistent agent runtime (an OpenClaw-class gateway/host) executes the reasoning; Construct supplies the plan + context + contracts via the `workflow-invoke` contract. | The external host must be configured and reachable. |
| `auto` | Resolve to `in-process` if a model provider is configured; else `external` if an external host is configured; else `none`. | Best-available. |
| `none` | No runtime. The capability is **visibly skipped with a reason**, never faked. | — |

**Default is `auto`, which resolves to `in-process`** whenever a model provider exists — so `construct embed enable operations` works with no new dependency. The OpenClaw-class external host is an *optional configured runtime*, not a precondition.

**No-runtime behavior is an honest skip, not fake output.** When `runtime` resolves to `none` (no model provider and no external host), the scheduled tick records a `skipped` result carrying `reason: "no-runtime"` and the capability's status surfaces `skipped-with-reason`. This preserves the `workflow-invoke.mjs` invariant that Construct never claims specialist output it did not actually obtain (no-fabrication rule).

The daemon gains exactly one new capability: an `in-process` execution path that calls the existing model-resolution path. `external` reuses the existing `workflow-invoke` contract. Neither adds a mandatory dependency.

### 4. Lifecycle surface (P2 implements)

```
construct embed list                 # available capabilities, per-project enabled state, resolved runtime
construct embed enable  <id>         # write .cx/embed/<id>.manifest.json (enabled), validate against schema
construct embed disable <id>         # mark disabled; the scheduled job stops registering
construct embed status  [<id>]       # last tick: ran | skipped-with-reason(no-runtime) | error; last proposal
construct embed dry-run <id>         # resolve bindings+filter+framework+runtime, emit the plan, execute nothing
```

`enable`/`disable` write the project-tier manifest; the daemon reads enabled capabilities at startup and on config reload, registering one scheduled job per enabled capability (replacing today's fixed job set for the embed-specialist concern). `status` reads the durable last-tick record. `dry-run` proves the full resolution chain without calling a model — the inspection surface the user asked for ("users know exactly what runtime the reasoning needs and what happens when it is absent").

## Alternatives considered

- **A standalone `specialists[]` section in `embed/config.mjs`** instead of a workflow-manifest specialization. Rejected: it would fork a second manifest system parallel to D1, duplicating tiering, validation, and precedence. `type: "embed"` reuses D1 wholesale.
- **Mandatory external agent runtime** (OpenClaw-class host as the only execution path). Rejected: violates the explicit user constraint that enabling embeddability must not force a heavyweight dependency. External is *optional*, selected by `runtime`.
- **Silent no-op when no runtime is present.** Rejected outright: it would fake or vanish specialist work, breaking the `workflow-invoke.mjs` no-fabrication invariant. The `none` runtime surfaces `skipped-with-reason` instead.
- **In-process only** (drop the external option). Rejected: forecloses the persistent-agent-host deployment shape for teams that want reasoning off the daemon process. `runtime: external` keeps that door open at zero cost to the default.

## Consequences

- An embed capability is inspectable, per-specialist configuration composed from already-decided contracts (E1 packs, E4 bindings, ADR-0060 filters, ADR-0062 framework, ADR-0056 authority).
- `construct embed enable operations` is meaningful and works with **no new dependency** (`auto` → `in-process` via the existing model-resolution path).
- When no runtime is available, the user sees a visible `skipped-with-reason(no-runtime)`, never fabricated output.
- The daemon gains one execution path (`in-process` model call); `external` reuses `workflow-invoke`.
- LMCP-P2 (lifecycle surface: list/enable/disable/status/dry-run) and LMCP-F5 are unblocked. P3–P6 proceed on the `type: "embed"` manifest + `runtime` selector defined here.

## Amendment (2026-07-09) — monitoring is poll-based by design; `webhook` is a declared, unimplemented capability slot

construct-jvjow.5 asked for the poll-vs-push stance to be made explicit. It was implicit and, in one place, contradicted by the docs. This amendment records the decision and corrects that contradiction.

### What exists today (verified by reading the code, not inferred)

- **All monitoring is poll-based.** `lib/embed/daemon.mjs` (`EmbedDaemon`) registers every job — `snapshot`, `roadmap`, `docs-lifecycle`, and the rest — as scheduled, interval-driven work via `lib/embed/scheduler.mjs`'s `Scheduler.register`. `lib/embed/inbox-live-watcher.mjs` is the closest thing to "push": it uses `fs.watch` for near-real-time local file events, but even that falls back to a 2-minute poll (`lib/embed/daemon.mjs:1289`, `onPoll` at `:1277`) because `fs.watch` is unreliable across platforms. There is no code path anywhere in `lib/` or `bin/` that opens an HTTP listener and routes inbound requests into a provider's capability. Confirmed by grepping for `createServer`/`listen(` across the tree: the only HTTP servers in the repo are `lib/mcp/transport/http.mjs` (MCP tool-call transport) and `lib/bridges/copilot-proxy.mjs` (Copilot proxy) — neither is wired to any provider or to embed monitoring.
- **`webhook` is a declared provider capability with no receiver.** `lib/providers/contract/interface.mjs:9`, `lib/providers/contract.mjs:310-324`, and `lib/providers/registry.mjs:78` all list `webhook` alongside `read`/`search`/`write`/`watch` as one of the five capabilities a provider's `meta.capabilities` array may declare, and the breaker infrastructure tracks it like any other method. Two adapters implement the *method* — `lib/providers/github/index.mjs:133-153` (`webhook(config, request)`, HMAC-SHA256 signature verification against `x-hub-signature-256`) and `lib/providers/contract/adapters/jira/index.mjs:155` (`webhook(event)`, dispatches on `event.webhookEvent`) — and `lib/providers/scaffold.mjs:40-44` generates a stub (`return { ok: false, error: 'not implemented' }`) for new providers that request it. But grepping every call site of `.webhook(` in non-test code (`grep -rn "\.webhook(" --include="*.mjs" .`) returns zero matches — the only callers are `tests/provider-github.test.mjs` and `tests/provider-jira.test.mjs`, invoking the method directly with a hand-built `request` object. Nothing in the daemon, scheduler, or CLI ever receives an inbound HTTP request and hands it to `provider.webhook()`. The capability is real code that verifies signatures correctly in isolation; it is simply never reached by any request, because no listener exists to produce one.
- **Outbound Slack is the only "push" in the system, and it is notification, not monitoring.** `lib/embed/notifications.mjs:46-74` (`notifySlack`) is a one-way `fetch(webhookUrl, { method: 'POST', ... })` to a Slack *incoming*-webhook URL (`SLACK_EMBED_WEBHOOK_URL` / `SLACK_WEBHOOK_URL`), fired from the in-process `EventEmitter` bus (`emitEmbedNotification`) after a poll cycle already produced a result. It sends toasts about what polling found; it does not receive anything, and it plays no role in how Construct learns about provider state.
- **Docs correction needed.** `docs/guides/cookbook/configure-slack.md` (Step 3, "Enable slash commands") documents `https://your-construct-host/webhooks/slack` as a live inbound endpoint for Slack slash commands, and references `SLACK_SIGNING_SECRET` for verifying it. Grepping the entire codebase for `SLACK_SIGNING_SECRET` and `/webhooks/slack` outside that one doc file returns nothing — this endpoint does not exist in code. That doc is corrected alongside this amendment (see below) so it does not contradict the decision recorded here.

### Decision

1. **Monitoring in this system is poll-based by design, not push/webhook-driven.** Every embed job runs on a schedule (`cadence` in the embed manifest, §1 above) and reads current state from providers on each tick. This is a deliberate consequence of §3's runtime model: a poll cycle is a bounded, inspectable unit of work (`dry-run`, `status`) that fits the daemon's fire-and-forget scheduler and the no-fabrication/honest-skip invariant this ADR already established — an inbound webhook receiver would need its own delivery-guarantee, retry, and dedup story that the current daemon does not have and was not asked to build.
2. **The `webhook` capability slot exists to let a provider *declare* that it understands inbound event shapes (and, per-adapter, verify their signatures) for a future receiver — it is not a working receiver today.** Declaring `webhook` in `meta.capabilities` and implementing the method (as `github` and `jira` do) documents the provider's inbound contract and keeps the signature-verification logic ready and tested in isolation. It does not cause any inbound traffic to be accepted, routed, or acted on, because no HTTP listener calls it. Provider authors should treat `webhook` as a capability declaration for a future integration point, not as an active feature to advertise to users.
3. **Criteria that would justify building a real inbound receiver.** Add one only when a concrete case crosses one of these lines, not preemptively:
   - **Latency**: a use case needs sub-poll-interval reaction (the fastest current cadence is `PT15M` per §1's example, tightened at most to a few minutes for `snapshot`/inbox watching) — e.g. incident response that must react to a GitHub PR check-failure within seconds, not minutes.
   - **Provider rate-limit pressure**: polling a provider (GitHub, Jira) at the cadence a use case needs starts tripping rate limits or costs meaningfully more than the provider's webhook delivery would.
   - **Provider-only events**: an event class exists only as a webhook payload with no equivalent poll/list endpoint, so polling literally cannot observe it.
   - **A named, funded use case**, not speculative readiness: building the receiver (HTTP listener, per-provider signature verification wiring already half-done in `github`/`jira`, request routing into the daemon, delivery/retry/dedup handling) is nontrivial infrastructure and should be scoped as its own ADR when one of the above triggers, not spun up "for completeness."

### Consequences

- No inbound HTTP surface is added to the daemon by this amendment; the `webhook` capability declaration and its two adapter implementations remain as-is (tested, correct in isolation, unreachable in production).
- `docs/guides/cookbook/configure-slack.md`'s slash-command section is corrected to stop implying a live endpoint exists, and now points at this amendment.
- Future work that wants inbound webhooks must clear the criteria in Decision §3 and land as its own ADR before building the receiver — this amendment is the reference point for that future decision, not a green light to build it now.
