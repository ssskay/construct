/**
 * tests/orchestration-signal-dimensions.test.mjs — registry-declared signal
 * dimensions (construct-pteo2.3 / cdsp.10).
 *
 * Table-driven: one keyword from each dimension in
 * lib/orchestration/signal-dimensions.mjs must flip the matching
 * requestSignals() field true and leave the others false. Also asserts that
 * hasNamedConstraints combined with the cost dimension drives a consuming
 * rule (routing-tables 'named-cost-constraint' -> cx-product-manager).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { requestSignals, proactiveTriggers } from '../lib/orchestration/flow-selection.mjs';
import { loadSignalDimensions } from '../lib/orchestration/signal-dimensions.mjs';

const DIMENSION_PROBES = {
  cost: 'stay under budget for this build',
  compliance: 'must satisfy gdpr compliance',
  accessibility: 'needs a wcag accessibility pass',
  data: 'validate the dataset for statistical significance',
  reliability: 'protect the p99 error budget',
  privacy: 'this handles pii and personal data',
};

test('signal-dimensions registry declares the six new dimensions', () => {
  const keys = loadSignalDimensions().map((d) => d.key).sort();
  assert.deepEqual(keys, ['accessibility', 'compliance', 'cost', 'data', 'privacy', 'reliability']);
});

for (const [key, probe] of Object.entries(DIMENSION_PROBES)) {
  test(`requestSignals: "${probe}" flips ${key} true`, () => {
    const signals = requestSignals(probe);
    assert.equal(signals[key], true, `expected ${key} true for probe: ${probe}`);
  });
}

test('requestSignals: epic example -> cost, hasNamedConstraints, privacy all true', () => {
  const signals = requestSignals('PRD for enterprise tier pricing, must stay under budget, handles PII');
  assert.equal(signals.cost, true);
  assert.equal(signals.hasNamedConstraints, true);
  assert.equal(signals.privacy, true);
});

test('requestSignals: neutral request leaves all six dimensions false', () => {
  const signals = requestSignals('write a short blog post about cats');
  for (const key of Object.keys(DIMENSION_PROBES)) {
    assert.equal(signals[key], false, `expected ${key} false for neutral request`);
  }
});

test('hasNamedConstraints/budget is consumed: named-cost-constraint fires cx-product-manager', () => {
  const signals = requestSignals('ship this feature but must not exceed the budget');
  assert.equal(signals.hasNamedConstraints, true);
  assert.equal(signals.cost, true);
  const triggers = proactiveTriggers(signals);
  assert.ok(
    triggers.some((t) => t.specialist === 'cx-product-manager' && t.reason.includes('cost')),
    `expected a cx-product-manager cost trigger, got: ${JSON.stringify(triggers)}`,
  );
});

test('hasNamedConstraints without a cost dimension does not fire the cost watcher', () => {
  const signals = requestSignals('the deadline is next friday');
  assert.equal(signals.hasNamedConstraints, true);
  assert.equal(signals.cost, false);
  const triggers = proactiveTriggers(signals);
  assert.ok(!triggers.some((t) => t.specialist === 'cx-product-manager' && t.reason.includes('cost')));
});
