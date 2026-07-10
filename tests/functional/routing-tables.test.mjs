/**
 * tests/functional/routing-tables.test.mjs — parity guard for declarative routing.
 *
 * Loads the real specialists/org via routing-tables.mjs and asserts
 * each route the orchestration layer depends on. Catches drift if a future
 * registry edit drops a subscription, mis-names a watcher, or strips an
 * artifact owner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ownerForEvent,
  ownerForDoc,
  evaluateWatchConditions,
  knownEventTypes,
  knownDocTypes,
  knownWatchers,
} from '../../lib/orchestration/routing-tables.mjs';

// construct-rf26.11 consolidated the 29-specialist roster to 12 (orchestrator
// + 11 workers); owners below reflect that roster (e.g. sre/release-manager/
// docs-keeper folded into cx-operations — see the ADR-0065 appendix addendum).
const EXPECTED_EVENTS = {
  'push_gate.fail': 'cx-operations',
  'service.down': 'cx-operations',
  'mcp.unhealthy.persistent': 'cx-operations',
  'edit_loop.stuck': 'cx-operations',
  'test.fail': 'cx-qa',
  'test.flake': 'cx-qa',
  'coverage.drop': 'cx-qa',
  'dep.cve': 'cx-security',
  'secrets.detected': 'cx-security',
  'config.protection.violation': 'cx-security',
  'pr.merged.no-docs': 'cx-operations',
  'changelog.missing': 'cx-operations',
  'document.stale': 'cx-operations',
  'readme.stale': 'cx-operations',
  'adr.requested': 'cx-architect',
  'arch.boundary.violated': 'cx-architect',
  'regression.detected': 'cx-debugger',
  'hang.detected': 'cx-debugger',
  'release.candidate': 'cx-operations',
  'version.bump.needed': 'cx-operations',
  'backlog.stale': 'cx-product-manager',
  'prd.requested': 'cx-product-manager',
  'pr.opened': 'cx-reviewer',
  'pr.ready-for-review': 'cx-reviewer',
  'infra.change.requested': 'cx-engineer',
  'service.scale.event': 'cx-engineer',
  'design.requested': 'cx-designer',
  'a11y.violation': 'cx-designer',
  'research.requested': 'cx-researcher',
  'evidence.requested': 'cx-researcher',
  'eval.regression': 'cx-reviewer',
  'trace.anomaly': 'cx-reviewer',
  'dep.license': 'cx-security',
  'privacy-policy.review': 'cx-security',
  'strategy.required': 'cx-product-manager',
  'plan.requested': 'cx-operations',
  'research.gate.required': 'cx-architect',
  'handoff.received': 'cx-orchestrator',
  'incident.handoff': 'cx-engineer',
  'bug.assigned': 'cx-engineer',
  'feature.assigned': 'cx-engineer',
};

const EXPECTED_DOCS = {
  prd: 'cx-product-manager',
  'meta-prd': 'cx-product-manager',
  'prd-platform': 'cx-product-manager',
  'prd-business': 'cx-product-manager',
  prfaq: 'cx-product-manager',
  'one-pager': 'cx-product-manager',
  'backlog-proposal': 'cx-product-manager',
  'customer-profile': 'cx-product-manager',
  adr: 'cx-architect',
  rfc: 'cx-architect',
  'rfc-platform': 'cx-architect',
  'architecture-overview': 'cx-architect',
  'system-design': 'cx-architect',
  'research-brief': 'cx-researcher',
  'evidence-brief': 'cx-researcher',
  'signal-brief': 'cx-researcher',
  'product-intelligence-report': 'cx-researcher',
  runbook: 'cx-operations',
  'incident-report': 'cx-operations',
  postmortem: 'cx-operations',
  'test-plan': 'cx-qa',
  'qa-strategy': 'cx-qa',
  'security-review': 'cx-security',
  'threat-model': 'cx-security',
  memo: 'cx-operations',
  changelog: 'cx-operations',
  strategy: 'cx-product-manager',
};

test('every expected event resolves to its declared specialist owner', () => {
  for (const [event, owner] of Object.entries(EXPECTED_EVENTS)) {
    assert.equal(ownerForEvent(event), owner, `event ${event}`);
  }
});

test('every expected doc artifact resolves to its declared specialist owner', () => {
  for (const [docType, owner] of Object.entries(EXPECTED_DOCS)) {
    assert.equal(ownerForDoc(docType), owner, `doc ${docType}`);
  }
});

test('unknown event types return null instead of throwing', () => {
  assert.equal(ownerForEvent('does-not-exist.event'), null);
  assert.equal(ownerForEvent(''), null);
  assert.equal(ownerForEvent(null), null);
});

test('unknown doc types return null instead of throwing', () => {
  assert.equal(ownerForDoc('not-a-real-doc-type'), null);
  assert.equal(ownerForDoc(''), null);
});

test('wide blast radius triggers cx-operations via watch condition', () => {
  const triggers = evaluateWatchConditions({
    blastRadius: 'wide',
    riskFlags: {},
  });
  const operations = triggers.find((t) => t.specialist === 'cx-operations');
  assert.ok(operations, 'expected cx-operations triggered by wide-blast-radius');
  assert.equal(operations.watcher, 'wide-blast-radius');
});

test('auth + non-narrow blast triggers cx-security via watch condition', () => {
  const triggers = evaluateWatchConditions({
    authOrPayments: true,
    blastRadius: 'wide',
    riskFlags: {},
  });
  const security = triggers.find((t) => t.specialist === 'cx-security');
  assert.ok(security, 'expected cx-security triggered by auth-payments-non-narrow');
  assert.match(security.reason, /auth|payments|threat/i);
});

test('high ambiguity on deep work triggers cx-product-manager via watch condition', () => {
  const triggers = evaluateWatchConditions({
    ambiguityScore: 0.7,
    workCategory: 'deep',
    riskFlags: {},
    blastRadius: 'narrow',
  });
  const pm = triggers.find((t) => t.specialist === 'cx-product-manager');
  assert.ok(pm, 'expected cx-product-manager triggered by high-ambiguity-deep-work');
});

test('narrow scope with no signals returns no triggers', () => {
  const triggers = evaluateWatchConditions({
    ambiguityScore: 0,
    workCategory: 'quick',
    riskFlags: {},
    blastRadius: 'narrow',
    hasSuccessMetric: true,
    authOrPayments: false,
    visualDeliverable: false,
  });
  assert.equal(triggers.length, 0);
});

test('registry covers the full set of routable event types', () => {
  const events = knownEventTypes();
  assert.equal(events.length, Object.keys(EXPECTED_EVENTS).length);
});

test('registry covers the full set of routable doc artifact types', () => {
  const docs = knownDocTypes();
  assert.equal(docs.length, Object.keys(EXPECTED_DOCS).length);
});

test('all six watch conditions are bound to a specialist', () => {
  const watchers = knownWatchers();
  assert.deepEqual(watchers.sort(), [
    'architecture-without-metric',
    'auth-payments-non-narrow',
    'high-ambiguity-deep-work',
    'named-cost-constraint',
    'visual-or-ui-risk',
    'wide-blast-radius',
  ].sort());
});
