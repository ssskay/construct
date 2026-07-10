/**
 * tests/golden-surface.test.mjs — core-surface drift guard.
 *
 * @enforces ADR-0015
 *
 * Bead construct-wvbf.5: the CLI command set, specialist roster, and hook
 * execution order are pinned in tests/fixtures/golden/surface.json. A change to
 * any of them fails here until the snapshot is regenerated on purpose
 * (`construct decisions golden --write`), so the surface cannot drift silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSurfaceSnapshot, compareSurfaceSnapshot } from '../lib/decisions/golden.mjs';

test('the live surface matches the committed golden snapshot', async () => {
  const { ok, diffs } = await compareSurfaceSnapshot();
  assert.equal(ok, true, diffs.join('; '));
});

test('the snapshot captures commands, agents, and ordered hooks', async () => {
  const s = await buildSurfaceSnapshot();
  assert.ok(s.commands.length > 0, 'commands captured');
  assert.ok(s.agents.length > 0, 'agents captured');
  assert.ok(Array.isArray(s.hooks.PreToolUse), 'hook order captured');
});
