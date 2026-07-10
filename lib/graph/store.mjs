/**
 * lib/graph/store.mjs — typed, directed dependency-graph store.
 *
 * The substrate for Construct's living dependency matrix. Nodes are typed
 * entities (file, module, workflow, capability, test, contract, surface,
 * skill, rule, provider, tool, pack, doc, specialist, runtime-evidence) addressed
 * by canonical ids of the form `type:key`. Edges are directed and carry a
 * relation kind (imports, realizes, validates, covers, exposes, governed_by,
 * uses, embeds, co_changes, contains, requires, documents, evidenced_by,
 * owned_by) and a provenance source
 * (registry, import-graph, co-change, override, corpus-annotation, runtime-evidence).
 *
 * Persisted under `.cx/graph/` as deterministic JSONL so a graph round-trips
 * losslessly and diffs cleanly: nodes.jsonl (sorted by id), edges.jsonl
 * (sorted by from,rel,to), meta.json (generatedAt, sourceHash, counts).
 * Dependency-free and pure-JS per ADR-0001.
 *
 * `reads` (LMCP-E4): specialist --reads--> provider, seeded from pack
 * `embedBindings` grants (build-from-registry.mjs). Makes the embed
 * authority-guard's per-specialist read/search grant visible in
 * `construct graph`/`construct matrix` rather than living only in pack JSON.
 *
 * Per-target graphs (construct-1smc4.2): every read/write function accepts an
 * optional `targetId` that redirects the store to
 * `.cx/graph/targets/<targetId>/` instead of `.cx/graph/` — the same JSONL +
 * meta.json shape, the same atomic temp-then-rename write, just a sibling
 * directory per registered source target (lib/config/source-targets.mjs), so
 * a target's graph persists and round-trips exactly like the host graph and
 * survives a session restart the same way.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const NODE_TYPES = new Set([
  'file', 'module', 'workflow', 'capability', 'test', 'contract', 'surface', 'skill', 'rule',
  'provider', 'tool', 'pack', 'doc', 'specialist', 'runtime-evidence', 'embed',
]);

export const EDGE_RELS = new Set([
  'imports', 'realizes', 'validates', 'covers', 'exposes', 'governed_by', 'uses', 'embeds', 'co_changes', 'contains',
  'requires', 'documents', 'evidenced_by', 'owned_by', 'reads', 'secures',
]);

export const EDGE_SOURCES = new Set(['registry', 'import-graph', 'co-change', 'override', 'corpus-annotation', 'runtime-evidence', 'embed-manifest']);

const STORE_SUBDIR = path.join('.cx', 'graph');
const TARGETS_SUBDIR = 'targets';

export function graphDir(rootDir, targetId = null) {
  return targetId
    ? path.join(rootDir, STORE_SUBDIR, TARGETS_SUBDIR, targetId)
    : path.join(rootDir, STORE_SUBDIR);
}

export function nodeId(type, key) {
  return `${type}:${key}`;
}

function nodesPath(rootDir, targetId) { return path.join(graphDir(rootDir, targetId), 'nodes.jsonl'); }
function edgesPath(rootDir, targetId) { return path.join(graphDir(rootDir, targetId), 'edges.jsonl'); }
function metaPath(rootDir, targetId) { return path.join(graphDir(rootDir, targetId), 'meta.json'); }

/**
 * List every targetId with a persisted graph under `.cx/graph/targets/`, so
 * a `--projects=all` graph query knows which target stores to load without
 * re-resolving source targets from config.
 */
export function listTargetGraphIds(rootDir) {
  const dir = path.join(rootDir, STORE_SUBDIR, TARGETS_SUBDIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const out = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return out;
}

function writeAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, filePath);
}

// Canonical de-dup: nodes keyed by id (last write wins on attrs), edges keyed
// by from|rel|to (weights summed so repeated co-change observations accumulate).

function normalizeNodes(nodes) {
  const byId = new Map();
  for (const n of nodes) {
    if (!n?.id || !n?.type) continue;
    const prev = byId.get(n.id);
    byId.set(n.id, prev ? { ...prev, ...n, attrs: { ...(prev.attrs || {}), ...(n.attrs || {}) } } : { id: n.id, type: n.type, name: n.name ?? n.id, attrs: n.attrs || {} });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function edgeKey(e) { return `${e.from}|${e.rel}|${e.to}`; }

function normalizeEdges(edges) {
  const byKey = new Map();
  for (const e of edges) {
    if (!e?.from || !e?.to || !e?.rel) continue;
    const key = edgeKey(e);
    const prev = byKey.get(key);
    if (prev) {
      prev.weight = (prev.weight || 1) + (e.weight || 1);
      if (e.source && !prev.sources.includes(e.source)) prev.sources.push(e.source);
    } else {
      byKey.set(key, { from: e.from, to: e.to, rel: e.rel, weight: e.weight || 1, sources: e.source ? [e.source] : (e.sources || []) });
    }
  }
  return [...byKey.values()].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1));
}

