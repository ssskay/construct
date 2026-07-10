/**
 * lib/orchestration/build-audit-record.mjs — unified build-audit record
 * (construct-ifwhw.1).
 *
 * Before this module, a run's task chain (lib/orchestration/run-store.mjs),
 * its lifecycle traces (lib/worker/trace.mjs), and any contract/postcondition
 * violations its tasks triggered (lib/contracts/violation-log.mjs) were three
 * parallel, unlinked durable records — a reader had to already know a runId
 * to find the run, then separately guess which trace shard and which
 * violation-log window to search. `buildAuditRecord` joins the three by the
 * `runId` tag that lib/orchestration/worker.mjs now threads through trace
 * events and violation-log entries, and persists the join so it survives
 * even if the trace shard backing it later rotates out.
 *
 * Task-level artifact linkage (a task's outputPacket referencing an authored
 * docs/ file) and its postcondition verdict are included only when a task
 * actually carries an `outputPacket.artifactPath` — no orchestration task
 * populates that field yet, so today's records honestly report an empty
 * `artifacts` array per task rather than fabricate a link. This is the
 * insertion point for a future producer that authors a doc: set
 * `task.outputPacket.artifactPath` and this module picks it up.
 *
 * Storage: `<stateRoot>/runtime/orchestration/audit-records/<runId>.json`
 * (same atomic temp-then-rename write as run-store.mjs, sibling directory to
 * `runs/`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { loadRun, runtimeDir } from './run-store.mjs';
import { readTraceEventsForRun } from '../worker/trace.mjs';
import { recentViolations } from '../contracts/violation-log.mjs';
import { validateArtifactPostconditions, findContract } from '../contracts/validate.mjs';
import { resolveOutputContractId } from './worker.mjs';

let writeCounter = 0;

function recordsDir(cwd) {
  return join(runtimeDir(cwd), 'audit-records');
}

function atomicWriteJson(filePath, value) {
  writeCounter = (writeCounter + 1) % 100000;
  const tmp = `${filePath}.${process.pid}.${writeCounter}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, filePath);
}

function taskArtifactVerdict(task, { cwd }) {
  const artifactPath = task?.outputPacket?.artifactPath;
  if (!artifactPath) return null;
  const contractId = resolveOutputContractId(task);
  const contract = contractId ? findContract({ id: contractId }) : null;
  if (!contract) return { artifactPath, checked: false, reason: 'no output contract resolved for role' };
  const errors = validateArtifactPostconditions({ contract, artifactPath, cwd });
  return { artifactPath, checked: true, ok: errors.length === 0, errors };
}

/**
 * Assemble the durable per-run record: task chain, lifecycle trace events,
 * gate (contract) verdicts, and per-task artifact postcondition verdicts
 * where a task actually names an artifact. Returns null when the runId
 * resolves to no run — a missing run is not itself an audit finding.
 */
export function buildAuditRecord(cwd, runId) {
  const run = loadRun(cwd, runId);
  if (!run) return null;

  const taskChain = (run.tasks || []).map((task) => ({
    id: task.id,
    role: task.role,
    status: task.status,
    executor: task.executor ?? null,
    error: task.error ?? null,
  }));

  const traceEvents = readTraceEventsForRun(cwd, runId).map((event) => ({
    eventType: event.eventType,
    role: event.role,
    taskId: event.taskId,
    createdAt: event.createdAt,
  }));

  const gateVerdicts = recentViolations({ repoRoot: cwd, windowMs: Infinity, runId }).map((v) => ({
    ts: v.ts,
    contractId: v.contractId,
    direction: v.direction,
    verdict: v.verdict,
    missing: v.missing,
    postconditionFailures: v.postconditionFailures ?? [],
  }));

  const artifactVerdicts = (run.tasks || [])
    .map((task) => ({ taskId: task.id, verdict: taskArtifactVerdict(task, { cwd }) }))
    .filter((entry) => entry.verdict !== null);

  return {
    runId,
    status: run.status,
    createdAt: run.createdAt ?? null,
    taskChain,
    traceEvents,
    gateVerdicts,
    artifactVerdicts,
    assembledAt: new Date().toISOString(),
  };
}

export function saveAuditRecord(cwd, record) {
  const dir = recordsDir(cwd);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(join(dir, `${record.runId}.json`), record);
  return record;
}

export function loadAuditRecord(cwd, runId) {
  const file = join(recordsDir(cwd), `${runId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build and persist in one call — the common path for a caller that just
 * wants the durable record to exist and be readable back cross-process.
 */
export function materializeAuditRecord(cwd, runId) {
  const record = buildAuditRecord(cwd, runId);
  if (!record) return null;
  return saveAuditRecord(cwd, record);
}
