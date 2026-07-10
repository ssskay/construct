/**
 * lib/graph/cli.mjs — `construct matrix` command surface.
 *
 * Subcommands:
 *   build              Regenerate the dependency graph from the registry,
 *                      corpus-annotation, embed-manifest (LMCP-P6), and static
 *                      import-graph seeds into <projectDir>/.cx/graph/.
 *   build-targets      Build + persist one import/symbol graph per registered
 *                      content-capable source target (construct-1smc4.2, see
 *                      lib/graph/build-target-graph.mjs), under
 *                      <projectDir>/.cx/graph/targets/<targetId>/. Distinct
 *                      from `build`, which only ever covers the host project.
 *   stat               Print node/edge counts by type and relation.
 *   query <id>         Print a node's dependencies and dependents.
 *   query --type <t>   List every node of one type with its dependencies
 *                      (e.g. `--type embed` enumerates the embed presets).
 *   query --missing-tests   List capabilities/workflows with zero inbound
 *                      validates edges (see lib/graph/gaps.mjs).
 *   query/query --type ... --projects=<id,...>|all|self   Scope a query to one
 *                      or more registered targets' persisted graphs (built by
 *                      `build-targets`) instead of the host graph — the same
 *                      `--projects` semantics `knowledge_search` uses
 *                      (lib/sources/content-roots.mjs's expandProjectsFilter).
 *   impacted --changed <files...>   Traverse from changed files to the
 *                      workflows/tests/docs they impact (see
 *                      lib/graph/impacted.mjs); scopes the CI drift gate.
 *   missing-tests [--security], missing-docs, stale, dependencies, providers,
 *                      surfaces   Read-only gap queries over the store (see
 *                      lib/graph/gap-queries.mjs). `missing-tests --security`
 *                      lists workflows/embed presets with no `secures` edge.
 *   owasp              OWASP GenAI Top-10 coverage matrix generated from the
 *                      graph's `@owasp`-tagged security tests (LMCP-N8, see
 *                      lib/graph/security-coverage.mjs).
 *   explain <workflow-id>   Full ownership picture, grouped by every
 *                      EDGE_RELS relation plus manifest roleChain (LMCP-C3):
 *                      absent-but-expected links print as MISSING, matching
 *                      `graph validate` findings. Also carries last-execution
 *                      runtime evidence and execution-staleness (LMCP-C9, see
 *                      lib/graph/runtime-evidence.mjs and the execution
 *                      dimension in lib/graph/staleness.mjs).
 *
 * Seeds are read from the Construct package root (rootDir); the graph is
 * persisted under the active project (projectDir) so it travels with .cx/.
 */

import { buildFromRegistry } from './build-from-registry.mjs';
import { buildImportGraph } from './build-import-graph.mjs';
import { buildCoChange } from './build-co-change.mjs';
import { buildFromCorpus } from './build-from-corpus.mjs';
import { buildFromEmbed } from './build-from-embed.mjs';
import { buildFromSecurity, buildOwaspMatrix, findWorkflowsMissingSecurity, OWASP_GENAI_TOP10 } from './security-coverage.mjs';
import { buildRuntimeEvidence } from './runtime-evidence.mjs';
import { writeGraph, loadGraph, dependenciesOf, dependentsOf, nodesByType, EDGE_RELS } from './store.mjs';
import { buildTargetGraphs, loadTargetGraph } from './build-target-graph.mjs';
import { validateGraph } from './validate.mjs';
import { findMissingTestCapabilities } from './gaps.mjs';
import { computeImpacted } from './impacted.mjs';
import { computeSourceHashes, checkExecutionStaleness } from './staleness.mjs';
import {
  findMissingDocs,
  findStale,
  findDependencies,
  findProviders,
  findSurfaces,
} from './gap-queries.mjs';
import { loadAllWorkflows } from '../workflows/loader.mjs';
import { checkWorkflowLiveness } from '../workflows/liveness.mjs';
import { loadProjectConfig } from '../config/project-config.mjs';
import { resolveEffectiveSourceTargetsFromConfig } from '../config/source-targets.mjs';
import { expandProjectsFilter, SELF_PROJECT_KEY } from '../sources/content-roots.mjs';

function isoNow() {
  return new Date().toISOString();
}

