/**
 * 02-deadcode.mjs — Phase 2: lib modules with no inbound reference.
 *
 * Builds the import graph over the whole repo — including buildable app packages
 * whose source consumes lib contract modules — from static
 * `from`/side-effect imports and dynamic `import('<literal>')`, and reports lib modules
 * nothing references. Construct
 * dispatches heavily through dynamic imports, so the graph must include those or it would
 * flag live code; modules reachable only by a computed (non-literal) import path can't be
 * proven dead and are reported separately, never as a hard finding.
 *
 * Entries excluded from the dead set (reached by mechanism, not by import edge):
 *   - bin/construct and the package `exports` map;
 *   - lib/hooks/** (the dispatcher loads these by constructed path);
 *   - lib/mcp/tools/*.tool.mjs (LMCP-B5: lib/mcp/tool-registry.mjs's scanToolModules
 *     discovers every file matching this suffix by directory scan, never by a literal
 *     import path or filename reference — that is the entire point of the convention,
 *     so a self-registered tool can never show a static/dynamic import edge to itself);
 *   - index.mjs / mod entry files.
 *
 * Read-only. Run: node scripts/audit/02-deadcode.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './lib/handlers.mjs';
import { writeJson } from './lib/artifacts.mjs';
import { recordFindings } from './lib/findings.mjs';

const SRC_DIRS = ['lib', 'bin', 'scripts', 'tests', 'apps'];

const EXCLUDE = /(node_modules|\.git|audit-artifacts|apps\/[^/]+\/out(?:\/|$)|apps\/[^/]+\/\.next(?:\/|$))/;

// bin/construct is the primary importer (124 dynamic imports) but has no extension, so it
// must be added explicitly or every lazily-imported module looks dead.

const EXTRA_SOURCES = ['bin/construct'];

// Modules launched by PATH from outside the JS import graph — a package.json script, a
// Dockerfile CMD, or a beads git-hook — are reachable even with zero import edges. Their
// repo-relative path appears verbatim in one of these manifests.

const LAUNCH_SOURCES = ['package.json', 'Dockerfile', 'Dockerfile.worker',
  '.beads/hooks/post-merge', '.beads/hooks/pre-push', '.beads/hooks/post-checkout'];

// Confirmed not-dead despite test-only import edges: each is reached by a mechanism the
// graph cannot see (external host plugin, computed-path subprocess) or is intentional
// infrastructure consumed by a CI gate. Recorded here with the reason so the disposition
// is auditable and NEW test-only modules still surface as findings.

const ACCEPTED_TEST_ONLY = {
  'lib/beads/auto-close.mjs': 'entrypoint: the .beads/hooks/post-merge git hook runs it on merge',
  'lib/opencode-runtime-plugin.mjs': 'entrypoint: loaded by the OpenCode host at runtime as a plugin, by path',
  'lib/worker/entrypoint.mjs': 'staged entrypoint for the team/enterprise worker plane (bead construct-9dx); not wired in solo',
  'lib/audit-rules.mjs': 'CI gate: rules-corpus reference audit, asserted from tests',
  'lib/evals/retrieval-bench.mjs': 'CI eval harness: retrieval recall/precision/MRR regression gate',
  'lib/template-registry.mjs': 'canonical specialist↔template map; a drift gate asserts it from tests',
  'lib/templates/visual-requirements.mjs': 'doc visual postcondition specs; a gate asserts them from tests',
  'lib/engine/tokens.mjs': 'token-count utility with a test contract; retained for budget enforcement',
  'lib/deprecate.mjs': 'single-warning deprecation utility with a test contract; retained for API retirements',
  'lib/storage/rrf.mjs': 'reciprocal-rank-fusion primitive with a correctness test; retained for hybrid retrieval',
  'lib/task-graph/schema.mjs': 'task-graph node/edge schema constants with a validation test; retained for the task-graph store',
  'lib/providers/contract/contract-tests.mjs': 'contract harness: imported by tests/provider-*.test.mjs for ADR-0003 provider interface validation',
  'lib/providers/contract/registry.mjs': 'contract harness: ProviderRegistry for embed-snapshot and provider-framework tests',
  'lib/visual-review.mjs': 'human visual-review verdict recorder for the human-reviewed gate level; its no-forgery contract is asserted from tests, and auto-calling it would forge a verdict, so the interactive review entry is staged (not wired in solo)',
  'lib/pixel-regression.mjs': 'pixel-diff harness for the full-certification gate; gated to that level (never fast/standard) and asserted from tests/certification, with golden regeneration as the only sanctioned writer',
};

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (EXCLUDE.test(full)) continue;
    if (e.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let abs = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  for (const ext of ['.mjs', '.js']) if (fs.existsSync(abs + ext)) return abs + ext;
  for (const idx of ['index.mjs', 'index.js']) if (fs.existsSync(path.join(abs, idx))) return path.join(abs, idx);
  return null;
}

export function runDeadCode() {
  const sources = [
    ...SRC_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d), ['.mjs', '.js', '.jsx', '.tsx'])),
    ...EXTRA_SOURCES.map((f) => path.join(REPO_ROOT, f)).filter((f) => fs.existsSync(f)),
  ];
  const libFiles = sources.filter((f) => f.startsWith(path.join(REPO_ROOT, 'lib') + path.sep) && /\.mjs$/.test(f));

  const referenced = new Set();
  let hasComputedImport = false;
  const computedImporters = new Set();
  const corpusByFile = new Map();
  for (const file of sources) {
    const src = fs.readFileSync(file, 'utf8');
    corpusByFile.set(file, src);
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveSpec(file, m[1]);
      if (resolved) referenced.add(resolved);
    }
    if (/import\(\s*[^'"`)]/.test(src)) { hasComputedImport = true; computedImporters.add(path.relative(REPO_ROOT, file)); }
  }

  // Construct also dispatches modules as subprocesses (runNodeScript / spawn with a path
  // built from segments), so a module whose basename appears as a string in any OTHER
  // source file is reachable even with no import edge.

  const referencedByName = (f) => {
    const base = path.basename(f);
    for (const [src, content] of corpusByFile) {
      if (src === f) continue;
      if (content.includes(base)) return true;
    }
    return false;
  };

  // A module's repo-relative path appearing in a launch manifest proves it is started by
  // path; matching the full path (not the basename) avoids server.mjs-style collisions.

  const launchCorpus = LAUNCH_SOURCES
    .map((rel) => path.join(REPO_ROOT, rel))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
  const launchReferenced = (f) => launchCorpus.includes(path.relative(REPO_ROOT, f));

  const isEntry = (f) => /\/lib\/hooks\//.test(f) || /\/index\.mjs$/.test(f) ||
    f === path.join(REPO_ROOT, 'lib', 'embedded-contract', 'index.mjs') ||
    /\/lib\/mcp\/tools\/[^/]+\.tool\.mjs$/.test(f);

  const dead = libFiles
    .filter((f) => !referenced.has(f) && !isEntry(f) && !referencedByName(f) && !launchReferenced(f))
    .map((f) => path.relative(REPO_ROOT, f));

  const testOnly = libFiles
    .filter((f) => referenced.has(f) && !isEntry(f) && !launchReferenced(f))
    .filter((f) => !(path.relative(REPO_ROOT, f) in ACCEPTED_TEST_ONLY))
    .filter((f) => {
      const importers = sources.filter((s) => {
        const src = corpusByFile.get(s);
        if (!src) return false;
        return [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].some((m) => resolveSpec(s, m[1]) === f);
      });
      return importers.length > 0 && importers.every((s) => /\/tests\//.test(s) || s === f);
    })
    .map((f) => path.relative(REPO_ROOT, f));

  return { libCount: libFiles.length, dead, testOnly, hasComputedImport, computedImporters: [...computedImporters].length };
}

function toFindings(report) {
  const rows = [];
  for (const f of report.dead) {
    rows.push({ type: 'dead-module', target: f, severity: 'medium', tier: 'judgment',
      evidence: 'no inbound static or dynamic-literal import anywhere in lib/bin/scripts/tests/apps',
      recommendation: 'Confirm not reached via a computed import path, then remove it (or wire it up).' });
  }
  for (const f of report.testOnly) {
    rows.push({ type: 'module-test-only', target: f, severity: 'low', tier: 'judgment',
      evidence: 'imported only by tests, never by production code',
      recommendation: 'Confirm whether this is production code with only test callers (possible dead-on-ship) or a test helper.' });
  }
  return rows;
}

export function deadcodeFindings() {
  return toFindings(runDeadCode());
}

function main() {
  const report = runDeadCode();
  const findings = toFindings(report);
  recordFindings('02-deadcode', findings);
  writeJson('dead-code.json', report);
  process.stdout.write(`[audit:02] ${report.libCount} lib modules: ${report.dead.length} with no inbound reference, ` +
    `${report.testOnly.length} test-only. (${report.computedImporters} files use computed imports — manual confirm before deleting.)\n`);
  if (report.dead.length) process.stdout.write(`[audit:02] dead candidates: ${report.dead.join(', ')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
