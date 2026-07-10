/**
 * tests/graph/build-from-registry.test.mjs — the registry-ingest builder must
 * faithfully project the authoritative catalogs into the dependency graph.
 *
 * Runs against the real repo seeds (registry/capabilities.json,
 * specialists/contracts.json, workflow-defs) so the test fails if a capability
 * loses its workflow/test/contract links — the traceability the matrix depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildFromRegistry } from '../../lib/graph/build-from-registry.mjs';
import { loadCapabilityRegistry } from '../../lib/registry/validate.mjs';
import { WORKFLOW_TYPES } from '../../lib/embedded-contract/workflow-defs.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function index(built) {
  const nodeById = new Map(built.nodes.map((n) => [n.id, n]));
  const byType = (t) => built.nodes.filter((n) => n.type === t);
  const edgesByRel = (r) => built.edges.filter((e) => e.rel === r);
  return { nodeById, byType, edgesByRel };
}

test('every capability and every embedded workflow becomes a node', () => {
  const built = buildFromRegistry({ rootDir: REPO_ROOT });
  const { nodeById, byType } = index(built);
  const registry = loadCapabilityRegistry({ rootDir: REPO_ROOT });

  for (const cap of registry.capabilities) {
    assert.ok(nodeById.has(`capability:${cap.id}`), `missing capability node: ${cap.id}`);
  }
  for (const wf of WORKFLOW_TYPES) {
    assert.ok(nodeById.has(`workflow:${wf}`), `missing workflow node: ${wf}`);
  }
  assert.equal(byType('capability').length, registry.capabilities.length);
  assert.equal(byType('workflow').length, WORKFLOW_TYPES.length);
});

test('embeds edges match capabilities declaring an embeddedWorkflow', () => {
  const built = buildFromRegistry({ rootDir: REPO_ROOT });
  const { edgesByRel } = index(built);
  const registry = loadCapabilityRegistry({ rootDir: REPO_ROOT });
  const expected = registry.capabilities.filter((c) => c.embeddedWorkflow).length;

  const embeds = edgesByRel('embeds');
  assert.equal(embeds.length, expected);
  for (const e of embeds) {
    assert.ok(e.from.startsWith('capability:'));
    assert.ok(e.to.startsWith('workflow:'));
  }
});

test('declared verification tests produce validates edges into their capability', () => {
  const built = buildFromRegistry({ rootDir: REPO_ROOT });
  const { edgesByRel } = index(built);
  const registry = loadCapabilityRegistry({ rootDir: REPO_ROOT });

  const withTests = registry.capabilities.filter(
    (c) => c.verification?.functional || c.verification?.hostEmulation,
  );
  assert.ok(withTests.length >= 20, `expected most capabilities to declare tests, got ${withTests.length}`);

  const validates = edgesByRel('validates');
  assert.ok(validates.length >= withTests.length, 'every declared verification path should yield a validates edge');
  for (const e of validates) {
    assert.ok(e.from.startsWith('test:'));
    assert.ok(e.to.startsWith('capability:'));
  }
});

test('oracle.meta-review is reverse-traceable to its functional test', () => {
  const built = buildFromRegistry({ rootDir: REPO_ROOT });
  const validates = built.edges.filter((e) => e.rel === 'validates' && e.to === 'capability:oracle.meta-review');
  assert.ok(
    validates.some((e) => e.from === 'test:tests/functional/oracle-bounded-auto.functional.test.mjs'),
    'oracle.meta-review must trace to its declared functional test',
  );
});

test('all contracts are ingested and referenced contracts are governed_by edges', () => {
  const built = buildFromRegistry({ rootDir: REPO_ROOT });
  const { byType, edgesByRel } = index(built);

  // buildFromRegistry returns raw (pre-dedup) nodes; the store dedups on write,
  // so assert on unique ids rather than the raw array length.

  const contractIds = new Set(byType('contract').map((n) => n.id));
  // construct-rf26.11 deleted 8 of the 43 contracts that collapsed to
  // intra-role handoffs when their producer/consumer roles consolidated —
  // see the ADR-0065 appendix addendum. construct-jvjow.3 added
  // pm-engineering-signals.
  assert.equal(contractIds.size, 36);
  for (const e of edgesByRel('governed_by')) {
    assert.ok(e.from.startsWith('capability:'));
    assert.ok(contractIds.has(e.to), `governed_by points at a known contract: ${e.to}`);
  }
});

test('builder is deterministic and emits a stable sourceHash', () => {
  const a = buildFromRegistry({ rootDir: REPO_ROOT });
  const b = buildFromRegistry({ rootDir: REPO_ROOT });
  assert.equal(a.sourceHash, b.sourceHash);
  assert.equal(a.nodes.length, b.nodes.length);
  assert.equal(a.edges.length, b.edges.length);
});
