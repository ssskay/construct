/**
 * tests/knowledge-multiroot.test.mjs — unit coverage for multi-root corpus
 * origin threading (bead construct-760c.2) and code-file federation
 * (construct-1smc4.1).
 *
 * Covers the two pure layers under the functional test:
 *   - lib/sources/content-roots.mjs: content-capable target resolution and the
 *     --projects filter expansion (all / self / unknown-id).
 *   - lib/knowledge/rag.mjs buildCorpus: host chunks carry the reserved self
 *     origin; registered-root chunks carry their target's origin plus per-file
 *     relPath; the single-root signature stays back-compatible (R1); code
 *     files (UTF8_TEXT_EXTS) fold in alongside markdown, excluding
 *     node_modules and non-text extensions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveContentRoots, expandProjectsFilter, isContentCapableTarget, SELF_PROJECT_KEY } from '../lib/sources/content-roots.mjs';
import { buildCorpus } from '../lib/knowledge/rag.mjs';
import { rmTmpDir } from './helpers/cleanup.mjs';

const tmp = [];
test.after(() => { for (const d of tmp) { try { rmTmpDir(d); } catch {} } });
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(dir);
  return dir;
}

const dirTarget = (id, dir) => ({ id, provider: 'directory', selector: { path: dir } });

test('resolveContentRoots: directory targets resolve to their path with origin', () => {
  const docs = freshDir('cx-mr-dir-');
  const roots = resolveContentRoots([dirTarget('proj-app', docs)], { projectRoot: docs });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].dir, docs);
  assert.deepEqual(roots[0].origin, { targetId: 'proj-app', provider: 'directory', projectKey: 'proj-app', ref: null });
});

test('resolveContentRoots: a directory that vanished is silently omitted', () => {
  const gone = path.join(os.tmpdir(), 'cx-mr-nonexistent-xyz');
  const roots = resolveContentRoots([dirTarget('proj-gone', gone)], { projectRoot: os.tmpdir() });
  assert.equal(roots.length, 0);
});

test('resolveContentRoots: a plain (non-content) target contributes no root', () => {
  const plain = { id: ' jira-x'.trim(), provider: 'jira', selector: { project: 'ABC' } };
  assert.equal(isContentCapableTarget(plain), false);
  assert.equal(resolveContentRoots([plain], { projectRoot: os.tmpdir() }).length, 0);
});

test('expandProjectsFilter: all expands to every content-capable target id', () => {
  const targets = [dirTarget('a', '/x'), dirTarget('b', '/y'), { id: 'j', provider: 'jira', selector: { project: 'P' } }];
  const { ids, includeSelf } = expandProjectsFilter('all', targets);
  assert.deepEqual([...ids].sort(), ['a', 'b']);
  assert.equal(includeSelf, false);
});

test('expandProjectsFilter: self sets includeSelf, a named id joins the set', () => {
  const targets = [dirTarget('a', '/x')];
  const { ids, includeSelf } = expandProjectsFilter('self,a', targets);
  assert.equal(includeSelf, true);
  assert.ok(ids.has('a'));
});

test('expandProjectsFilter: an unknown id throws naming the known projects (R3)', () => {
  const targets = [dirTarget('a', '/x')];
  assert.throws(() => expandProjectsFilter('nope', targets), /unknown project "nope".*a/s);
});

test('buildCorpus: single-root signature keeps host chunks tagged self (R1 back-compat)', () => {
  const host = freshDir('cx-mr-host-');
  fs.mkdirSync(path.join(host, '.cx', 'knowledge', 'internal'), { recursive: true });
  fs.writeFileSync(path.join(host, '.cx', 'knowledge', 'internal', 'note.md'), '# Host note\n\nhostmarkerword content.\n');

  const corpus = buildCorpus(host);
  assert.ok(corpus.length > 0, 'host corpus non-empty');
  assert.ok(corpus.every((c) => c.origin && c.origin.projectKey === SELF_PROJECT_KEY), 'every host chunk is self-origin');
  assert.ok(corpus.every((c) => c.origin.targetId === null), 'host chunks have null targetId');
});

test('buildCorpus: registered roots fold in with their own origin + per-file relPath', () => {
  const host = freshDir('cx-mr-host2-');
  const appDocs = freshDir('cx-mr-app-');
  fs.mkdirSync(path.join(appDocs, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(appDocs, 'sub', 'guide.md'), '# Guide\n\nappmarkerword content.\n');

  const roots = resolveContentRoots([dirTarget('proj-app', appDocs)], { projectRoot: host });
  const corpus = buildCorpus(host, { roots });

  const appChunk = corpus.find((c) => c.origin?.targetId === 'proj-app');
  assert.ok(appChunk, 'a chunk from the registered target is present');
  assert.equal(appChunk.origin.provider, 'directory');
  assert.equal(appChunk.origin.projectKey, 'proj-app');
  assert.equal(appChunk.origin.relPath, path.join('sub', 'guide.md'));
});

test('buildCorpus: registered roots also fold in code files (construct-1smc4.1)', () => {
  const host = freshDir('cx-mr-host3-');
  const appRepo = freshDir('cx-mr-code-');
  fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(appRepo, 'src', 'main.py'), 'def zqmarkerCodeFn():\n    return "codemarkerword"\n');
  fs.writeFileSync(path.join(appRepo, 'README.md'), '# App\n\nappmarkerword content.\n');
  fs.mkdirSync(path.join(appRepo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(appRepo, 'node_modules', 'dep', 'index.js'), 'const vendoredMarker = 1;\n');
  fs.writeFileSync(path.join(appRepo, 'notes.bin'), Buffer.from([0, 1, 2]));

  const roots = resolveContentRoots([dirTarget('proj-code', appRepo)], { projectRoot: host });
  const corpus = buildCorpus(host, { roots });

  const codeChunk = corpus.find((c) => c.source === 'target-code' && c.origin?.targetId === 'proj-code');
  assert.ok(codeChunk, 'a code chunk from the registered target is present');
  assert.equal(codeChunk.origin.provider, 'directory');
  assert.equal(codeChunk.origin.projectKey, 'proj-code');
  assert.equal(codeChunk.origin.relPath, path.join('src', 'main.py'));
  assert.equal(codeChunk.origin.kind, 'code');
  assert.ok(codeChunk.body.includes('zqmarkerCodeFn'));

  assert.ok(corpus.every((c) => !(c.filePath ?? '').includes('node_modules')), 'node_modules excluded from code chunks');
  assert.ok(corpus.every((c) => !(c.filePath ?? '').endsWith('.bin')), '.bin excluded (not in UTF8_TEXT_EXTS)');
});
