/**
 * skill-quality-signal.functional.test.mjs — phase 1 of the skill
 * effectiveness pipeline closes its loop end-to-end.
 *
 * Drives the real agent-tracker hook with a Task outcome that carries a
 * session_id, in an isolated CONSTRUCT_DOCTOR_ROOT seeded with
 * skill-calls.jsonl load events. Asserts the durable artifacts: the role
 * outcome in .cx/outcomes/, the attributed lines in skill-outcomes.jsonl
 * (deduped per skill, joined on sessionId), the `construct skills quality`
 * CLI rendering, and the summary JSON it writes. Also proves the two
 * guard rails: CONSTRUCT_SKILL_TELEMETRY=off suppresses attribution without
 * touching the role outcome, and a sessionId with no matching skill loads
 * writes nothing.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTmpDir } from '../helpers/cleanup.mjs';
import { sterileSpawnEnv } from '../helpers/sterile-env.mjs';
import { configPath } from '../../lib/config-dir.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const HOOK = join(repoRoot, 'lib', 'hooks', 'agent-tracker.mjs');
const CLI = join(repoRoot, 'bin', 'construct');

function makeFixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cx-skill-quality-state-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'cx-skill-quality-proj-'));
  mkdirSync(join(projectDir, '.cx'), { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'skill-quality-fixture' }));

  const calls = [
    { ts: '2026-07-09T00:00:00.000Z', skillId: 'exploration/repo-map', source: 'mcp', sessionId: 'sess-a' },
    { ts: '2026-07-09T00:01:00.000Z', skillId: 'quality-gates/review', source: 'mcp', sessionId: 'sess-a' },
    { ts: '2026-07-09T00:02:00.000Z', skillId: 'docs/prd-workflow', source: 'mcp', sessionId: 'sess-b' },
    { ts: '2026-07-09T00:03:00.000Z', skillId: 'exploration/repo-map', source: 'mcp', sessionId: 'sess-a' },
  ];
  writeFileSync(join(stateRoot, 'skill-calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  return { stateRoot, projectDir };
}

function runHook({ stateRoot, projectDir, sessionId, envExtra = {} }) {
  const input = {
    tool_name: 'Task',
    session_id: sessionId,
    cwd: projectDir,
    tool_input: { subagent_type: 'cx-engineer', description: 'implement the widget' },
    tool_result: { result: 'completed successfully' },
  };
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    cwd: projectDir,
    env: sterileSpawnEnv({ CONSTRUCT_DOCTOR_ROOT: stateRoot, ...envExtra }),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('a Task outcome with a session_id attributes the outcome to every skill loaded in that session', () => {
  const { stateRoot, projectDir } = makeFixture();
  try {
    const r = runHook({ stateRoot, projectDir, sessionId: 'sess-a' });
    assert.equal(r.status, 0, `agent-tracker should exit 0: ${r.stderr}`);

    const roleLog = configPath(projectDir, 'outcomes', 'engineer.jsonl');
    assert.ok(existsSync(roleLog), 'role outcome JSONL is written under the project .cx');
    const roleRows = readFileSync(roleLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(roleRows.length, 1);
    assert.equal(roleRows[0].success, true);
    assert.equal(roleRows[0].sessionId, 'sess-a', 'role outcome carries the sessionId');

    const outcomesLog = join(stateRoot, 'skill-outcomes.jsonl');
    assert.ok(existsSync(outcomesLog), 'skill-outcomes.jsonl is written under the doctor root');
    const rows = readFileSync(outcomesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ids = rows.map((x) => x.skillId).sort();
    assert.deepEqual(ids, ['exploration/repo-map', 'quality-gates/review'],
      'one line per distinct sess-a skill; the duplicate repo-map load does not double-count and sess-b skills are excluded');
    for (const row of rows) {
      assert.equal(row.sessionId, 'sess-a');
      assert.equal(row.success, true);
      assert.equal(row.role, 'engineer');
      assert.equal(row.source, 'agent-tracker');
    }
  } finally {
    rmTmpDir(stateRoot);
    rmTmpDir(projectDir);
  }
});

test('construct skills quality aggregates the attribution log and writes the summary JSON', () => {
  const { stateRoot, projectDir } = makeFixture();
  try {
    assert.equal(runHook({ stateRoot, projectDir, sessionId: 'sess-a' }).status, 0);

    const r = spawnSync(process.execPath, [CLI, 'skills', 'quality'], {
      cwd: projectDir,
      env: sterileSpawnEnv({ CONSTRUCT_DOCTOR_ROOT: stateRoot }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `skills quality should exit 0: ${r.stderr}`);
    assert.match(r.stdout, /Skill quality — 2 skill\(s\), 2 attributed outcome\(s\)/);
    assert.match(r.stdout, /exploration\/repo-map/);
    assert.match(r.stdout, /quality-gates\/review/);
    assert.match(r.stdout, /100%/);

    const summaryPath = join(stateRoot, 'skill-outcomes-summary.json');
    assert.ok(existsSync(summaryPath), 'summary JSON is written under the doctor root');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.equal(summary.totalOutcomes, 2);
    assert.equal(summary.skills['exploration/repo-map'].count, 1);
    assert.equal(summary.skills['exploration/repo-map'].successRate, 1);
    assert.equal(summary.skills['exploration/repo-map'].last30.count, 1);
  } finally {
    rmTmpDir(stateRoot);
    rmTmpDir(projectDir);
  }
});

test('CONSTRUCT_SKILL_TELEMETRY=off suppresses attribution but not the role outcome', () => {
  const { stateRoot, projectDir } = makeFixture();
  try {
    const r = runHook({ stateRoot, projectDir, sessionId: 'sess-a', envExtra: { CONSTRUCT_SKILL_TELEMETRY: 'off' } });
    assert.equal(r.status, 0, `agent-tracker should exit 0: ${r.stderr}`);
    assert.ok(existsSync(configPath(projectDir, 'outcomes', 'engineer.jsonl')), 'role outcome still written');
    assert.ok(!existsSync(join(stateRoot, 'skill-outcomes.jsonl')), 'no attribution when telemetry is off');
  } finally {
    rmTmpDir(stateRoot);
    rmTmpDir(projectDir);
  }
});

test('a sessionId with no matching skill loads attributes nothing and does not crash', () => {
  const { stateRoot, projectDir } = makeFixture();
  try {
    const r = runHook({ stateRoot, projectDir, sessionId: 'sess-none' });
    assert.equal(r.status, 0, `agent-tracker should exit 0: ${r.stderr}`);
    assert.ok(existsSync(configPath(projectDir, 'outcomes', 'engineer.jsonl')), 'role outcome still written');
    assert.ok(!existsSync(join(stateRoot, 'skill-outcomes.jsonl')), 'no attribution lines for an unknown session');
  } finally {
    rmTmpDir(stateRoot);
    rmTmpDir(projectDir);
  }
});