// `--projects` on `query`/`query --type` (construct-1smc4.2) reuses the exact
// filter-expansion lib/knowledge/search.mjs already established for
// `knowledge_search` — same targets, same `all`/`self`/id semantics, same
// unknown-id hard error — so a project id means one thing across both
// surfaces. An unresolvable id throws, which callers turn into a CLI error.

function parseProjectsArg(args) {
  const flag = args.find((a) => a.startsWith('--projects='));
  return flag ? flag.slice('--projects='.length) : null;
}

function resolveProjectsFilter(projectDir, projectsArg) {
  const { config } = loadProjectConfig(projectDir);
  const targets = resolveEffectiveSourceTargetsFromConfig(config);
  return expandProjectsFilter(projectsArg, targets);
}

// One graph per selected project key: `self` is the host graph
// (.cx/graph/), everything else is a target's persisted graph
// (.cx/graph/targets/<targetId>/, built by `graph build-targets`). A target
// never built yet loads with `exists: false` rather than throwing, so a
// caller sees which projects have no graph instead of a crash.

function loadSelectedGraphs(projectDir, filter) {
  const selected = [];
  if (filter.includeSelf) selected.push({ projectKey: SELF_PROJECT_KEY, graph: loadGraph(projectDir) });
  for (const targetId of filter.ids) selected.push({ projectKey: targetId, graph: loadTargetGraph(projectDir, targetId) });
  return selected;
}

function runBuild({ rootDir, projectDir, json, coChange }) {
  const reg = buildFromRegistry({ rootDir });
  const corpus = buildFromCorpus({ rootDir });

  // Embed presets + security tests and their annotations ship with the package,
  // so these seeders read from rootDir like buildFromRegistry/buildFromCorpus —
  // not projectDir, which holds only per-project runtime state (enablement,
  // evidence) and carries no tests/ tree.
  const embed = buildFromEmbed({ rootDir });
  const security = buildFromSecurity({ rootDir });

  // Only capability-targeted validates edges (registry + corpus) feed the
  // import graph's realizes derivation — it maps a capability to the files its
  // tests transitively reach. Embed/security edges have no such file
  // realization, so they are kept in the graph but withheld from this input.
  const validates = [...reg.edges, ...corpus.edges].filter((e) => e.rel === 'validates');
  const imp = buildImportGraph({ rootDir, validates });
  const nodes = [...reg.nodes, ...corpus.nodes, ...embed.nodes, ...security.nodes, ...imp.nodes];
  const edges = [...reg.edges, ...corpus.edges, ...embed.edges, ...security.edges, ...imp.edges];

  if (coChange) {
    const sourceRels = imp.nodes.filter((n) => n.type === 'file' || n.type === 'test').map((n) => n.name);
    const co = buildCoChange({ rootDir, sourceRels });
    nodes.push(...co.nodes);
    edges.push(...co.edges);
  }

  // Runtime evidence (LMCP-C9) reads persisted orchestration runs off the
  // active project (projectDir), not the Construct package root (rootDir) —
  // runs live under the embedding project's machine-scoped state root
  // (ADR-0066), keyed by projectDir.
  const evidence = buildRuntimeEvidence({ rootDir: projectDir });
  nodes.push(...evidence.nodes);
  edges.push(...evidence.edges);

  const sourceHash = reg.sourceHash;
  const sourceHashes = computeSourceHashes(projectDir);
  const result = writeGraph(projectDir, { nodes, edges, generatedAt: isoNow(), sourceHash, sourceHashes });
  const meta = loadGraph(projectDir).meta;
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...result, meta }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`✓ graph built: ${result.nodeCount} nodes, ${result.edgeCount} edges → ${result.dir}\n`);
  process.stdout.write(`  nodes: ${JSON.stringify(meta.nodesByType)}\n`);
  process.stdout.write(`  edges: ${JSON.stringify(meta.edgesByRel)}\n`);
  return 0;
}

// `build-targets` (construct-1smc4.2): one import/symbol graph per
// registered content-capable source target, persisted independently under
// `.cx/graph/targets/<targetId>/` so each target's graph survives a session
// restart the same way the host graph does. Distinct from `build`, which
// only ever covers the host project's own rootDir.

