/**
 * lib/knowledge/rag.mjs — Retrieval-Augmented Generation pipeline.
 *
 * Indexes all knowledge sources into a unified corpus and answers natural-
 * language queries by retrieving the most relevant chunks, then synthesising
 * a response via the `claude` CLI.
 *
 * Sources indexed:
 *   - Observations       (.cx/observations/)
 *   - Artifacts          (docs/decisions/adr/, docs/specs/prd/, docs/decisions/rfc/)
 *   - Snapshots          (.cx/snapshot.md + any configured output paths)
 *   - Approval queue     (.cx/approval-queue.jsonl)
 *   - Registered targets (construct.config.json sources.targets[], resolved via
 *     lib/sources/content-roots.mjs): markdown AND code files (UTF8_TEXT_EXTS,
 *     lib/document-extract.mjs) from each target's content root, origin-tagged
 *     (targetId/provider/projectKey/relPath/kind) for cross-repo attribution
 *     and `--projects` filtering (construct-1smc4.1).
 *
 * Retrieval strategy:
 *   Hybrid BM25 + cosine similarity (hashing-bow-v1 embeddings, zero deps).
 *   Top-K chunks from each source are merged, deduplicated by id, and re-ranked
 *   by a combined score before being assembled into a prompt context window.
 *
 * Context budget:
 *   MAX_CONTEXT_CHARS limits total text sent to the model. Chunks are trimmed
 *   to fit. The budget is intentionally conservative so the answer fits in a
 *   single claude --print call.
 *
 * Zero external deps — uses only the existing embeddings primitives.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cosineSimilarity, rankByBm25 } from '../storage/embeddings.mjs';
import { embedSync as embedText } from '../storage/embeddings-legacy.mjs';
import { listObservations, getObservation } from '../observation-store.mjs';
import { listArtifacts } from '../embed/artifact.mjs';
import { UTF8_TEXT_EXTS } from '../document-extract.mjs';

const MAX_CONTEXT_CHARS = 12_000;
const MAX_CHUNKS = 12;
const CHUNK_PREVIEW = 600;

// MIN_SCORE under RRF is a soft floor: with k=60 a top-1 doc in both rankers
// scores ~0.033, so any positive score means the document appeared in at
// least one ranker. We keep a tiny epsilon to drop chunks that scored 0
// from BOTH rankers (which can happen for items not in either ranked list).
const MIN_SCORE = 1e-6;

// ── Source loaders ─────────────────────────────────────────────────────────

/**
 * Load all observations as indexable chunks.
 */
function loadObservationChunks(rootDir) {
  try {
    const entries = listObservations(rootDir, {});
    return entries.map((e) => {
      const full = getObservation(rootDir, e.id);
      return {
        id: `obs:${e.id}`,
        source: 'observation',
        title: e.summary || 'Observation',
        body: [full?.content, full?.summary].filter(Boolean).join('\n'),
        tags: e.tags || [],
        role: e.role || null,
        category: e.category || null,
        createdAt: e.createdAt || null,
      };
    });
  } catch {
    return [];
  }
}

// The host project is the reserved origin: no target id, a `self` project key.
// Registered content targets carry their own origin (targetId, provider,
// projectKey, ref); the corpus builder stamps per-file `relPath` onto both.

const SELF_ORIGIN = Object.freeze({ targetId: null, provider: 'self', projectKey: 'self', ref: null });

function withOrigin(chunk, origin, relPath) {
  return { ...chunk, origin: { ...origin, relPath: relPath ?? chunk.origin?.relPath ?? null } };
}

/**
 * Load markdown files from a directory tree as indexable chunks. `origin`, when
 * given, tags every chunk with its source project and per-file relative path so
 * cross-project retrieval can attribute and filter the result; `baseDir`
 * anchors the relative path (defaults to `dir`).
 */
