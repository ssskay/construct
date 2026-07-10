/**
 * tests/functional/prd-request-full-chain-audit-trail.functional.test.mjs —
 * composed sterile test (construct-ifwhw.3): "write me a PRD" through the full
 * specialist chain, deterministic, to a durable PRD file whose paper trail
 * links the run record, the task chain, and a gate/postcondition verdict.
 *
 * A "write me a PRD" request routes through the REAL specialist chain:
 * lib/orchestration-policy.mjs's `routeRequest` decomposes it into a sequenced
 * specialist chain and resolves the contract chain that governs it (verified
 * live against the registry — a request containing "PRD" resolves
 * `researcher-to-product-manager`, the real contract this suite exercises,
 * into `run.plan.contractChain`), then `lib/orchestration/runtime.mjs`'s
 * `runOrchestration` executes it. This suite drives that path with the
 * `provider` worker backend and an injected deterministic `fetchImpl` — the
 * same no-network executor-injection pattern already proven in
 * tests/orchestration-runtime.test.mjs ("provider backend executes tasks via
 * the model and records real output", asserting `run.tasks.every(t =>
 * /^specialist-output-/.test(t.output))`) and reused live by
 * lib/certification/real-llm-scenarios.mjs's opt-in S3 scenario for the same
 * "write me a PRD" shape — no live LLM call, no API key, deterministic output.
 *
 * The real specialist output text is then handed to the real MCP
 * `author_artifact` entrypoint (lib/mcp/tools/artifact-author.mjs, exercised
 * the same way tests/functional/artifact-loop-provenance.functional.test.mjs
 * exercises it for construct-ifwhw.2), which writes the durable PRD file AND
 * a durable provenance observation — the embedded-contract leg of the paper
 * trail, since `invokeWorkflow` (lib/embedded-contract/workflow-invoke.mjs)
 * never threads an orchestration `runId` through by itself.
 *
 * The orchestration leg of the paper trail is then composed on top: the
 * researcher task (real producer of `researcher-to-product-manager`, per the
 * run's own resolved contractChain) is given an output packet naming the
 * just-authored PRD's artifactPath — the exact insertion point
 * lib/orchestration/build-audit-record.mjs's header documents ("set
 * task.outputPacket.artifactPath and this module picks it up") — deliberately
 * incomplete (as tests/functional/build-audit-record.functional.test.mjs's own
 * fixture is) so `validateOutputPacket` logs a real CONTRACT_VIOLATION tagged
 * with this run's runId. `materializeAuditRecord`/`loadAuditRecord`
 * (construct-ifwhw.1) then join run + task chain + trace + that gate verdict +
 * the artifact postcondition verdict against the real authored file into one
 * durable, cross-process-readable record.
 *
 * No overlap found with construct-rf26.22 (refit verification suite): that
 * bead's required shape (flow checkpoint/resume, config-layer init tree,
 * custom-specialist authoring, binary smoke, full-gate run) is a distinct set
 * of functional-test additions with no PRD/paper-trail scenario.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runOrchestration } from '../../lib/orchestration/runtime.mjs';
import { loadRun, saveRun } from '../../lib/orchestration/run-store.mjs';
import { validateOutputPacket } from '../../lib/orchestration/worker.mjs';
import { buildAuditRecord, materializeAuditRecord, loadAuditRecord } from '../../lib/orchestration/build-audit-record.mjs';
import { authorArtifact } from '../../lib/mcp/tools/artifact-author.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const MODEL = 'anthropic/claude-sonnet-4-6';
const REQUEST_TEXT = 'Write me a PRD for a customer loyalty rewards program';

const dirs = [];
function freshProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-prd-chain-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-prd-chain-home-'));
  dirs.push(cwd, home);
  return { cwd, home };
}
test.after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

test('write-me-a-PRD drives the full specialist chain to a durable PRD file with a linked run/task/gate paper trail', async (t) => {
  const { cwd, home } = freshProject();

  const prevHomeOverride = process.env.CX_HOME_OVERRIDE;
  const prevEmbedModel = process.env.CONSTRUCT_EMBEDDING_MODEL;
  process.env.CX_HOME_OVERRIDE = home;
  process.env.CONSTRUCT_EMBEDDING_MODEL = 'hashing';
  t.after(() => {
    if (prevHomeOverride === undefined) delete process.env.CX_HOME_OVERRIDE;
    else process.env.CX_HOME_OVERRIDE = prevHomeOverride;
    if (prevEmbedModel === undefined) delete process.env.CONSTRUCT_EMBEDDING_MODEL;
    else process.env.CONSTRUCT_EMBEDDING_MODEL = prevEmbedModel;
  });

  // Deterministic, no-network provider executor: one fixed Anthropic-shaped
  // response body per call, distinguishable by an incrementing counter. The
  // same shape satisfies both the plain callAnthropic path and the
  // provider-native web-search loop a web-capable role (cx-researcher) takes
  // (lib/orchestration/worker.mjs's runNativeAnthropic reads the same
  // `content: [{type:'text', ...}]` blocks and stops immediately absent a
  // `pause_turn` stop_reason) — this mirrors the injection pattern in
  // tests/orchestration-runtime.test.mjs's "provider backend executes tasks
  // via the model and records real output".
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: `specialist-output-${calls}: findings and PRD-shaping input for the loyalty rewards request.` }],
      }),
    };
  };

  const env = {
    CX_MODEL_REASONING: MODEL,
    CX_MODEL_STANDARD: MODEL,
    CX_MODEL_FAST: MODEL,
    ANTHROPIC_API_KEY: 'sk-test-prd-chain',
  };

  const run = await runOrchestration(
    { request: REQUEST_TEXT, requestedStrategy: 'orchestrated', workflowType: 'prd-draft', hostModel: MODEL, fileCount: 2, moduleCount: 1 },
    { env, cwd, workerBackend: 'provider', fetchImpl },
  );

  assert.equal(run.status, 'completed', 'the full specialist chain executes deterministically with no network call');
  assert.ok(run.tasks.length >= 2, 'a PRD request decomposes into a multi-specialist chain');
  assert.ok(run.tasks.every((t) => t.status === 'done'), 'every specialist task in the chain completed');
  assert.ok(run.tasks.every((t) => /^provider:anthropic:/.test(t.executor)), 'every task executed via the injected deterministic provider, not a live call');
  assert.ok(run.tasks.every((t) => /^specialist-output-/.test(t.output)), 'every task carries real (deterministic) specialist output, not a prepared stub');

  const researcherTask = run.tasks.find((t) => t.role === 'cx-researcher');
  assert.ok(researcherTask, 'the PRD chain includes the researcher role that owns researcher-to-product-manager');
  const contractChainEntry = run.plan.contractChain.find((c) => c.id === 'researcher-to-product-manager');
  assert.ok(contractChainEntry, 'routeRequest resolved the researcher-to-product-manager contract into this real PRD run, not an arbitrary choice');

  const productManagerTask = run.tasks.find((t) => t.role === 'cx-product-manager');
  assert.ok(productManagerTask, 'the PRD chain includes the product-manager role');

  // Draft content grounded in the run's own real (deterministic) specialist
  // output — not invented product claims — the same grounding discipline
  // real-llm-scenarios.mjs's live S3 scenario applies to real model output.
  const draftMarkdown = [
    '# Customer loyalty rewards program PRD',
    '',
    `Drafted from specialist chain output for run ${run.runId}.`,
    '',
    '## Problem',
    '',
    researcherTask.output,
    '',
    productManagerTask.output,
    '',
  ].join('\n');

  const authored = await authorArtifact({
    artifact_type: 'prd',
    subject: 'customer loyalty rewards program',
    draft_markdown: draftMarkdown,
    cwd,
  }, { ROOT_DIR: REPO });

  assert.equal(authored.written, true, 'a supplied draft materializes the durable PRD file');
  const artifactAbsPath = path.join(cwd, authored.path);
  assert.equal(fs.existsSync(artifactAbsPath), true, 'the PRD file exists on disk');
  assert.ok(authored.provenance?.ok, `author_artifact provenance write failed: ${authored.provenance?.error}`);

  const observationsDir = path.join(cwd, '.cx', 'observations');
  const observations = fs.readdirSync(observationsDir)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => JSON.parse(fs.readFileSync(path.join(observationsDir, name), 'utf8')))
    .filter((o) => o.tags?.includes('artifact-loop'));
  assert.equal(observations.length, 1, 'author_artifact wrote exactly one durable provenance observation (construct-ifwhw.2)');
  assert.equal(observations[0].extras.workflowType, 'prd-draft');
  assert.equal(observations[0].extras.relPath, authored.path, 'the provenance record links to the same durable PRD path just verified on disk');

  // build-audit-record.mjs's documented insertion point: no orchestration task
  // populates outputPacket.artifactPath on its own, so the real authored path
  // is attached here — deliberately incomplete on the other required
  // researcher-to-product-manager fields (mirrors
  // tests/functional/build-audit-record.functional.test.mjs's own fixture) so
  // validateOutputPacket logs a real, runId-tagged gate verdict.
  const reloadedRun = loadRun(cwd, run.runId);
  const reloadedResearcherTask = reloadedRun.tasks.find((t) => t.role === 'cx-researcher');
  reloadedResearcherTask.outputContractId = 'researcher-to-product-manager';
  reloadedResearcherTask.outputPacket = {
    problem: researcherTask.output,
    artifactPath: artifactAbsPath,
  };
  saveRun(cwd, reloadedRun);

  const outputCheck = validateOutputPacket(reloadedResearcherTask, { cwd, runId: run.runId });
  assert.equal(outputCheck.contractStatus, 'contract-failed', 'the deliberately incomplete packet fails researcher-to-product-manager');
  assert.ok(outputCheck.violations.includes('users'), 'the missing required field is reported, not silently dropped');

  const record = buildAuditRecord(cwd, run.runId);
  assert.ok(record, 'buildAuditRecord resolves a record for this real run');
  assert.equal(record.runId, run.runId);
  assert.equal(record.taskChain.length, run.tasks.length, 'the paper trail links the full task chain, not a subset');
  assert.ok(record.taskChain.some((t) => t.role === 'cx-researcher' && t.status === 'done'));
  assert.ok(record.taskChain.some((t) => t.role === 'cx-product-manager' && t.status === 'done'));
  assert.ok(
    record.traceEvents.some((e) => e.eventType === 'worker.completed' && e.role === 'cx-product-manager'),
    'the paper trail links real lifecycle trace events emitted during execution',
  );
  assert.ok(record.gateVerdicts.length >= 1, 'the paper trail links a real gate verdict tied to this run');
  const gateVerdict = record.gateVerdicts.find((v) => v.contractId === 'researcher-to-product-manager');
  assert.ok(gateVerdict, 'the gate verdict is the researcher-to-product-manager contract this PRD run actually resolved');
  assert.equal(gateVerdict.verdict, 'CONTRACT_VIOLATION');

  const artifactVerdictEntry = record.artifactVerdicts.find((v) => v.taskId === reloadedResearcherTask.id);
  assert.ok(artifactVerdictEntry, 'the paper trail links a postcondition verdict for the authored PRD file');
  assert.equal(artifactVerdictEntry.verdict.artifactPath, artifactAbsPath, 'the postcondition verdict points at the same durable PRD file written to disk');
  assert.equal(artifactVerdictEntry.verdict.checked, true, 'researcher-to-product-manager resolved a real contract to check postconditions against');

  const materialized = materializeAuditRecord(cwd, run.runId);
  assert.equal(materialized.runId, run.runId);

  const readBack = loadAuditRecord(cwd, run.runId);
  assert.deepEqual(readBack.taskChain, materialized.taskChain, 'a fresh cross-process read of the persisted audit record matches what was written');
  assert.deepEqual(readBack.gateVerdicts, materialized.gateVerdicts);
  assert.deepEqual(readBack.artifactVerdicts, materialized.artifactVerdicts);
});