function runBuildTargets({ projectDir, json }) {
  const { built } = buildTargetGraphs({ projectDir });
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, targets: built }, null, 2) + '\n');
    return 0;
  }
  if (!built.length) {
    process.stdout.write('No content-capable registered targets found — nothing built.\n');
    return 0;
  }
  process.stdout.write(`✓ built ${built.length} target graph(s):\n`);
  for (const t of built) {
    process.stdout.write(`  ${t.targetId}: ${t.nodeCount} nodes, ${t.edgeCount} edges → ${t.dir}\n`);
  }
  return 0;
}

function runStat({ projectDir, json }) {
  const graph = loadGraph(projectDir);
  if (!graph.exists) {
    process.stderr.write('No graph found. Run `construct matrix build` first.\n');
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(graph.meta, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`graph: ${graph.nodes.size} nodes, ${graph.edges.length} edges (generated ${graph.meta?.generatedAt ?? 'unknown'})\n`);
  process.stdout.write(`  nodes: ${JSON.stringify(graph.meta?.nodesByType ?? {})}\n`);
  process.stdout.write(`  edges: ${JSON.stringify(graph.meta?.edgesByRel ?? {})}\n`);
  return 0;
}

function queryOneGraph(graph, id) {
  if (!graph.exists) return { graphPresent: false, found: false, node: null, dependencies: [], dependents: [] };
  const node = graph.nodes.get(id);
  return {
    graphPresent: true,
    found: !!node,
    node: node ?? null,
    dependencies: dependenciesOf(graph, id),
    dependents: dependentsOf(graph, id),
  };
}

function runQuery({ projectDir, id, json, projects }) {
  if (projects) {
    let filter;
    try { filter = resolveProjectsFilter(projectDir, projects); } catch (err) { process.stderr.write(`${err.message}\n`); return 1; }
    const results = loadSelectedGraphs(projectDir, filter).map(({ projectKey, graph }) => ({ projectKey, ...queryOneGraph(graph, id) }));
    const anyFound = results.some((r) => r.found);
    if (json) {
      process.stdout.write(JSON.stringify({ id, projects: results }, null, 2) + '\n');
      return anyFound ? 0 : 1;
    }
    for (const r of results) {
      if (!r.graphPresent) {
        process.stdout.write(`[${r.projectKey}] no graph found — run \`construct graph build-targets\` first\n`);
        continue;
      }
      if (!r.found) {
        process.stdout.write(`[${r.projectKey}] node not found: ${id}\n`);
        continue;
      }
      process.stdout.write(`[${r.projectKey}] ${id} (${r.node.type})\n`);
      process.stdout.write(`  → dependencies (${r.dependencies.length}): ${r.dependencies.join(', ') || '(none)'}\n`);
      process.stdout.write(`  ← dependents   (${r.dependents.length}): ${r.dependents.join(', ') || '(none)'}\n`);
    }
    return anyFound ? 0 : 1;
  }

  const graph = loadGraph(projectDir);
  if (!graph.exists) {
    process.stderr.write('No graph found. Run `construct matrix build` first.\n');
    return 1;
  }
  const node = graph.nodes.get(id);
  const deps = dependenciesOf(graph, id);
  const dependents = dependentsOf(graph, id);
  if (json) {
    process.stdout.write(JSON.stringify({ id, found: !!node, node: node ?? null, dependencies: deps, dependents }, null, 2) + '\n');
    return node ? 0 : 1;
  }
  if (!node) {
    process.stderr.write(`node not found: ${id}\n`);
    return 1;
  }
  process.stdout.write(`${id} (${node.type})\n`);
  process.stdout.write(`  → dependencies (${deps.length}): ${deps.join(', ') || '(none)'}\n`);
  process.stdout.write(`  ← dependents   (${dependents.length}): ${dependents.join(', ') || '(none)'}\n`);
  return 0;
}

// `query --type <t>` lists every node of one type with its outbound
// dependencies — the entry point the P6 acceptance uses to enumerate embed
// nodes (`--type embed`), but generic over any NODE_TYPES member.

function matchesForGraph(graph, type) {
  if (!graph.exists) return null;
  return nodesByType(graph, type).map((node) => ({
    id: node.id,
    node,
    dependencies: dependenciesOf(graph, node.id),
    dependents: dependentsOf(graph, node.id),
  }));
}

function runQueryByType({ projectDir, type, json, projects }) {
  if (projects) {
    let filter;
    try { filter = resolveProjectsFilter(projectDir, projects); } catch (err) { process.stderr.write(`${err.message}\n`); return 1; }
    const perProject = loadSelectedGraphs(projectDir, filter).map(({ projectKey, graph }) => ({
      projectKey,
      graphPresent: graph.exists,
      nodes: matchesForGraph(graph, type) ?? [],
    }));
    if (json) {
      process.stdout.write(JSON.stringify({ type, projects: perProject }, null, 2) + '\n');
      return 0;
    }
    for (const p of perProject) {
      if (!p.graphPresent) {
        process.stdout.write(`[${p.projectKey}] no graph found — run \`construct graph build-targets\` first\n`);
        continue;
      }
      process.stdout.write(`[${p.projectKey}] ${type} nodes (${p.nodes.length}):\n`);
      for (const m of p.nodes) {
        process.stdout.write(`  ${m.id}\n`);
        process.stdout.write(`    → ${m.dependencies.join(', ') || '(none)'}\n`);
      }
    }
    return 0;
  }

  const graph = loadGraph(projectDir);
  if (!graph.exists) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }
  const matches = matchesForGraph(graph, type);
  if (json) {
    process.stdout.write(JSON.stringify({ type, count: matches.length, nodes: matches }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`${type} nodes (${matches.length}):\n`);
  for (const m of matches) {
    process.stdout.write(`  ${m.id}\n`);
    process.stdout.write(`    → ${m.dependencies.join(', ') || '(none)'}\n`);
  }
  return 0;
}

// `missing-tests --security` (LMCP-N8): workflows with no inbound `secures`
// edge — the security-coverage gap list, distinct from the capability
// test-coverage gaps runMissingTests reports.

function runMissingSecurity({ projectDir, json }) {
  const gaps = findWorkflowsMissingSecurity(projectDir);
  if (!gaps.graphPresent) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(gaps, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`workflows with zero linked security tests (${gaps.workflows.length}):\n`);
  for (const id of gaps.workflows) process.stdout.write(`  ${id}\n`);
  return 0;
}

// `graph owasp` (LMCP-N8): the OWASP GenAI Top-10 coverage matrix, generated
// from the graph's security-test nodes. Every category is listed with its test
// count so uncovered categories are visible, not silently absent.

function runOwaspMatrix({ projectDir, json }) {
  const matrix = buildOwaspMatrix(projectDir);
  if (!matrix.graphPresent) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(matrix, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`OWASP GenAI Top-10 coverage (${OWASP_GENAI_TOP10.length} categories):\n`);
  for (const cat of matrix.categories) {
    const mark = cat.testCount === 0 ? '✗' : '✓';
    process.stdout.write(`  ${mark} ${cat.id} ${cat.name}: ${cat.testCount} test(s)\n`);
  }
  if (matrix.uncovered.length) process.stdout.write(`\nuncovered: ${matrix.uncovered.join(', ')}\n`);
  return 0;
}

function runMissingTests({ projectDir, json }) {
  const gaps = findMissingTestCapabilities(projectDir);
  if (!gaps.graphPresent) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(gaps, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`capabilities with zero validating tests (${gaps.capabilities.length}):\n`);
  for (const id of gaps.capabilities) process.stdout.write(`  ${id}\n`);
  process.stdout.write(`workflows with zero validated embedding capability (${gaps.workflows.length}):\n`);
  for (const id of gaps.workflows) process.stdout.write(`  ${id}\n`);
  return 0;
}

function parseChangedArg(args) {
  const idx = args.indexOf('--changed');
  if (idx === -1) return [];
  const rest = args.slice(idx + 1);
  const files = [];
  for (const a of rest) {
    if (a.startsWith('--')) break;
    files.push(a);
  }
  return files;
}

function runImpacted(args, { projectDir, json }) {
  const changed = parseChangedArg(args);
  if (changed.length === 0) {
    process.stderr.write('Usage: construct graph impacted --changed <file...> [--json]\n');
    return 1;
  }

  const result = computeImpacted({ rootDir: projectDir, changedFiles: changed });
  if (!result.graphPresent) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(`Changed: ${result.changed.length} file(s)\n`);
  process.stdout.write(`Impacted workflows (${result.impactedWorkflows.length}): ${result.impactedWorkflows.join(', ') || '(none)'}\n`);
  process.stdout.write(`Impacted capabilities (${result.impactedCapabilities.length}): ${result.impactedCapabilities.join(', ') || '(none)'}\n`);
  process.stdout.write(`Impacted tests (${result.impactedTests.length}):\n`);
  for (const t of result.impactedTests) process.stdout.write(`  ${t}\n`);
  process.stdout.write(`Impacted docs (${result.impactedDocs.length}):\n`);
  for (const d of result.impactedDocs) process.stdout.write(`  ${d}\n`);
  if (result.unknown.length) {
    process.stdout.write(`\n⚠ Not in graph (${result.unknown.length}): ${result.unknown.join(', ')}\n`);
  }
  return 0;
}

// `explain` renders every EDGE_RELS relation as its own question section
// (LMCP-C3) so a reader sees the workflow's full ownership picture — not just
// dependencies/providers/surfaces — in one call. A workflow node itself only
// carries direct `embeds` (inbound, from its capability) and `documents`
// (inbound, from docs) edges (see build-from-registry.mjs); every other
// relation a workflow can meaningfully answer (uses/governed_by/requires/
// exposes/reads) lives on the capability that embeds the workflow, so those
// sections reuse the same embeddingCapabilities aggregation gap-queries.mjs
// already computes (via findDependencies/findProviders/findSurfaces) rather
// than re-deriving it. Relations that are structurally file/module/specialist
// -level (imports, realizes, covers, contains, co_changes, owned_by,
// validates) never land on a workflow node in this schema (see
// build-from-registry.mjs's edge-shape comment) and are rendered
// `applicable: false` rather than MISSING — an absent link only signals a gap
// when the relation could exist.
// `roleChain` is manifest data, not a graph edge — EDGE_RELS has no roleChain
// member — so it is rendered as its own manifest-sourced section, resolved
// against the same checkWorkflowLiveness violations `graph validate` reports,
// so a MISSING/violation marker here always has a matching validate finding.

const WORKFLOW_LEVEL_RELS = new Set(['embeds', 'documents', 'uses', 'governed_by', 'requires', 'exposes', 'reads']);

function relLabel(rel) {
  return rel === 'requires' ? 'requires (via provider)' : rel;
}

// Builds one section per EDGE_RELS member. Relations sourced directly off the
// workflow node (embeds inbound, documents inbound) read the live graph;
// relations that only ever land on the embedding capability (uses,
// governed_by, requires, exposes, reads) reuse the gap-query aggregations so
// `explain` never disagrees with `dependencies`/`providers`/`surfaces`/
// `missing-docs`. A relation with zero applicable edges is reported as
// MISSING so the human/agent reader sees an explicit gap instead of a quietly
// empty list.

function buildEdgeSections(graph, workflowId, projectDir) {
  const deps = findDependencies(projectDir).workflows[workflowId] || { contracts: [], uses: [], requires: [] };
  const surfaces = findSurfaces(projectDir).workflows[workflowId] || [];
  const docs = findMissingDocs(projectDir);
  const embeddingCaps = dependentsOf(graph, workflowId, 'embeds');
  const reads = new Set();
  for (const capId of embeddingCaps) {
    for (const providerId of dependenciesOf(graph, capId, 'uses').filter((i) => i.startsWith('provider:'))) {
      for (const specId of dependentsOf(graph, providerId, 'reads')) reads.add(specId);
    }
  }

  const values = {
    embeds: embeddingCaps,
    documents: dependentsOf(graph, workflowId, 'documents'),
    uses: deps.uses,
    governed_by: deps.contracts,
    requires: deps.requires,
    exposes: surfaces,
    reads: [...reads].sort(),
  };

  const sections = [];
  for (const rel of EDGE_RELS) {
    const applicable = WORKFLOW_LEVEL_RELS.has(rel);
    const links = applicable ? (values[rel] ?? []) : [];
    sections.push({
      rel,
      label: relLabel(rel),
      links,
      missing: applicable && links.length === 0,
      applicable,
    });
  }
  // documents doubles as the missing-docs consistency check (LMCP-C5): a
  // workflow with zero inbound documents edges is already reported by
  // `graph missing-docs`, so mirror that exact membership test here.
  const documentsSection = sections.find((s) => s.rel === 'documents');
  if (documentsSection) documentsSection.missing = docs.workflows.includes(workflowId);

  return sections;
}

// roleChain is manifest-only (not an EDGE_RELS member): resolved against the
// merged workflow-manifest set and checkWorkflowLiveness so a MISSING/broken
// roleChain entry here always has a matching `graph validate` violation
// string to cross-check against (the bead's consistency-test requirement).

function buildRoleChainSection(workflowType, projectDir) {
  const { workflows } = loadAllWorkflows({ rootDir: projectDir });
  const manifest = workflows.find((m) => m.id === workflowType);
  const { violations } = checkWorkflowLiveness(workflows, { rootDir: projectDir });
  const ownViolations = violations.filter((v) => v.includes(`'${workflowType}'`) || (manifest?._filePath && v.startsWith(manifest._filePath)));
  const roleChain = Array.isArray(manifest?.roleChain) ? manifest.roleChain : [];
  return {
    rel: 'roleChain',
    label: 'roleChain',
    links: roleChain,
    missing: roleChain.length === 0,
    applicable: true,
    violations: ownViolations,
    provenance: manifest
      ? {
          source: manifest._source || 'unknown',
          filePath: manifest._filePath || null,
          shadows: manifest._shadowedBy || [],
        }
      : null,
  };
}

function runExplain(args, { projectDir, json }) {
  const id = args.slice(1).find((a) => !a.startsWith('--'));
  if (!id) {
    process.stderr.write('Usage: construct graph explain <workflow-id> [--json]\n');
    return 1;
  }
  const workflowId = id.startsWith('workflow:') ? id : `workflow:${id}`;
  const workflowType = workflowId.slice('workflow:'.length);

  const graph = loadGraph(projectDir);
  if (!graph.exists) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }
  const node = graph.nodes.get(workflowId);
  if (!node) {
    process.stderr.write(`workflow not found in graph: ${workflowId}\n`);
    return 1;
  }

  const deps = findDependencies(projectDir).workflows[workflowId] || { contracts: [], uses: [], requires: [] };
  const providers = findProviders(projectDir).workflows[workflowId] || [];
  const surfaces = findSurfaces(projectDir).workflows[workflowId] || [];
  const sections = buildEdgeSections(graph, workflowId, projectDir);
  const roleChainSection = buildRoleChainSection(workflowType, projectDir);
  const allSections = [...sections, roleChainSection];

  const execution = checkExecutionStaleness(projectDir);
  const executionState = execution.workflows[workflowType] || {
    lastExecution: null, neverExecuted: true, stale: false, ageDays: null, thresholdDays: null,
  };

  const result = {
    id: workflowId,
    node,
    dependencies: deps,
    providers,
    surfaces,
    sections: allSections,
    missing: allSections.filter((s) => s.missing).map((s) => s.rel),
    execution: executionState,
  };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(`${workflowId}\n`);
  for (const section of allSections) {
    if (!section.applicable) continue;
    if (section.missing) {
      process.stdout.write(`  ${section.label}: MISSING\n`);
    } else {
      process.stdout.write(`  ${section.label} (${section.links.length}): ${section.links.join(', ') || '(none)'}\n`);
    }
    if (section.violations?.length) {
      for (const v of section.violations) process.stdout.write(`    ! ${v}\n`);
    }
    if (section.provenance) {
      process.stdout.write(`    source: ${section.provenance.source} (${section.provenance.filePath || 'n/a'})\n`);
      for (const shadow of section.provenance.shadows) {
        process.stdout.write(`    overrides: ${shadow.source} (${shadow.filePath || 'n/a'})\n`);
      }
    }
  }
  process.stdout.write(`  contracts (${deps.contracts.length}): ${deps.contracts.join(', ') || '(none)'}\n`);
  process.stdout.write(`  uses      (${deps.uses.length}): ${deps.uses.join(', ') || '(none)'}\n`);
  process.stdout.write(`  requires  (${deps.requires.length}): ${deps.requires.join(', ') || '(none)'}\n`);
  process.stdout.write(`  providers (${providers.length}): ${providers.join(', ') || '(none)'}\n`);
  process.stdout.write(`  surfaces  (${surfaces.length}): ${surfaces.join(', ') || '(none)'}\n`);
  if (executionState.neverExecuted) {
    process.stdout.write('  execution: NEVER EXECUTED — no runtime evidence found\n');
  } else {
    const { lastExecution, stale, ageDays: age, thresholdDays } = executionState;
    process.stdout.write(`  execution: last run ${lastExecution.timestamp} (outcome: ${lastExecution.outcome}, run ${lastExecution.runId})\n`);
    process.stdout.write(`             age: ${age?.toFixed(1)}d / threshold: ${thresholdDays}d — ${stale ? 'STALE' : 'fresh'}\n`);
  }
  return 0;
}

// Uniform runner for the six read-only gap-query subcommands (C5): each
// query function takes projectDir and returns { graphPresent, ...payload };
// --json dumps the payload verbatim, non-JSON falls back to the same shape
// so a human running the command still sees structured field names.

function runGapQuery(queryFn, { projectDir, json }) {
  const result = queryFn(projectDir);
  if (!result.graphPresent) {
    process.stderr.write('No graph found. Run `construct graph build` first.\n');
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

function runValidate(args, { rootDir, projectDir }) {
  const strict = args.includes('--strict');
  const json = args.includes('--json');
  const result = validateGraph(projectDir || rootDir, { strict });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const err of result.errors) console.error(`  error: ${err}`);
    for (const warn of result.warnings) console.error(`  warn:  ${warn}`);
    for (const info of result.infos) console.log(`  info:  ${info}`);
    if (result.errors.length > 0) {
      console.error(`\n  ✖ ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
    } else if (result.warnings.length > 0) {
      console.log(`\n  ✓ ${result.warnings.length} warning(s)`);
    } else {
      console.log('\n  ✓ graph is valid');
    }
  }

  process.exit(result.errors.length > 0 ? 1 : 0);
}

/**
 * @param {string[]} args
 * @param {{ rootDir: string, projectDir: string }} ctx
 * @returns {number} exit code
 */
export function runGraphCli(args, { rootDir, projectDir }) {
  const sub = args[0] || 'stat';
  const json = args.includes('--json');
  const projects = parseProjectsArg(args);
  if (sub === 'build') return runBuild({ rootDir, projectDir, json, coChange: !args.includes('--no-co-change') });
  if (sub === 'build-targets') return runBuildTargets({ projectDir, json });
  if (sub === 'query') {
    if (args.includes('--missing-tests')) return runMissingTests({ projectDir, json });
    const typeIdx = args.indexOf('--type');
    if (typeIdx !== -1) {
      const type = args[typeIdx + 1];
      if (!type || type.startsWith('--')) {
        process.stderr.write('Usage: construct graph query --type <node-type> [--projects=<id,...>|all|self] [--json]\n');
        return 1;
      }
      return runQueryByType({ projectDir, type, json, projects });
    }
    const id = args.slice(1).find((a) => !a.startsWith('--'));
    if (!id) {
      process.stderr.write('Usage: construct graph query <node-id> | --type <node-type> [--projects=<id,...>|all|self] [--json]\n');
      return 1;
    }
    return runQuery({ projectDir, id, json, projects });
  }
  if (sub === 'validate') {
    return runValidate(args, { rootDir, projectDir });
  }
  if (sub === 'impacted') return runImpacted(args, { projectDir, json });
  if (sub === 'owasp') return runOwaspMatrix({ projectDir, json });
  if (sub === 'missing-tests') {
    if (args.includes('--security')) return runMissingSecurity({ projectDir, json });
    return runMissingTests({ projectDir, json });
  }
  if (sub === 'missing-docs') return runGapQuery(findMissingDocs, { projectDir, json });
  if (sub === 'stale') return runGapQuery(findStale, { projectDir, json });
  if (sub === 'dependencies') return runGapQuery(findDependencies, { projectDir, json });
  if (sub === 'providers') return runGapQuery(findProviders, { projectDir, json });
  if (sub === 'surfaces') return runGapQuery(findSurfaces, { projectDir, json });
  if (sub === 'explain') return runExplain(args, { projectDir, json });
  process.stderr.write(`Unknown graph subcommand: ${sub}. Available: build, build-targets, stat, query, validate, impacted, missing-tests, missing-docs, stale, dependencies, providers, surfaces, explain\n`);
  return 1;
}