function loadMarkdownChunks(dir, source, { origin = null, baseDir = dir } = {}) {
  if (!fs.existsSync(dir)) return [];
  const chunks = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        const content = fs.readFileSync(full, 'utf8');
        const titleMatch = content.match(/^#\s+(.+)/m);
        const relPath = path.relative(baseDir, full);
        const idScope = origin?.targetId ? `${origin.targetId}:` : '';
        chunks.push({
          id: `${source}:${idScope}${path.relative(process.cwd(), full)}`,
          source,
          title: titleMatch ? titleMatch[1].trim() : entry.name,
          body: content,
          filePath: full,
          createdAt: fs.statSync(full).mtime.toISOString(),
          ...(origin ? { origin: { ...origin, relPath } } : {}),
        });
      } catch { /* skip unreadable */ }
    }
  };
  walk(dir);
  return chunks;
}

// Skip dependency/VCS directories — mirrors lib/knowledge/search.mjs's
// CODE_WALK_SKIP_DIRS so both corpus builders agree on what "a registered
// target's code" means.
const CODE_WALK_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', '__pycache__']);

/**
 * Load code files from a directory tree as indexable chunks (construct-1smc4.1).
 * Mirrors loadMarkdownChunks's origin-tagging shape but walks UTF8_TEXT_EXTS
 * source files (excluding `.md`, already covered by loadMarkdownChunks) so a
 * registered target's actual code — not just its docs — joins the same
 * BM25+cosine index with attribution.
 */
function loadCodeChunks(dir, source, { origin = null, baseDir = dir } = {}) {
  if (!fs.existsSync(dir)) return [];
  const chunks = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (CODE_WALK_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.md' || !UTF8_TEXT_EXTS.has(ext)) continue;
      try {
        const content = fs.readFileSync(full, 'utf8');
        const relPath = path.relative(baseDir, full);
        const idScope = origin?.targetId ? `${origin.targetId}:` : '';
        chunks.push({
          id: `${source}:${idScope}${path.relative(process.cwd(), full)}`,
          source,
          title: relPath,
          body: content,
          filePath: full,
          createdAt: fs.statSync(full).mtime.toISOString(),
          ...(origin ? { origin: { ...origin, relPath, kind: 'code' } } : {}),
        });
      } catch { /* skip unreadable */ }
    }
  };
  walk(dir);
  return chunks;
}

/**
 * Load artifact docs (ADR, PRD, RFC) from docs/.
 */
function loadArtifactChunks(rootDir) {
  const chunks = [];
  for (const subdir of ['docs/adr', 'docs/prd', 'docs/rfc', 'docs/guides/concepts/architecture.md']) {
    const full = path.resolve(rootDir, subdir);
    if (subdir.endsWith('.md')) {
      if (!fs.existsSync(full)) continue;
      try {
        const content = fs.readFileSync(full, 'utf8');
        const titleMatch = content.match(/^#\s+(.+)/m);
        chunks.push({
          id: `artifact:${subdir}`,
          source: 'artifact',
          title: titleMatch ? titleMatch[1].trim() : subdir,
          body: content,
          filePath: full,
          createdAt: fs.statSync(full).mtime.toISOString(),
        });
      } catch { /* skip */ }
    } else {
      chunks.push(...loadMarkdownChunks(full, 'artifact'));
    }
  }
  return chunks;
}

/**
 * Load snapshot markdown files.
 */
function loadSnapshotChunks(rootDir) {
  const candidates = [
    path.resolve(rootDir, '.cx/snapshot.md'),
    path.resolve(rootDir, '.cx/snapshots'),
  ];
  const chunks = [];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (fs.statSync(c).isDirectory()) {
      chunks.push(...loadMarkdownChunks(c, 'snapshot'));
    } else {
      try {
        const content = fs.readFileSync(c, 'utf8');
        chunks.push({
          id: 'snapshot:.cx/snapshot.md',
          source: 'snapshot',
          title: 'Latest Snapshot',
          body: content,
          filePath: c,
          createdAt: fs.statSync(c).mtime.toISOString(),
        });
      } catch { /* skip */ }
    }
  }
  return chunks;
}

/**
 * Load ingested knowledge files from .cx/knowledge/ subdirectories.
 */
