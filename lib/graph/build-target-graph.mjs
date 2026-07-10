/**
 * lib/graph/build-target-graph.mjs — import/symbol graph per registered source target.
 *
 * build-import-graph.mjs only ever walked the host project's own rootDir
 * (lib/bin/scripts/tests). This extends it to registered directory/github
 * source targets (construct.config.json sources.targets[],
 * lib/config/source-targets.mjs), resolving targets to on-disk content roots
 * via lib/sources/content-roots.mjs — the exact same resolution path
 * construct-1smc4.1 wired into lib/knowledge/search.mjs, so a target id means
 * the same thing here as it does in `knowledge_search`/`--projects`. No new
 * target-resolution logic is introduced.
 *
 * A target root has no fixed lib/bin/scripts/tests layout, so buildImportGraph
 * is called with `sourceRoots: ['']` to walk the whole root. Every emitted
 * node is tagged `attrs.origin` with the same shape
 * (targetId/provider/projectKey/kind) lib/knowledge/search.mjs stamps on
 * corpus chunks, so a target's graph and its knowledge-search hits attribute
 * to the same target consistently.
 *
 * Each target's graph is persisted independently under
 * `.cx/graph/targets/<targetId>/` (lib/graph/store.mjs's `targetId` param) —
 * the same JSONL + meta.json shape and atomic temp-then-rename write the host
 * graph uses — so it round-trips and survives a session restart the same way.
 * `validates` (test→capability) edges are host-project registry state and do
 * not apply to a foreign target, so `realizes` edges are not derived here.
 */

import { buildImportGraph } from './build-import-graph.mjs';
import { writeGraph, loadGraph, listTargetGraphIds } from './store.mjs';
import { resolveEffectiveSourceTargetsFromConfig } from '../config/source-targets.mjs';
import { resolveContentRoots } from '../sources/content-roots.mjs';
import { loadProjectConfig } from '../config/project-config.mjs';

function isoNow() {
  return new Date().toISOString();
}

function tagOrigin(nodes, origin) {
  return nodes.map((n) => ({ ...n, attrs: { ...(n.attrs || {}), origin } }));
}

/**
 * Resolve every content-capable registered target for `projectDir` and
 * build + persist one import graph per target.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {object} [opts.env]
 * @returns {{ built: { targetId: string, nodeCount: number, edgeCount: number, dir: string }[] }}
 */
export function buildTargetGraphs({ projectDir, env = process.env }) {
  const { config } = loadProjectConfig(projectDir, env);
  const targets = resolveEffectiveSourceTargetsFromConfig(config, env);
  const roots = resolveContentRoots(targets, { projectRoot: projectDir });

  const built = [];
  for (const root of roots) {
    const targetId = root.origin.targetId;
    const origin = { ...root.origin, kind: 'code' };
    const { nodes, edges } = buildImportGraph({ rootDir: root.dir, sourceRoots: [''] });
    const taggedNodes = tagOrigin(nodes, origin);
    const result = writeGraph(projectDir, { nodes: taggedNodes, edges, generatedAt: isoNow() }, { targetId });
    built.push({ targetId, ...result });
  }

  return { built };
}

/**
 * Load a single target's persisted graph (see lib/graph/store.mjs's
 * `loadGraph`). Returns `{ exists: false, ... }` if the target has never
 * been built.
 */
export function loadTargetGraph(projectDir, targetId) {
  return loadGraph(projectDir, { targetId });
}

/**
 * List every targetId with a persisted graph under this project.
 */
export function listBuiltTargetIds(projectDir) {
  return listTargetGraphIds(projectDir);
}
