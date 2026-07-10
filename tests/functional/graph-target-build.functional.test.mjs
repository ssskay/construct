/**
 * tests/functional/graph-target-build.functional.test.mjs —
 * import/symbol graph per registered source target, persisted under the
 * project state root and queryable via --projects (construct-1smc4.2).
 *
 * lib/graph/build-import-graph.mjs and lib/graph/build-from-corpus.mjs only
 * ever built a graph for the host project's own rootDir. This test builds a
 * fixture "repo" as a local tmpdir directory (no git, no network) registered
 * as a `directory` source target — the same target-resolution mechanism
 * construct-1smc4.1 wired into lib/knowledge/search.mjs
 * (lib/sources/content-roots.mjs's resolveContentRoots) — and asserts:
 *
 *   1. `buildTargetGraphs` (lib/graph/build-target-graph.mjs) derives an
 *      import edge between the fixture's two files and persists it under
 *      `.cx/graph/targets/<targetId>/` (lib/graph/store.mjs's JSONL shape),
 *      with every node's attrs.origin carrying the target's id/kind.
 *   2. The persisted graph is readable straight off disk via a fresh
 *      `loadTargetGraph` call — not held in any in-memory cache.
 *   3. `construct graph build-targets` then, in a SEPARATE spawned process,
 *      `construct graph query <id> --projects=<targetId>` round-trip through
 *      the real binary: the second process never ran the builder, so a
 *      correct answer proves the graph survived process (session) restart.
 *   4. `--projects` with an unknown target id is a hard error (matching
 *      lib/sources/content-roots.mjs's expandProjectsFilter contract), not a
 *      silent empty result.
 *
 * Sterile: no real github clone, no network.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildTargetGraphs, loadTargetGraph } from '../../lib/graph/build-target-graph.mjs';
import { dependenciesOf } from '../../lib/graph/store.mjs';
import { rmTmpDir } from '../helpers/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'construct');

const dirs = [];
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const d of dirs) { try { rmTmpDir(d); } catch {} } });

function makeFixtureRepo(marker) {
  const dir = freshDir('cx-graph-target-');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib', 'helper.mjs'),
    `export function ${marker}Helper() { return 1; }\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'main.mjs'),
    `import { ${marker}Helper } from './lib/helper.mjs';\nexport function ${marker}Main() { return ${marker}Helper(); }\n`,
  );
  return dir;
}

function writeProjectConfig(project, targets) {
  fs.writeFileSync(path.join(project, 'construct.config.json'), JSON.stringify({
    version: 1,
    sources: { targets },
  }, null, 2));
}

test('buildTargetGraphs derives an import edge for a registered target and persists it under .cx/graph/targets/<id>/', () => {
  const repo = makeFixtureRepo('zqTarget');
  const project = freshDir('cx-graph-target-proj-');
  writeProjectConfig(project, [{ id: 'repo-x', provider: 'directory', selector: { path: repo } }]);

  const { built } = buildTargetGraphs({ projectDir: project });
  assert.equal(built.length, 1, 'exactly one target graph built');
  assert.equal(built[0].targetId, 'repo-x');
  assert.ok(built[0].nodeCount >= 2, 'main.mjs and lib/helper.mjs both become nodes');

  const dir = path.join(project, '.cx', 'graph', 'targets', 'repo-x');
  assert.ok(fs.existsSync(path.join(dir, 'nodes.jsonl')), 'nodes.jsonl persisted');
  assert.ok(fs.existsSync(path.join(dir, 'edges.jsonl')), 'edges.jsonl persisted');
  assert.ok(fs.existsSync(path.join(dir, 'meta.json')), 'meta.json persisted');

  const nodesRaw = fs.readFileSync(path.join(dir, 'nodes.jsonl'), 'utf8');
  assert.match(nodesRaw, /"file:main\.mjs"/, 'main.mjs node persisted on disk');
  assert.match(nodesRaw, /"file:lib\/helper\.mjs"/, 'lib/helper.mjs node persisted on disk');

  // A fresh loadTargetGraph call re-reads straight from disk, not any
  // in-memory cache held by buildTargetGraphs.
  const graph = loadTargetGraph(project, 'repo-x');
  assert.equal(graph.exists, true);
  const mainNode = graph.nodes.get('file:main.mjs');
  assert.ok(mainNode, 'main.mjs node loadable after a fresh loadTargetGraph call');
  assert.equal(mainNode.attrs.origin.targetId, 'repo-x', 'node carries target origin');
  assert.equal(mainNode.attrs.origin.kind, 'code');

  const deps = dependenciesOf(graph, 'file:main.mjs', 'imports');
  assert.deepEqual(deps, ['file:lib/helper.mjs'], 'import edge from main.mjs to lib/helper.mjs derived');
});

test('construct graph build-targets then a SEPARATE process query --projects=<id> survives session restart', () => {
  const repo = makeFixtureRepo('xkRestart');
  const project = freshDir('cx-graph-target-cli-');
  writeProjectConfig(project, [{ id: 'repo-y', provider: 'directory', selector: { path: repo } }]);

  const env = { ...process.env, HOME: project, USERPROFILE: project, GITHUB_TOKEN: '', GH_TOKEN: '' };

  const build = spawnSync(process.execPath, [BIN, 'graph', 'build-targets', '--json'], {
    cwd: project, encoding: 'utf8', timeout: 60_000, env,
  });
  assert.equal(build.status, 0, `graph build-targets failed: ${build.stderr}`);
  const buildResult = JSON.parse(build.stdout);
  assert.equal(buildResult.ok, true);
  assert.equal(buildResult.targets[0].targetId, 'repo-y');

  // A brand-new process — this one never ran the builder above — must still
  // find the graph on disk. This is the "survives a session restart" proof.
  const query = spawnSync(process.execPath, [BIN, 'graph', 'query', 'file:main.mjs', '--projects=repo-y', '--json'], {
    cwd: project, encoding: 'utf8', timeout: 60_000, env,
  });
  assert.equal(query.status, 0, `graph query failed: ${query.stderr}`);
  const queryResult = JSON.parse(query.stdout);
  assert.equal(queryResult.projects.length, 1);
  const hit = queryResult.projects[0];
  assert.equal(hit.projectKey, 'repo-y');
  assert.equal(hit.found, true);
  assert.deepEqual(hit.dependencies, ['file:lib/helper.mjs']);

  // An unknown --projects id is a hard error (matching expandProjectsFilter),
  // never a silent empty result.
  const badQuery = spawnSync(process.execPath, [BIN, 'graph', 'query', 'file:main.mjs', '--projects=nonexistent-target', '--json'], {
    cwd: project, encoding: 'utf8', timeout: 60_000, env,
  });
  assert.notEqual(badQuery.status, 0, 'unknown project id must fail, not silently return empty');
  assert.match(badQuery.stderr, /unknown project/, 'error names the unknown project id');
});
