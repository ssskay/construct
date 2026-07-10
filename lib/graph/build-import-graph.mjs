/**
 * lib/graph/build-import-graph.mjs — static import-graph derivation.
 *
 * Walks lib/, bin/, scripts/, and tests/ for ESM/CJS source, parses each
 * file's relative import/export-from/dynamic-import/require specifiers, and
 * resolves them to repo-relative paths. Produces:
 *   file|test --imports--> file|test     (directed module dependency)
 *   file      --realizes--> capability   (derived: a capability's declared
 *                                         verification tests transitively reach
 *                                         the implementation files that realize it)
 * Test files (*.test.mjs) are typed `test` so they merge with the registry's
 * declared verification-test nodes. Bare and node: specifiers are ignored.
 * Pure-JS, no AST library, per ADR-0001 — a tolerant regex over import forms
 * is sufficient for this codebase's conventions.
 *
 * `sourceRoots` defaults to this repo's own lib/bin/scripts/tests convention;
 * a registered source target (construct-1smc4.2, lib/graph/build-target-
 * graph.mjs) has no such layout, so that caller passes `['']` to walk a
 * target's whole content root instead. SKIP_DIRS includes the same
 * vendored/build directories lib/knowledge/search.mjs's CODE_WALK_SKIP_DIRS
 * skips, so a target's import graph and its knowledge-search code corpus
 * agree on what counts as "source we index."
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_ROOTS = ['lib', 'bin', 'scripts', 'tests'];
const SOURCE_EXT = new Set(['.mjs', '.js', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'fixtures', '.git', '.cx', 'dist', 'build', 'vendor', '.venv', '__pycache__']);
const RESOLVE_ORDER = ['', '.mjs', '.js', '.cjs', '.json', '/index.mjs', '/index.js'];

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function isTestPath(rel) {
  return rel.endsWith('.test.mjs') || rel.endsWith('.test.js');
}

function nodeFor(rel) {
  return isTestPath(rel) ? { type: 'test', id: `test:${rel}` } : { type: 'file', id: `file:${rel}` };
}

function walk(rootDir, dirRel, acc) {
  const abs = path.join(rootDir, dirRel);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') { if (SKIP_DIRS.has(e.name)) continue; }
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dirRel ? path.join(dirRel, e.name) : e.name;
    if (e.isDirectory()) { walk(rootDir, rel, acc); continue; }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name);
    if (SOURCE_EXT.has(ext) || (dirRel === 'bin' && ext === '')) acc.push(rel);
  }
}

function extractSpecifiers(content) {
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveSpecifier(rootDir, importerRel, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const baseAbs = path.resolve(path.dirname(path.join(rootDir, importerRel)), spec);
  for (const suffix of RESOLVE_ORDER) {
    const cand = baseAbs + suffix;
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return path.relative(rootDir, cand).split(path.sep).join('/');
    } catch { /* keep trying */ }
  }
  return null;
}

function buildForwardAdj(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (e.rel !== 'imports') continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  return adj;
}

function closure(adj, startId) {
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    for (const to of adj.get(id) || []) {
      if (seen.has(to)) continue;
      seen.add(to);
      stack.push(to);
    }
  }
  return seen;
}

/**
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {object[]} [opts.validates] — validates edges (test→capability) from the
 *   registry build; these derive realizes (file→capability) via test closures.
 * @param {string[]} [opts.sourceRoots] — dirs under rootDir to walk, relative
 *   to rootDir. Defaults to this repo's lib/bin/scripts/tests convention;
 *   pass `['']` to walk rootDir itself (registered targets have no fixed layout).
 * @returns {{ nodes: object[], edges: object[] }}
 */
export function buildImportGraph({ rootDir, validates = [], sourceRoots = SOURCE_ROOTS }) {
  const files = [];
  for (const root of sourceRoots) walk(rootDir, root, files);
  files.sort();

  const nodes = [];
  const edges = [];
  const known = new Set(files);

  for (const rel of files) {
    const self = nodeFor(rel);
    nodes.push({ id: self.id, type: self.type, name: rel, attrs: { path: rel } });
  }

  for (const rel of files) {
    let content;
    try { content = readFileSync(path.join(rootDir, rel), 'utf8'); } catch { continue; }
    const fromNode = nodeFor(rel);
    const seen = new Set();
    for (const spec of extractSpecifiers(content)) {
      const target = resolveSpecifier(rootDir, rel, spec);
      if (!target || target === rel || seen.has(target)) continue;
      seen.add(target);
      const toNode = nodeFor(target);
      if (!known.has(target)) nodes.push({ id: toNode.id, type: toNode.type, name: target, attrs: { path: target } });
      edges.push({ from: fromNode.id, to: toNode.id, rel: 'imports', source: 'import-graph' });
    }
  }

  // Derive realizes: a capability's declared tests transitively reach the
  // implementation files that realize it. Intentionally over-inclusive — a
  // broad edge only widens impact, which is the safe direction for advisory use.

  const adj = buildForwardAdj(edges);
  const realizesSeen = new Set();
  for (const v of validates) {
    if (v.rel !== 'validates') continue;
    const testId = v.from;
    const capId = v.to;
    for (const reached of closure(adj, testId)) {
      if (!reached.startsWith('file:')) continue;
      const key = `${reached}->${capId}`;
      if (realizesSeen.has(key)) continue;
      realizesSeen.add(key);
      edges.push({ from: reached, to: capId, rel: 'realizes', source: 'import-graph' });
    }
  }

  return { nodes, edges };
}
