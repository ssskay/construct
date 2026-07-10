/**
 * lib/worker/trace.mjs — append-only trace event log for worker + intake flow.
 *
 * Trace events tie an intake packet → task graph → role dispatch → worker
 * job → evidence record together via traceId + spanId. Events land in two
 * places concurrently:
 *
 *   1. `<stateRoot>/traces/<YYYY-MM-DD>.jsonl` (ADR-0066: machine-scoped, not
 *      project-local) — append-only local JSONL. Always on, no credentials
 *      required. Tail live, archive, or replay.
 *   2. Optional remote export — selected by CONSTRUCT_TRACE_BACKEND. Each
 *      unique traceId triggers one trace-create plus an event-create per
 *      emitted event. Failures never throw because observability must not
 *      break the caller.
 *
 * Event types in current use:
 *   intake.received        — daemon ingested a file
 *   intake.triaged         — classifyRdIntake produced a triage block
 *   task_graph.created     — graph derived from triage
 *   role.dispatched        — context router selected a persona
 *   tool.called            — agent invoked a tool
 *   worker.started         — worker began executing a command
 *   worker.completed       — worker finished (status: passed | failed | timeout)
 *   evidence.recorded      — evidence appended to a task graph node
 *   approval.requested     — high-risk action blocked on approval
 *   approval.resolved      — approval granted or denied
 *   memory.written         — durable memory record persisted
 *
 * `readTraceEventsForRun` (construct-ifwhw.1) reads back events tagged with
 * an orchestration `metadata.runId` — the trace side of the unified
 * build-audit record in lib/orchestration/build-audit-record.mjs.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createTelemetryClient } from '../telemetry/client.mjs';
import { appendWithRotationSync } from '../logging/rotate.mjs';
import { ensureDiskWrite, warnBudgetOnce } from '../resources/budget.mjs';
import { resolveStateDir } from '../state-root.mjs';

// GitHub rejects single files > 100 MB. Keep every trace shard strictly
// under 100 MB so an accidental commit + push doesn't brick the repo. Cap
// is configurable via CONSTRUCT_TRACE_MAX_MB; default 100. Override of 0
// disables rotation entirely (not recommended).

function traceMaxBytes(env = process.env) {
  const raw = env.CONSTRUCT_TRACE_MAX_MB;
  if (raw === undefined) return 100 * 1024 * 1024;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed * 1024 * 1024);
}

export const TRACE_EVENT_TYPES = [
  'daemon.started',
  'daemon.heartbeat',
  'daemon.stopped',
  'lifecycle.completed',
  'intake.received',
  'intake.triaged',
  'task_graph.created',
  'role.dispatched',
  'tool.called',
  'worker.started',
  'worker.completed',
  'evidence.recorded',
  'approval.requested',
  'approval.resolved',
  'memory.written',
];

export function traceDir(rootDir) {
  return resolveStateDir(rootDir, 'traces');
}

function todayShard() {
  return new Date().toISOString().slice(0, 10);
}

export function newTraceId() {
  return `trace-${randomBytes(8).toString('hex')}`;
}

export function newSpanId() {
  return `span-${randomBytes(6).toString('hex')}`;
}

// Reused per-process. The adapter batches remote export; recreating it would
// lose the queue. Local JSONL is already written by emitTraceEvent, so this
// client disables its own local writer.
let telemetryClient = null;
const seenTraces = new Set();

function getTelemetryClient(env = process.env, rootDir) {
  if (telemetryClient !== null) return telemetryClient;
  telemetryClient = createTelemetryClient({
    env,
    rootDir,
    localWrites: false,
  });
  return telemetryClient;
}

/**
 * Internal: reset the cached telemetry client. Test-only.
 */
export function _resetTelemetryClient() {
  telemetryClient = null;
  seenTraces.clear();
}


function exportToRemote(event, env, rootDir) {
  const client = getTelemetryClient(env, rootDir);
  if (!client.remoteAvailable) return;

  // First time we see a traceId, register the trace so subsequent events
  // attach to a known parent.
  if (event.traceId && !seenTraces.has(event.traceId)) {
    seenTraces.add(event.traceId);
    try {
      client.trace({
        id: event.traceId,
        name: event.eventType,
        metadata: {
          project: event.project || undefined,
          role: event.role || undefined,
          taskId: event.taskId || undefined,
          intakeId: event.intakeId || undefined,
        },
        timestamp: event.createdAt,
      });
    } catch { /* observability must not break the caller */ }
  }

  try {
    client.event({
      id: event.spanId,
      traceId: event.traceId,
      parentObservationId: event.parentSpanId || undefined,
      name: event.eventType,
      metadata: event.metadata,
      input: undefined,
      output: undefined,
      startTime: event.createdAt,
    });
  } catch { /* swallow */ }
}

export function emitTraceEvent({
  rootDir,
  eventType,
  traceId,
  spanId,
  parentSpanId = null,
  project = null,
  role = null,
  taskId = null,
  intakeId = null,
  metadata = {},
  env = process.env,
}) {
  if (!rootDir) throw new Error('emitTraceEvent: rootDir is required');
  if (!eventType) throw new Error('emitTraceEvent: eventType is required');
  if (!TRACE_EVENT_TYPES.includes(eventType)) {
    throw new Error(`emitTraceEvent: unknown eventType ${eventType}`);
  }

  const dir = traceDir(rootDir);

  const event = {
    traceId: traceId || newTraceId(),
    spanId: spanId || newSpanId(),
    parentSpanId,
    eventType,
    project,
    role,
    taskId,
    intakeId,
    metadata,
    createdAt: new Date().toISOString(),
  };
  const shardPath = path.join(dir, `${todayShard()}.jsonl`);
  const line = `${JSON.stringify(event)}\n`;
  const gate = ensureDiskWrite(rootDir, 'traces', Buffer.byteLength(line), env);
  if (gate.ok) {
    appendWithRotationSync(shardPath, line, {
      maxBytes: traceMaxBytes(env),
    });
  } else {
    warnBudgetOnce(gate.message || 'trace write blocked by .cx/ disk budget', env);
    return { ...event, budgetSkipped: true, budgetReason: gate.reason || 'budget-exceeded' };
  }

  // Fire-and-forget export to the configured remote adapter. Silent no-op when not configured.
  exportToRemote(event, env, rootDir);
  return event;
}

// Trace shards rotate daily and there is no runId->shard index, so a lookup
// walks every shard under traceDir rather than assuming "today". Malformed
// lines are skipped rather than thrown (a corrupt shard must not break a
// read of everything else) — matching lib/orchestration/run-store.mjs's
// tolerate-corrupt-file convention.

export function readTraceEventsForRun(rootDir, runId) {
  const dir = traceDir(rootDir);
  if (!runId || !existsSync(dir)) return [];
  const shards = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const events = [];
  for (const shard of shards) {
    let lines;
    try {
      lines = readFileSync(path.join(dir, shard), 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.metadata?.runId === runId) events.push(event);
    }
  }
  return events.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
