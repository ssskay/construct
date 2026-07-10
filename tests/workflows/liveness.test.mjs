/**
 * tests/workflows/liveness.test.mjs — unit and fixture tests for workflow
 * manifest liveness validation (LMCP-C11).
 *
 * Exercises checkWorkflowLiveness directly (bogus roleChain, cycle,
 * reachability fixtures) and confirms all builtin manifests pass with
 * zero violations against the real specialist registry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkWorkflowLiveness } from '../../lib/workflows/liveness.mjs';
import { loadWorkflowManifestsFromDir, resolveWorkflowManifestDirs } from '../../lib/workflows/loader.mjs';

const ROOT_DIR = process.cwd();

test('bogus roleChain entry fails with the manifest path', () => {
  const manifests = [{
    id: 'wf-bogus',
    _filePath: '/fixtures/wf-bogus.manifest.json',
    roleChain: ['architect', 'not-a-real-role'],
    surfaces: ['cli'],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  assert.ok(violations.length > 0, 'expected at least one violation');
  const msg = violations.find((v) => v.includes('not-a-real-role'));
  assert.ok(msg, `expected a violation naming the bogus role, got: ${JSON.stringify(violations)}`);
  assert.ok(msg.startsWith('/fixtures/wf-bogus.manifest.json'), 'violation is prefixed with the manifest path');
});

test('valid roleChain entries produce no resolution violations', () => {
  const manifests = [{
    id: 'wf-ok',
    _filePath: '/fixtures/wf-ok.manifest.json',
    roleChain: ['architect', 'security'],
    surfaces: ['cli'],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  assert.deepEqual(violations, []);
});

test('circular handoff in roleChain is detected', () => {
  const manifests = [{
    id: 'wf-cycle',
    _filePath: '/fixtures/wf-cycle.manifest.json',
    roleChain: ['architect', 'security', 'architect'],
    surfaces: ['cli'],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  const msg = violations.find((v) => v.includes('circular handoff'));
  assert.ok(msg, `expected a circular handoff violation, got: ${JSON.stringify(violations)}`);
});

test('longer cycle (a -> b -> c -> a) is detected', () => {
  const manifests = [{
    id: 'wf-cycle-3',
    _filePath: '/fixtures/wf-cycle-3.manifest.json',
    roleChain: ['architect', 'security', 'devil-advocate', 'architect'],
    surfaces: ['cli'],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  const msg = violations.find((v) => v.includes('circular handoff'));
  assert.ok(msg, `expected a circular handoff violation, got: ${JSON.stringify(violations)}`);
});

test('a role appearing twice without an intervening handoff is not a false-positive cycle', () => {
  const manifests = [{
    id: 'wf-repeat-noop',
    _filePath: '/fixtures/wf-repeat-noop.manifest.json',
    roleChain: ['architect', 'architect', 'security'],
    surfaces: ['cli'],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  assert.deepEqual(violations, []);
});

test('workflow with no declared surfaces is flagged unreachable', () => {
  const manifests = [{
    id: 'wf-no-surface',
    _filePath: '/fixtures/wf-no-surface.manifest.json',
    roleChain: ['architect'],
    surfaces: [],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  const msg = violations.find((v) => v.includes('unreachable'));
  assert.ok(msg, `expected an unreachable violation, got: ${JSON.stringify(violations)}`);
  assert.ok(msg.includes('no surfaces'));
});

test('workflow with no declared modes is flagged unreachable', () => {
  const manifests = [{
    id: 'wf-no-mode',
    _filePath: '/fixtures/wf-no-mode.manifest.json',
    roleChain: ['architect'],
    surfaces: ['cli'],
    modes: [],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  const msg = violations.find((v) => v.includes('unreachable'));
  assert.ok(msg, `expected an unreachable violation, got: ${JSON.stringify(violations)}`);
  assert.ok(msg.includes('no modes'));
});

test('workflow with both surfaces and modes declared is reachable', () => {
  const manifests = [{
    id: 'wf-reachable',
    _filePath: '/fixtures/wf-reachable.manifest.json',
    roleChain: ['architect'],
    surfaces: ['mcp'],
    modes: ['solo'],
  }];
  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  assert.deepEqual(violations, []);
});

test('all builtin manifests pass liveness with zero violations', () => {
  const dirs = resolveWorkflowManifestDirs();
  const { manifests, errors } = loadWorkflowManifestsFromDir(dirs.builtin);
  assert.equal(errors.length, 0, `unexpected schema errors: ${errors.join(', ')}`);
  assert.equal(manifests.length, 15, `expected 15 builtin manifests, got ${manifests.length}`);

  const { violations } = checkWorkflowLiveness(manifests, { rootDir: ROOT_DIR });
  assert.deepEqual(violations, [], `expected zero liveness violations, got: ${JSON.stringify(violations)}`);
});
