/**
 * lib/knowledge/search.mjs — Self-knowledge search for Construct's own docs.
 *
 * Answers questions about what Construct is, how it works, and what it can do
 * by reading Construct's own documentation tree. Designed for the
 * `knowledge_search` MCP tool — no daemon, no network, no external deps.
 *
 * Sources searched (in priority order):
 *   1. docs/guides/concepts/*.md    — architecture, agents, gates, durable state
 *   2. docs/guides/start/*.mdx      — install + first task
 *   3. docs/README.md        — docs index + contract
 *   4. .cx/knowledge/        — operator-written internal docs
 *   5. Any *.md in docs/guides/cookbook/ — task-oriented recipes
 *   6. <projectRoot>/.cx/knowledge/** — the cwd project's knowledge tree,
 *      including `external/research/` written by `construct knowledge add`,
 *      so foreign-project queries surface project content alongside bundled docs.
 *   7. Registered directory/github targets (construct.config.json sources.targets[]) —
 *      both markdown AND code files (UTF8_TEXT_EXTS, lib/document-extract.mjs) from
 *      each target's resolved content root, tagged with a structured origin
 *      (targetId/provider/projectKey/relPath/kind) so hits are attributable and
 *      filterable via the `projects` option / `--projects` CLI flag
 *      (construct-1smc4.1). Code chunks carry `origin.kind: 'code'`.
 *
 * Retrieval strategy:
 *   Token-based BM25-like scoring over 200-char chunks. Returns top-K chunks
 *   with their source file and a relevance score. Pure text — no embeddings.
 *
 * @module lib/knowledge/search
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

import { loadProjectConfig } from '../config/project-config.mjs';
import { resolveEffectiveSourceTargetsFromConfig } from '../config/source-targets.mjs';
import { resolveContentRoots, expandProjectsFilter, SELF_PROJECT_KEY } from '../sources/content-roots.mjs';
import { UTF8_TEXT_EXTS } from '../document-extract.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..', '..');

// ─── Source catalogue ────────────────────────────────────────────────────────

/**
 * Priority-ordered list of source files to search.
 *
 * `projectRoot` covers the case where Construct is invoked from a foreign
 * project (cwd != construct repo): the project's own `.cx/knowledge/**` —
 * including the `external/research/` tree written by `construct knowledge add
 * --source=research` — joins the source set, so freshly added project knowledge
 * surfaces alongside (and ahead of) the bundled Construct docs. When
 * projectRoot equals repoRoot or is absent, only the bundled set is searched.
 */