function countBy(items, key) {
  const out = {};
  for (const it of items) { const k = it[key]; out[k] = (out[k] || 0) + 1; }
  return out;
}

/**
 * Persist a full graph (regenerate semantics). Nodes and edges are normalized
 * and sorted; meta records counts and the caller-supplied source hash.
 *
 * `sourceHashes` (LMCP-C6) is an optional `{ [sourceName]: hash }` map recording
 * a hash per seed source (registry, overlays, specialists/org, plugins,
 * provider manifests, workflow manifests) alongside the single combined
 * `sourceHash`, so staleness detection can name which source drifted instead
 * of only reporting "something changed".
 *
 * @param {string} rootDir
 * @param {{ nodes: object[], edges: object[], generatedAt?: string, sourceHash?: string, sourceHashes?: Record<string,string> }} graph
 * @param {{ targetId?: string|null }} [opts] — when set, writes to
 *   `.cx/graph/targets/<targetId>/` instead of `.cx/graph/`.
 * @returns {{ nodeCount: number, edgeCount: number, dir: string }}
 */
export function writeGraph(rootDir, { nodes = [], edges = [], generatedAt = null, sourceHash = null, sourceHashes = null } = {}, { targetId = null } = {}) {
  const dir = graphDir(rootDir, targetId);
  mkdirSync(dir, { recursive: true });
  const normNodes = normalizeNodes(nodes);
  const normEdges = normalizeEdges(edges);
  writeAtomic(nodesPath(rootDir, targetId), normNodes.map((n) => JSON.stringify(n)).join('\n') + (normNodes.length ? '\n' : ''));
  writeAtomic(edgesPath(rootDir, targetId), normEdges.map((e) => JSON.stringify(e)).join('\n') + (normEdges.length ? '\n' : ''));
  const meta = {
    schemaVersion: 1,
    generatedAt,
    sourceHash,
    sourceHashes: sourceHashes || null,
    nodeCount: normNodes.length,
    edgeCount: normEdges.length,
    nodesByType: countBy(normNodes, 'type'),
    edgesByRel: countBy(normEdges, 'rel'),
  };
  writeAtomic(metaPath(rootDir, targetId), JSON.stringify(meta, null, 2) + '\n');
  return { nodeCount: normNodes.length, edgeCount: normEdges.length, dir };
}

/**
 * Load the graph into an indexed, queryable view. Out/in adjacency maps make
 * forward (dependencies) and reverse (dependents) traversal O(degree).
 *
 * @param {string} rootDir
 * @param {{ targetId?: string|null }} [opts] — when set, loads
 *   `.cx/graph/targets/<targetId>/` instead of `.cx/graph/`.
 * @returns {{ nodes: Map<string,object>, edges: object[], out: Map<string,object[]>, in: Map<string,object[]>, meta: object|null, exists: boolean }}
 */
export function loadGraph(rootDir, { targetId = null } = {}) {
  const nodeList = readJsonl(nodesPath(rootDir, targetId));
  const edgeList = readJsonl(edgesPath(rootDir, targetId));
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaPath(rootDir, targetId), 'utf8')); } catch { /* no meta */ }

  const nodes = new Map();
  for (const n of nodeList) nodes.set(n.id, n);
  const out = new Map();
  const inc = new Map();
  for (const e of edgeList) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push(e);
    inc.get(e.to).push(e);
  }
  return { nodes, edges: edgeList, out, in: inc, meta, exists: existsSync(nodesPath(rootDir, targetId)) };
}

function filterRel(edges, rel) {
  if (!rel) return edges;
  const rels = Array.isArray(rel) ? new Set(rel) : new Set([rel]);
  return edges.filter((e) => rels.has(e.rel));
}

/**
 * Nodes that `id` points to along `rel` (its dependencies).
 */
export function dependenciesOf(graph, id, rel = null) {
  return filterRel(graph.out.get(id) || [], rel).map((e) => e.to);
}

/**
 * Nodes that point to `id` along `rel` (its dependents).
 */
export function dependentsOf(graph, id, rel = null) {
  return filterRel(graph.in.get(id) || [], rel).map((e) => e.from);
}

export function nodesByType(graph, type) {
  return [...graph.nodes.values()].filter((n) => n.type === type);
}