function loadKnowledgeChunks(rootDir) {
  const knowledgeRoot = path.resolve(rootDir, '.cx/knowledge');
  const subdirs = ['internal', 'external', 'decisions', 'how-tos', 'reference'];
  const chunks = [];
  for (const subdir of subdirs) {
    const full = path.join(knowledgeRoot, subdir);
    if (!fs.existsSync(full)) continue;
    chunks.push(...loadMarkdownChunks(full, 'knowledge'));
  }
  return chunks;
}

// ── Index builder ──────────────────────────────────────────────────────────

/**
 * Build a full in-memory corpus from all sources.
 * Each chunk gets an embedding vector for cosine scoring and an `origin` tag.
 *
 * The single-`rootDir` signature is preserved for existing callers: passing a
 * string (or nothing) indexes only the host project, whose chunks carry the
 * reserved self origin. Passing `roots` — content-capable target roots resolved
 * via lib/sources/content-roots.mjs — folds each registered project's markdown
 * AND code (UTF8_TEXT_EXTS) into the same corpus, every chunk attributed to its
 * source project so retrieval can cite and filter across projects (bead
 * construct-760c.2; code folded in by construct-1smc4.1).
 *
 * @param {string} [rootDir]
 * @param {object} [opts]
 * @param {{dir: string, origin: object}[]} [opts.roots] — extra content roots
 */
export function buildCorpus(rootDir = process.cwd(), { roots = [] } = {}) {
  const hostChunks = [
    ...loadObservationChunks(rootDir),
    ...loadArtifactChunks(rootDir),
    ...loadSnapshotChunks(rootDir),
    ...loadKnowledgeChunks(rootDir),
  ].map((chunk) => withOrigin(chunk, SELF_ORIGIN, chunk.filePath ? path.relative(rootDir, chunk.filePath) : null));

  const rootChunks = [];
  for (const { dir, origin } of roots) {
    rootChunks.push(...loadMarkdownChunks(dir, 'target', { origin, baseDir: dir }));
    rootChunks.push(...loadCodeChunks(dir, 'target-code', { origin, baseDir: dir }));
  }

  const chunks = [...hostChunks, ...rootChunks];

  // Embed each chunk
  return chunks.map((chunk) => ({
    ...chunk,
    embedding: embedText(`${chunk.title} ${chunk.body}`.slice(0, 2000)),
  }));
}

// ── Retrieval ──────────────────────────────────────────────────────────────

/**
 * Retrieve the top-K most relevant chunks for a query.
 *
 * Pipeline:
 *   1. BM25 ranks the FULL corpus (no top-K window so chunks outside any
 *      bounded slice still contribute).
 *   2. Cosine ranks the FULL corpus.
 *   3. RRF fuses the two ranked lists into one (corpus-agnostic; rank-only).
 *   4. MMR reranks the fused candidates with λ=0.7 to drop near-duplicates
 *      while preserving relevance.
 *
 * Both fuser and reranker are pluggable via the engine layer
 * (lib/engine/index.mjs); callers can swap RRF for any other Fuser plugin
 * and MMR for any other Reranker plugin without touching this module. The
 * defaults are wired in lib/engine/defaults.mjs.
 *
 * @param {string} query
 * @param {object[]} corpus  — from buildCorpus()
 * @param {object} [opts]
 * @returns {Promise<object[]>} top chunks with `.score` (RRF) and `.mmrScore`,
 *   sorted by MMR order. Returns a Promise so engine-aligned chunkers and
 *   embedders can plug in without changing the call surface.
 */
export async function retrieve(query, corpus, { topK = MAX_CHUNKS, minScore = MIN_SCORE } = {}) {
  if (!query || corpus.length === 0) return [];

  const queryEmbedding = embedText(query);

  const bm25Ranked = rankByBm25(
    corpus.map((c) => ({ ...c, text: `${c.title} ${c.body}` })),
    query,
    { limit: corpus.length },
  );

  const cosineRanked = corpus
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding || []),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const { getEngine } = await import('../engine/index.mjs');
  const engine = await getEngine({ rootDir: process.cwd() });
  const fused = engine.layers.fuser.fuse({ bm25: bm25Ranked, cosine: cosineRanked });

  const filtered = fused.filter((c) => c.score >= minScore);
  if (filtered.length === 0) return [];

  const reranked = await engine.layers.reranker.rerank(query, filtered, {
    queryEmbedding,
    topK,
  });

  return reranked;
}

