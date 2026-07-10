/**
 * tests/functional/knowledge-search-code-federation.functional.test.mjs —
 * registered directory targets' CODE files (not just markdown) join the
 * knowledge corpus with origin attribution (construct-1smc4.1).
 *
 * Today walkMarkdown()/loadMarkdownChunks() fold only `**\/*.md` from a
 * registered target's content root. Real repos have source code
 * (.ts/.py/.go/...) that the federation never surfaced, so `knowledge_search`
 * and `construct knowledge search --projects=<id>` could never answer
 * "what does this function do" for a registered repo. This test builds TWO
 * fixture "repos" as local tmpdir directories (no git, no network, no real
 * clone) — each registered as a `directory` source target — and asserts:
 *
 *   1. A distinctive symbol that lives ONLY in repo A's `.py` file is
 *      retrievable via knowledgeSearch() and carries origin.kind:'code' plus
 *      the correct targetId/projectKey (attribution, not just presence).
 *   2. The same symbol is NOT retrievable when `--projects` (the `projects`
 *      option) is scoped to repo B only — proving --projects filtering
 *      applies to code hits exactly like it already does for markdown hits.
 *   3. A distinctive symbol in repo B's `.go` file is retrievable and
 *      attributed to repo B.
 *   4. Non-UTF8_TEXT_EXTS files (e.g. a `.bin` fixture) and vendored/
 *      dependency directories (`node_modules/`) are excluded from the corpus.
 *   5. `construct knowledge search --projects=<id>` (the CLI surface backing
 *      knowledge_search) round-trips the same attribution end-to-end via the
 *      real binary, with zero outbound network.
 *
 * Sterile: no real github clone, no network. Repos are plain directories.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { knowledgeSearch } from '../../lib/knowledge/search.mjs';
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

const REPO_A_MARKER = 'zqfrobnicatePythonHandler';
const REPO_B_MARKER = 'xkGopherRouteDispatcher';

function makeRepoA() {
  const dir = freshDir('cx-code-fed-a-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'handler.py'),
    [
      'def zqfrobnicatePythonHandler(request):',
      '    """Repo A distinctive handler — only exists in repo A."""',
      '    return request.frobnicate()',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo A\n\nA docs-only readme, unrelated to code markers.\n');
  // Vendored dependency dir must be excluded from the code corpus.
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), `const ${REPO_A_MARKER}Vendored = 1;\n`);
  // Non-UTF8_TEXT_EXTS binary fixture must be excluded.
  fs.writeFileSync(path.join(dir, 'asset.bin'), Buffer.from([0, 1, 2, 3, 255, 254]));
  return dir;
}

function makeRepoB() {
  const dir = freshDir('cx-code-fed-b-');
  fs.mkdirSync(path.join(dir, 'internal'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'internal', 'router.go'),
    [
      'package internal',
      '',
      '// xkGopherRouteDispatcher is repo B\'s distinctive dispatcher — only in repo B.',
      'func xkGopherRouteDispatcher(path string) string {',
      '\treturn path',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo B\n\nA docs-only readme, unrelated to code markers.\n');
  return dir;
}

test('registered directory targets: code files join the corpus with origin attribution (unit)', () => {
  const repoA = makeRepoA();
  const repoB = makeRepoB();
  const project = freshDir('cx-code-fed-proj-');
  fs.writeFileSync(path.join(project, 'construct.config.json'), JSON.stringify({
    version: 1,
    sources: {
      targets: [
        { id: 'repo-a', provider: 'directory', selector: { path: repoA } },
        { id: 'repo-b', provider: 'directory', selector: { path: repoB } },
      ],
    },
  }, null, 2));

  const resultA = knowledgeSearch({ query: REPO_A_MARKER, repoRoot: REPO_ROOT, rootDir: project, topK: 5, minScore: 0 });
  assert.equal(resultA.ok, true, `search failed: ${resultA.message}`);
  assert.ok(resultA.hits.length > 0, 'repo A code marker must be found');
  const hitA = resultA.hits[0];
  assert.equal(hitA.origin.kind, 'code', 'code hit must carry origin.kind: code');
  assert.equal(hitA.origin.targetId, 'repo-a', 'code hit attributed to repo-a target');
  assert.equal(hitA.origin.projectKey, 'repo-a');
  assert.match(hitA.file, /handler\.py$/, `expected .py file, got ${hitA.file}`);
  assert.ok(hitA.text.includes(REPO_A_MARKER), 'chunk text contains the marker');

  const resultB = knowledgeSearch({ query: REPO_B_MARKER, repoRoot: REPO_ROOT, rootDir: project, topK: 5, minScore: 0 });
  assert.equal(resultB.ok, true, `search failed: ${resultB.message}`);
  assert.ok(resultB.hits.length > 0, 'repo B code marker must be found');
  const hitB = resultB.hits[0];
  assert.equal(hitB.origin.kind, 'code');
  assert.equal(hitB.origin.targetId, 'repo-b');
  assert.match(hitB.file, /router\.go$/, `expected .go file, got ${hitB.file}`);

  // Vendored/binary exclusion: neither the node_modules-nested vendored marker
  // nor the .bin fixture should ever surface, even unscoped and score-free.
  const allChunks = knowledgeSearch({ query: 'frobnicate route dispatcher vendored asset', repoRoot: REPO_ROOT, rootDir: project, topK: 100, minScore: 0 });
  assert.ok(allChunks.hits.every((h) => !h.file.includes('node_modules')), 'node_modules must be excluded from the code corpus');
  assert.ok(allChunks.hits.every((h) => !h.file.endsWith('.bin')), '.bin fixture must be excluded (not in UTF8_TEXT_EXTS)');
});

test('--projects scoping applies to code hits exactly like markdown hits (unit)', () => {
  const repoA = makeRepoA();
  const repoB = makeRepoB();
  const project = freshDir('cx-code-fed-proj2-');
  fs.writeFileSync(path.join(project, 'construct.config.json'), JSON.stringify({
    version: 1,
    sources: {
      targets: [
        { id: 'repo-a', provider: 'directory', selector: { path: repoA } },
        { id: 'repo-b', provider: 'directory', selector: { path: repoB } },
      ],
    },
  }, null, 2));

  const scopedToB = knowledgeSearch({
    query: REPO_A_MARKER,
    repoRoot: REPO_ROOT,
    rootDir: project,
    topK: 5,
    projects: 'repo-b',
  });
  assert.equal(scopedToB.ok, true, `search failed: ${scopedToB.message}`);
  // scoreChunk's priority-1 bonus is flat (not gated on a term match), so an
  // unrelated priority-1 markdown chunk from the in-scope repo can surface
  // even for an off-topic query — a pre-existing scoring property, not a
  // filter leak. The isolation guarantee under test is narrower and absolute:
  // no hit — code or markdown — may ever be attributed to a targetId outside
  // the --projects scope, and repo A's code chunk (the one containing the
  // query marker) must never appear when scoped away from repo A.
  assert.ok(scopedToB.hits.every((h) => h.origin.targetId === 'repo-b'), 'no hit may be attributed to a target outside the --projects scope');
  assert.ok(scopedToB.hits.every((h) => h.origin.kind !== 'code'), 'repo A\'s code chunk (holding the query marker) must not surface when scoped to repo B only');

  const scopedToA = knowledgeSearch({
    query: REPO_A_MARKER,
    repoRoot: REPO_ROOT,
    rootDir: project,
    topK: 5,
    projects: 'repo-a',
  });
  assert.ok(scopedToA.hits.length > 0, 'repo A marker must surface when --projects scopes to repo A');
  assert.equal(scopedToA.hits[0].origin.targetId, 'repo-a');
  assert.equal(scopedToA.hits[0].origin.kind, 'code');
});

test('construct knowledge search --projects=<id> round-trips code attribution through the real binary (zero network)', () => {
  const repoA = makeRepoA();
  const repoB = makeRepoB();
  const project = freshDir('cx-code-fed-cli-');
  fs.writeFileSync(path.join(project, 'construct.config.json'), JSON.stringify({
    version: 1,
    sources: {
      targets: [
        { id: 'repo-a', provider: 'directory', selector: { path: repoA } },
        { id: 'repo-b', provider: 'directory', selector: { path: repoB } },
      ],
    },
  }, null, 2));

  const PRELOAD = path.join(os.tmpdir(), `cx-code-fed-fetch-spy-${process.pid}.mjs`);
  fs.writeFileSync(PRELOAD, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  try { appendFileSync(process.env.FETCH_SPY_OUT, String(url) + '\\n'); } catch {}
  return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
};
`);
  test.after(() => { try { fs.rmSync(PRELOAD, { force: true }); } catch {} });

  const spyOut = path.join(project, 'fetch-calls.json');
  fs.writeFileSync(spyOut, '');

  const res = spawnSync(process.execPath, ['--import', PRELOAD, BIN, 'knowledge', 'search', REPO_B_MARKER, '--projects=repo-b'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: project,
      USERPROFILE: project,
      FETCH_SPY_OUT: spyOut,
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
    },
  });

  assert.equal(res.status, 0, `knowledge search failed: ${res.stderr}`);
  assert.match(res.stdout, /router\.go/, `expected router.go in CLI output, got: ${res.stdout}`);
  assert.match(res.stdout, /«repo-b»/, 'CLI output must show the repo-b project attribution badge');

  const calls = fs.readFileSync(spyOut, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(calls, [], 'zero outbound network calls for a local directory target search');
});