function buildSourceList(repoRoot = REPO_ROOT, projectRoot = null, { targetRoots = [] } = {}) {
  const sources = [];

  const priority = [
    'docs/guides/concepts/architecture.md',
    'docs/guides/concepts/agents-and-personas.mdx',
    'docs/guides/concepts/gates-and-enforcement.md',
    'docs/guides/concepts/beads-and-state.md',
    'docs/guides/concepts/prompt-surfaces.md',
    'docs/guides/concepts/knowledge-layout.md',
    'docs/guides/concepts/deployment-model.md',
    'docs/guides/concepts/embedding-boundary.md',
    'docs/README.md',
    'docs/guides/start/install.mdx',
    'docs/guides/start/first-task.mdx',
  ];

  for (const rel of priority) {
    const full = join(repoRoot, rel);
    if (existsSync(full)) sources.push({ path: full, rel, priority: 1 });
  }

  // Cookbook recipes (task-oriented how-tos)
  const cookbookDir = join(repoRoot, 'docs', 'guides', 'cookbook');
  if (existsSync(cookbookDir)) {
    for (const file of readdirSync(cookbookDir)) {
      if (file.endsWith('.md') || file.endsWith('.mdx')) {
        const full = join(cookbookDir, file);
        sources.push({ path: full, rel: `docs/guides/cookbook/${file}`, priority: 2 });
      }
    }
  }

  // Operator internal knowledge
  const knowledgeDirs = [
    join(repoRoot, '.cx', 'knowledge', 'internal'),
    join(repoRoot, '.cx', 'knowledge', 'reference'),
    join(repoRoot, '.cx', 'knowledge', 'how-tos'),
  ];
  for (const dir of knowledgeDirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.md')) {
        const full = join(dir, file);
        sources.push({ path: full, rel: relative(repoRoot, full), priority: 3 });
      }
    }
  }

  // User-ingested documents (PDF/Office/audio routed through docling + whisper)
  const ingestRoot = join(repoRoot, '.cx', 'ingest');
  if (existsSync(ingestRoot)) {
    for (const entry of readdirSync(ingestRoot)) {
      const dir = join(ingestRoot, entry);
      const markdown = join(dir, 'markdown.md');
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      if (!existsSync(markdown)) continue;
      sources.push({ path: markdown, rel: relative(repoRoot, markdown), priority: 4, source: 'ingest' });
    }
  }

  // Project knowledge — the cwd project's `.cx/knowledge/**`. Searched only
  // when the project is distinct from the construct repo (the latter's own
  // .cx/knowledge is already covered above as repoRoot's internal knowledge).
  // Priority 1 puts project content on the same scoring tier as core docs so a
  // freshly added project finding outranks bundled framework material on tied
  // matches; the `source: 'project'` tag lets consumers distinguish origin.

  if (projectRoot && projectRoot !== repoRoot) {
    const projectKnowledgeRoot = join(projectRoot, '.cx', 'knowledge');
    if (existsSync(projectKnowledgeRoot)) {
      for (const file of walkMarkdown(projectKnowledgeRoot)) {
        sources.push({
          path: file,
          rel: relative(projectRoot, file),
          priority: 1,
          source: 'project',
        });
      }
    }
  }

  // Registered content targets (B1): directory targets and synced corpus caches.
  // Each markdown file joins the corpus tagged with its target's structured
  // origin, so retrieval can attribute and filter hits by source project. Priority
  // 1 puts registered project docs on the same tier as the host project's own.

  for (const root of targetRoots) {
    if (!existsSync(root.dir)) continue;
    for (const file of walkMarkdown(root.dir)) {
      sources.push({
        path: file,
        rel: relative(root.dir, file),
        priority: 1,
        source: 'target',
        origin: { ...root.origin, relPath: relative(root.dir, file), kind: 'target' },
      });
    }
    // Code files (construct-1smc4.1): the same registered root's non-markdown
    // UTF8_TEXT_EXTS files join the corpus tagged origin.kind:'code' so a
    // repo's actual source, not just its docs, is queryable and attributable.
    for (const file of walkCodeFiles(root.dir)) {
      sources.push({
        path: file,
        rel: relative(root.dir, file),
        priority: 2,
        source: 'target-code',
        origin: { ...root.origin, relPath: relative(root.dir, file), kind: 'code' },
      });
    }
  }

  return sources;
}

// Recursive .md walk used for the project-knowledge tree, where `external/`
// nests one subdirectory deeper than the flat internal/reference/how-tos layout.

function walkMarkdown(root) {
  const out = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// Skip dependency/VCS directories that would otherwise flood a registered
// target's corpus with vendored or generated code no one queries for.
const CODE_WALK_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', '__pycache__']);

// Recursive code-file walk for registered directory/github targets. Reuses
// UTF8_TEXT_EXTS (lib/document-extract.mjs) so the corpus builder and the
// standalone text-extraction path share a single definition of "code we can
// safely read as UTF-8 text". `.md` is excluded — markdown already has its
// own walkMarkdown() pass with markdown-specific chunking (heading-aware).
function walkCodeFiles(root) {
  const out = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (CODE_WALK_SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkCodeFiles(join(root, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    if (dot === -1) continue;
    const ext = entry.name.slice(dot).toLowerCase();
    if (ext === '.md' || !UTF8_TEXT_EXTS.has(ext)) continue;
    out.push(join(root, entry.name));
  }
  return out;
}

// ─── Chunking ────────────────────────────────────────────────────────────────

const CHUNK_CHARS = 400;
const CHUNK_OVERLAP = 80;

/**
 * Split text into overlapping chunks, preserving markdown section boundaries
 * where possible. Each chunk carries the nearest preceding heading as context.
 */
function chunkText(text, source) {
  const chunks = [];
  const lines = text.split('\n');
  let heading = '';
  let buffer = '';
  let bufferStart = 0;

  function flush(lineIdx) {
    const trimmed = buffer.trim();
    if (trimmed.length < 20) return;
    chunks.push({ text: trimmed, heading, source, lineStart: bufferStart });
    // Overlap: carry last CHUNK_OVERLAP chars into the next buffer
    buffer = trimmed.length > CHUNK_OVERLAP ? trimmed.slice(-CHUNK_OVERLAP) : trimmed;
    bufferStart = lineIdx;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) {
      // Section boundary — flush current buffer, update heading
      flush(i);
      heading = line.replace(/^#+\s*/, '').trim();
      buffer = line + '\n';
      bufferStart = i;
    } else {
      buffer += line + '\n';
      if (buffer.length >= CHUNK_CHARS) flush(i);
    }
  }
  flush(lines.length);
  return chunks;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Tokenise text into lowercase words, filtering stop words.
 */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'is', 'are', 'it', 'in',
  'of', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'that', 'this',
  'be', 'as', 'was', 'will', 'can', 'its', 'not', 'you', 'your', 'how']);

function tokenise(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t));
}