// ── Context assembly ───────────────────────────────────────────────────────

/**
 * Format retrieved chunks into a context block for the prompt.
 */
export function assembleContext(chunks) {
  let budget = MAX_CONTEXT_CHARS;
  const parts = [];

  for (const chunk of chunks) {
    const preview = chunk.body?.slice(0, CHUNK_PREVIEW) || '';
    const projectKey = chunk.origin?.projectKey;
    const meta = [
      chunk.source && `source:${chunk.source}`,
      projectKey && projectKey !== 'self' && `project:${projectKey}`,
      chunk.origin?.relPath && `path:${chunk.origin.relPath}`,
      chunk.role && `role:${chunk.role}`,
      chunk.category && `category:${chunk.category}`,
      chunk.createdAt && `date:${chunk.createdAt.slice(0, 10)}`,
    ].filter(Boolean).join('  ');

    const block = `### ${chunk.title}\n${meta ? `_${meta}_\n` : ''}${preview}${preview.length === CHUNK_PREVIEW ? '\n…' : ''}`;
    if (block.length > budget) break;
    parts.push(block);
    budget -= block.length;
  }

  return parts.join('\n\n---\n\n');
}

// ── Answer synthesis ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Construct's knowledge assistant. Answer questions about the project using only the provided context.
- Be specific and cite which source you drew from (observation, artifact, snapshot).
- If the context is insufficient, say so directly — do not speculate.
- Keep answers concise (under 400 words unless the question demands detail).
- Format as plain text unless the question explicitly asks for markdown.`;

/**
 * Ask a question against the knowledge base.
 *
 * @param {string} question
 * @param {object} opts
 * @param {string}   opts.rootDir
 * @param {object[]} [opts.corpus]   — pre-built corpus (skips rebuild)
 * @param {boolean}  [opts.dryRun]   — return retrieved chunks without calling claude
 * @returns {{ answer: string, sources: object[], query: string }}
 */
export async function ask(question, { rootDir = process.cwd(), corpus, dryRun = false } = {}) {
  const kb = corpus ?? buildCorpus(rootDir);
  const chunks = await retrieve(question, kb);

  if (dryRun) {
    return {
      answer: null,
      sources: chunks.map((c) => ({ id: c.id, source: c.source, title: c.title, score: c.score, origin: c.origin ?? null })),
      query: question,
    };
  }

  if (chunks.length === 0) {
    return {
      answer: 'No relevant information found in the knowledge base for this query.',
      sources: [],
      query: question,
    };
  }

  const context = assembleContext(chunks);
  const prompt = `${SYSTEM_PROMPT}\n\n## Knowledge Base Context\n\n${context}\n\n## Question\n\n${question}\n\n## Answer`;

  // Call claude CLI
  const result = spawnSync('claude', ['--print', prompt], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env },
  });

  if (result.error || result.status !== 0) {
    // Fallback: return retrieved chunks as a structured answer
    const fallback = chunks
      .slice(0, 5)
      .map((c) => `**${c.title}** (${c.source})\n${c.body?.slice(0, 300) || ''}`)
      .join('\n\n');
    return {
      answer: `[Claude CLI unavailable — showing retrieved context]\n\n${fallback}`,
      sources: chunks.map((c) => ({ id: c.id, source: c.source, title: c.title, score: c.score, origin: c.origin ?? null })),
      query: question,
      cliMissing: true,
    };
  }

  return {
    answer: (result.stdout || '').trim(),
    sources: chunks.map((c) => ({ id: c.id, source: c.source, title: c.title, score: c.score, origin: c.origin ?? null })),
    query: question,
  };
}
