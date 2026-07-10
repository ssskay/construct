/**
 * tests/workflows/workflow-manifests.test.mjs — integration tests for all built-in workflow manifests.
 *
 * Validates every manifest in the builtin directory: required fields, valid type,
 * valid role chain references, and schema file existence for outputSchema.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import test from 'node:test';

import {
  loadWorkflowManifestsFromDir, resolveWorkflowManifestDirs,
} from '../../lib/workflows/loader.mjs';
import {
  WORKFLOW_TYPES, APPROVAL_MODES, TIERS,
} from '../../lib/workflows/manifest-schema.mjs';
import { listRoles } from '../../lib/roles/catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, '..', '..', 'lib', 'schemas');

test('all builtin workflow manifests validate successfully', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests, errors } = loadWorkflowManifestsFromDir(dirs.builtin);
  assert.equal(errors.length, 0, `validation errors: ${errors.join(', ')}`);
  assert.ok(manifests.length > 0, 'at least one manifest loaded');
});

test('all builtin manifests are present', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  const ids = manifests.map((m) => m.id).sort();
  assert.deepEqual(ids, [
    'architecture-review', 'data-structure', 'evidence-ingest', 'memo-draft',
    'operations', 'operations-triage', 'pm-feedback', 'pm-repos', 'prd-draft', 'proposal-review', 'research-synthesis', 'risk-review',
    'structure-notes', 'transcript-process', 'triage',
  ]);
});

test('every manifest has a valid type in WORKFLOW_TYPES', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  for (const m of manifests) {
    assert.ok(WORKFLOW_TYPES.includes(m.type), `${m.id}: type '${m.type}' is valid`);
  }
});

test('every manifest has a valid defaultApprovalMode', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  for (const m of manifests) {
    assert.ok(APPROVAL_MODES.includes(m.defaultApprovalMode), `${m.id}: approval mode '${m.defaultApprovalMode}' is valid`);
  }
});

test('every manifest has a valid tier', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  // Embed manifests are a workflow specialization carrying an embed block, not
  // a model tier or role chain — those fields are specific to the executable
  // workflow types.
  for (const m of manifests.filter((x) => x.type !== 'embed')) {
    assert.ok(TIERS.includes(m.tier), `${m.id}: tier '${m.tier}' is valid`);
  }
});

test('every manifest has a compatVersion <= WORKFLOW_COMPAT_VERSION', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  for (const m of manifests) {
    assert.ok(m.compatVersion !== undefined, `${m.id}: compatVersion is present`);
    assert.equal(typeof m.compatVersion, 'number', `${m.id}: compatVersion is a number`);
    assert.ok(Number.isInteger(m.compatVersion), `${m.id}: compatVersion is an integer`);
    assert.ok(m.compatVersion <= 1, `${m.id}: compatVersion <= 1`);
  }
});

test('roleChain references real registry roles', () => {
  const known = new Set(listRoles().map((r) => r.id));
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  // Embed manifests bind a single specialist via embed.specialist, not a
  // roleChain — the executable workflow types own the chain.
  for (const m of manifests.filter((x) => x.type !== 'embed')) {
    assert.ok(Array.isArray(m.roleChain), `${m.id}: roleChain is an array`);
    assert.ok(m.roleChain.length > 0, `${m.id}: roleChain is non-empty`);
    for (const role of m.roleChain) {
      assert.ok(known.has(role), `${m.id}: role '${role}' exists in the registry`);
    }
  }
});

test('outputSchema.artifact references real schema files when present', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  for (const m of manifests) {
    if (m.outputSchema?.artifact) {
      const schemaFile = join(SCHEMA_DIR, `${m.outputSchema.artifact}.json`);
      assert.ok(existsSync(schemaFile), `${m.id}: schema ${schemaFile} exists`);
    }
  }
});

test('every manifest has required fields: id, version, type, defaultApprovalMode', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  for (const m of manifests) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0, `${m.id}: id is non-empty string`);
    assert.ok(typeof m.version === 'string', `${m.id}: version is string`);
    assert.ok(typeof m.type === 'string', `${m.id}: type is string`);
    assert.ok(typeof m.defaultApprovalMode === 'string', `${m.id}: defaultApprovalMode is string`);
  }
});

test('every id matches [a-z0-9-./]+ pattern', () => {
  const re = /^[a-z0-9\-./]+$/;
  const dirs = resolveWorkflowManifestDirs();
  const { manifests } = loadWorkflowManifestsFromDir(dirs.builtin);
  for (const m of manifests) {
    assert.ok(re.test(m.id), `${m.id}: id matches pattern`);
  }
});