/**
 * BM25-inspired score: term frequency in chunk × inverse source frequency ×
 * source priority bonus.
 */
function scoreChunk(chunk, queryTokens, idfMap) {
  const chunkTokens = tokenise(chunk.text);
  const tf = new Map();
  for (const t of chunkTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf.get(qt) ?? 0;
    if (freq > 0) {
      const idf = idfMap.get(qt) ?? 1;
      // BM25 k1=1.5, b=0 (no length normalisation — chunks are pre-sized)
      score += idf * (freq * 2.5) / (freq + 1.5);
    }
    // Heading match bonus
    if (chunk.heading.toLowerCase().includes(qt)) score += 2;
    // File-name match bonus — rewards architecture.md for "architecture" queries
    if (chunk.source.rel.toLowerCase().includes(qt)) score += 1.5;
  }

  // Priority bonus: priority-1 (architecture, README) wins decisively over how-tos.
  // Multiplier is additive-style: add a flat boost so low-scoring priority-1 chunks
  // aren't simply outscored by high-TF how-to chunks.
  if (chunk.source.priority === 1) score += 3;
  else if (chunk.source.priority === 2) score *= 1.05;

  return score;
}

function buildIdf(queryTokens, chunks) {
  const idf = new Map();
  const N = chunks.length || 1;
  for (const qt of queryTokens) {
    const df = chunks.filter(c => tokenise(c.text).includes(qt)).length || 1;
    idf.set(qt, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

// ─── Observation store loader ────────────────────────────────────────────────

/**
 * Load distilled embed observations from `<rootDir>/.cx/observations/` and
 * convert each one into a searchable text chunk. Returns [] if the directory
 * doesn't exist or is empty.
 */
function buildObservationChunks(rootDir) {
  const obsDir = join(rootDir, '.cx', 'observations');
  if (!existsSync(obsDir)) return [];

  const chunks = [];
  let files;
  try { files = readdirSync(obsDir).filter(f => f.endsWith('.json')); } catch { return []; }

  for (const file of files) {
    let obs;
    try { obs = JSON.parse(readFileSync(join(obsDir, file), 'utf8')); } catch { continue; }
    if (!obs || typeof obs !== 'object') continue;

    const parts = [];
    if (obs.summary) parts.push(obs.summary);
    if (obs.content && obs.content !== obs.summary) parts.push(obs.content);
    if (Array.isArray(obs.tags) && obs.tags.length) parts.push(`tags: ${obs.tags.join(', ')}`);

    const text = parts.join('\n').trim();
    if (!text) continue;

    chunks.push({
      text,
      heading: obs.summary ?? '',
      source: { path: join(obsDir, file), rel: `observations/${file}`, priority: 2 },
      lineStart: 0,
    });
  }

  return chunks;
}


/**
 * @typedef {object} KnowledgeSearchResult
 * @property {boolean} ok
 * @property {string} query
 * @property {number} totalChunks
 * @property {SearchHit[]} hits
 * @property {string[]} sources  — unique source files that contributed hits
 * @property {string} [message]
 */

/**
 * @typedef {object} SearchHit
 * @property {string} text
 * @property {string} heading
 * @property {string} file    — repo-relative path
 * @property {number} score
 * @property {number} lineStart
 */

/**
 * Search Construct's own documentation for content relevant to `query`.
 *
 * @param {object} opts
 * @param {string} opts.query          — natural-language question or keyword
 * @param {number} [opts.topK=5]       — max hits to return
 * @param {number} [opts.minScore=0.1] — discard hits below this score
 * @param {string} [opts.repoRoot]     — override repo root (for testing)
 * @param {string} [opts.rootDir]      — data dir where .cx/observations/ lives (default: homedir())
 * @returns {KnowledgeSearchResult}
 */
export function knowledgeSearch({ query, topK = 5, minScore = 0.1, repoRoot, rootDir, tags, tagMatch = 'any', projects, env = process.env } = {}) {
  if (!query || typeof query !== 'string') {
    return { ok: false, query: query ?? '', totalChunks: 0, hits: [], sources: [], message: 'query is required' };
  }

  const root = repoRoot ?? REPO_ROOT;
  const dataDir = rootDir ?? (process.env.CX_DATA_DIR?.trim() || homedir());

  // Registered content targets contribute to the corpus whenever the project has
  // any (resolved from its config). A `projects` filter narrows retrieval to the
  // named source projects; `self` is the reserved host-project key, `all` every
  // content target. An unknown project id is a hard error (R3), never a silent
  // empty result.
  let targetRoots = [];
  let projectFilter = null;
  if (rootDir) {
    const { config } = loadProjectConfig(rootDir, env);
    const targets = resolveEffectiveSourceTargetsFromConfig(config, env);
    targetRoots = resolveContentRoots(targets, { projectRoot: rootDir });
    if (projects !== undefined && projects !== null && String(projects).trim() !== '') {
      try {
        projectFilter = expandProjectsFilter(projects, targets);
      } catch (err) {
        return { ok: false, query, totalChunks: 0, hits: [], sources: [], message: err.message };
      }
    }
  } else if (projects !== undefined && projects !== null && String(projects).trim() !== '') {
    return { ok: false, query, totalChunks: 0, hits: [], sources: [], message: 'projects filter requires a project root (rootDir)' };
  }

  const sources = buildSourceList(root, rootDir, { targetRoots });

  // Build corpus from docs + operator knowledge
  const allChunks = [];
  for (const src of sources) {
    let text = '';
    try { text = readFileSync(src.path, 'utf8'); } catch { continue; }
    const chunks = chunkText(text, src);
    allChunks.push(...chunks);
  }

  // Add distilled embed observations from the data dir
  const obsChunks = buildObservationChunks(dataDir);
  allChunks.push(...obsChunks);

  if (!allChunks.length) {
    return { ok: false, query, totalChunks: 0, hits: [], sources: [], message: 'No documentation or observation sources found' };
  }

  // Tag filter (optional): applied before scoring to restrict the candidate set.
  const filteredChunks = tags?.length
    ? allChunks.filter((c) => {
        const chunkTags = new Set(Array.isArray(c.tags) ? c.tags : []);
        const required = tags;
        if (tagMatch === 'all') return required.every((t) => chunkTags.has(t));
        return required.some((t) => chunkTags.has(t));
      })
    : allChunks;

  const queryTokens = tokenise(query);
  if (!queryTokens.length) {
    return { ok: false, query, totalChunks: filteredChunks.length, hits: [], sources: [], message: 'Query contains no searchable terms after stop-word removal' };
  }

  const idf = buildIdf(queryTokens, filteredChunks);

  // A chunk's structured origin: registered targets carry it directly from
  // buildSourceList; host/bundled chunks resolve to the reserved self project.
  const originFor = (chunk) => chunk.source.origin ?? {
    targetId: null,
    provider: 'self',
    projectKey: SELF_PROJECT_KEY,
    relPath: chunk.source.rel,
    ref: null,
    kind: chunk.source.source || 'bundled',
  };

  const inFilter = (origin) => {
    if (!projectFilter) return true;
    if (origin.targetId == null) return projectFilter.includeSelf;
    return projectFilter.ids.has(origin.targetId);
  };

  const scored = filteredChunks
    .map(chunk => ({ chunk, origin: originFor(chunk), score: scoreChunk(chunk, queryTokens, idf) }))
    .filter(({ score }) => score >= minScore)
    .filter(({ origin }) => inFilter(origin))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const hits = scored.map(({ chunk, origin, score }) => ({
    text: chunk.text,
    heading: chunk.heading,
    file: chunk.source.rel,
    origin,
    score: Math.round(score * 100) / 100,
    lineStart: chunk.lineStart,
  }));

  const uniqueSources = [...new Set(hits.map(h => h.file))];

  return {
    ok: true,
    query,
    totalChunks: allChunks.length,
    hits,
    sources: uniqueSources,
    message: hits.length
      ? `Found ${hits.length} relevant excerpt${hits.length === 1 ? '' : 's'} across ${uniqueSources.length} source${uniqueSources.length === 1 ? '' : 's'}`
      : 'No relevant content found — try broader terms',
  };
}
