/**
 * tests/functional/artifact-loop-provenance.functional.test.mjs —
 * author_artifact durable provenance (construct-ifwhw.2).
 *
 * Before this bead, `runConstructArtifactLoop` (lib/artifact-loop-core.mjs)
 * invoked its workflow plan with `approvalMode: 'proposal-only'`, so the
 * embedded-contract layer never wrote its own durable record; the authored
 * artifact file — when one got written at all — was the only trace an
 * `author_artifact` call had happened. This suite drives the real MCP
 * `author_artifact` entrypoint (lib/mcp/tools/artifact-author.mjs) against a
 * fresh mkdtemp project and asserts, by reading `.cx/observations/*.json`
 * back off disk, that a provenance record now exists in both branches:
 *
 *   - no draft content to materialize (artifact FILE not written)
 *   - a full draft supplied (artifact FILE written)
 *
 * and that the artifact-file-writing behavior itself is unchanged: the first
 * case still writes zero bytes to the artifact path.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { authorArtifact } from '../../lib/mcp/tools/artifact-author.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const dirs = [];
test.after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-artifact-provenance-'));
  dirs.push(cwd);
  return cwd;
}

// The vector-index leg of addObservation is best exercised deterministically
// via the hashing embedder (tests/functional/loop-closure.functional.test.mjs
// sets the same env for the same reason); the durable JSON record this suite
// asserts on is written before that leg runs either way.

function withHashingEmbeddings(t, cwd) {
  const prevModel = process.env.CONSTRUCT_EMBEDDING_MODEL;
  process.env.CONSTRUCT_EMBEDDING_MODEL = 'hashing';
  const prevHome = process.env.CX_HOME_OVERRIDE;
  process.env.CX_HOME_OVERRIDE = cwd;
  t.after(() => {
    if (prevModel === undefined) delete process.env.CONSTRUCT_EMBEDDING_MODEL;
    else process.env.CONSTRUCT_EMBEDDING_MODEL = prevModel;
    if (prevHome === undefined) delete process.env.CX_HOME_OVERRIDE;
    else process.env.CX_HOME_OVERRIDE = prevHome;
  });
}

function readObservations(cwd) {
  const dir = path.join(cwd, '.cx', 'observations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

test('proposal-only: no draft to materialize writes zero artifact-side effects but a provenance record exists', async (t) => {
  const cwd = project();
  withHashingEmbeddings(t, cwd);

  const res = await authorArtifact({
    artifact_type: 'prd',
    subject: 'provenance no-draft case',
    cwd,
  }, { ROOT_DIR: REPO });

  assert.equal(res.written, false, 'no draft content means the artifact file is not materialized');
  assert.equal(fs.existsSync(path.join(cwd, res.path)), false, 'artifact file does not exist on disk');

  assert.ok(res.provenance, 'author_artifact result carries a provenance summary');
  assert.equal(res.provenance.ok, true, `provenance write failed: ${res.provenance.error}`);
  assert.ok(res.provenance.id, 'provenance write returns an observation id');

  const observations = readObservations(cwd).filter((o) => o.tags?.includes('artifact-loop'));
  assert.equal(observations.length, 1, 'exactly one provenance observation was written to disk');

  const [obs] = observations;
  assert.ok(obs.extras.traceId, 'provenance record carries a traceId');
  assert.equal(obs.extras.artifactType, 'prd');
  assert.equal(obs.extras.workflowType, 'prd-draft');
  assert.ok(Array.isArray(obs.extras.selectedRoles) && obs.extras.selectedRoles.length > 0, 'provenance record carries the recruited specialist set');
  assert.ok(obs.extras.selectedRoles.every((r) => r.startsWith('cx-')), 'recruited specialists are cx-role ids');
});

const FULL_DRAFT = [
  '# Provenance full-execute case',
  '',
  'This document exercises the full author_artifact path where a draft is supplied end to end, so the release gate has real prose to evaluate and the provenance write is checked alongside a materialized artifact file.',
  '',
  '## Problem',
  '',
  'Nothing durable proved an author_artifact call happened before construct-ifwhw.2; this paragraph and the next give the release gate two full prose paragraphs to satisfy its content floor.',
  '',
  '## Goals and non-goals',
  '',
  '- Goal: a provenance record exists on disk after every author_artifact call.',
  '- Non-goal: changing whether the artifact file itself is written in the no-draft case.',
  '',
  '[unverified]',
  '',
].join('\n');

test('full-execute: a supplied draft writes both the artifact file and a provenance record', async (t) => {
  const cwd = project();
  withHashingEmbeddings(t, cwd);

  const res = await authorArtifact({
    artifact_type: 'prd',
    subject: 'provenance full-execute case',
    draft_markdown: FULL_DRAFT,
    cwd,
  }, { ROOT_DIR: REPO });

  assert.equal(res.written, true, 'a supplied draft materializes the artifact file');
  assert.equal(fs.existsSync(path.join(cwd, res.path)), true, 'artifact file exists on disk');

  assert.ok(res.provenance, 'author_artifact result carries a provenance summary');
  assert.equal(res.provenance.ok, true, `provenance write failed: ${res.provenance.error}`);

  const observations = readObservations(cwd).filter((o) => o.tags?.includes('artifact-loop'));
  assert.equal(observations.length, 1, 'exactly one provenance observation was written to disk');

  const [obs] = observations;
  assert.ok(obs.extras.traceId, 'provenance record carries a traceId');
  assert.equal(obs.extras.artifactType, 'prd');
  assert.equal(obs.extras.relPath, res.path, 'provenance record links to the materialized artifact path');
  assert.ok(Array.isArray(obs.extras.selectedRoles) && obs.extras.selectedRoles.length > 0, 'provenance record carries the recruited specialist set');
});
