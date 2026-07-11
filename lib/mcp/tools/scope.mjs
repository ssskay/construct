/**
 * lib/mcp/tools/scope.mjs — MCP wrappers for the org-scope + learning surfaces.
 *
 * Bridges PR #67 capabilities (scopes, outcomes, sandboxes, knowledge_add,
 * learning status) so subagents talking through the construct-mcp server can
 * read the same state the CLI exposes. Operator-only surfaces (optimize_apply,
 * optimize_rollback) remain CLI-only and are not registered here.
 *
 * Pattern: each export is a thin schema-validated wrapper around the existing
 * lib/* function the CLI already uses. Errors return `{ error: string }` so
 * the MCP dispatcher hands a structured failure back instead of crashing.
 * Destructive operations (scope_archive) require `confirm: true`, matching
 * the storage_reset / delete_ingested_artifacts pattern in tools/storage.mjs.
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import {
  loadScope,
  listScopes,
  loadCustomScope,
  resolveActiveScope,
} from '../../scopes/loader.mjs';
import {
  createDraftScope,
  listDrafts,
  archiveScope,
  scopeHealth,
} from '../../scopes/lifecycle.mjs';
import { recordOutcome } from '../../outcomes/record.mjs';
import { aggregateOutcomes, readSummary } from '../../outcomes/aggregate.mjs';
import { addResearchFinding } from '../../knowledge/research-store.mjs';
import { askGlobal } from '../../knowledge/graph.mjs';
import { listSandboxes } from '../../sandbox.mjs';
import { configPath } from '../../config-dir.mjs';

function cwdOf(args) {
  return args && args.cwd ? resolve(String(args.cwd)) : process.cwd();
}

// Read-only: active scope.

export function scopeShow(args = {}) {
  const cwd = cwdOf(args);
  const scope = resolveActiveScope(cwd, args.id ? String(args.id) : null);
  return {
    id: scope.id,
    displayName: scope.displayName ?? scope.id,
    tagline: scope.tagline ?? null,
    custom: scope.custom === true,
    roles: Array.isArray(scope.roles) ? scope.roles : [],
    teams: Array.isArray(scope.teams)
      ? scope.teams.map((t) => ({ id: t.id, name: t.name, roleCount: Array.isArray(t.roles) ? t.roles.length : 0 }))
      : [],
    experimental: scope.experimental === true,
    intake: {
      types: scope.intake?.types ?? [],
      stages: scope.intake?.stages ?? [],
    },
    docTemplates: scope.docTemplates ?? [],
    hooks: scope.hooks ?? null,
    rebrand: scope.rebrand ?? null,
  };
}

// Read-only: catalog summary.

export function scopeList() {
  return {
    scopes: listScopes().map((id) => {
      const p = loadScope(id);
      return p
        ? {
            id: p.id,
            displayName: p.displayName ?? p.id,
            tagline: p.tagline ?? null,
            roleCount: Array.isArray(p.roles) ? p.roles.length : 0,
            teamCount: Array.isArray(p.teams) ? p.teams.length : 0,
            experimental: p.experimental === true,
          }
        : { id, error: 'failed to parse' };
    }),
  };
}

// Read-only: drafts + custom scope under .construct/.

export function scopeDrafts(args = {}) {
  const cwd = cwdOf(args);
  const drafts = listDrafts(cwd).map((d) => ({
    id: d.id,
    dir: d.dir,
    hasScope: d.hasScope,
    hasBrief: d.hasBrief,
  }));
  const custom = loadCustomScope(cwd);
  return {
    drafts,
    custom: custom ? { id: custom.id, displayName: custom.displayName ?? custom.id } : null,
  };
}

// Read-only: per-scope health rollup.

export function scopeHealthTool(args = {}) {
  const cwd = cwdOf(args);
  const id = args.id ? String(args.id) : resolveActiveScope(cwd).id;
  const windowDays = Number.isFinite(args.window_days) ? Number(args.window_days) : 30;
  return { id, windowDays, ...scopeHealth(cwd, id, { windowDays }) };
}

// Read-only: outcomes rollup. Optional aggregate=true rebuilds _summary.json.

export function outcomesSummary(args = {}) {
  const cwd = cwdOf(args);
  if (args.aggregate === true) {
    try { aggregateOutcomes(cwd); } catch (err) { return { error: `aggregate failed: ${err.message}` }; }
  }
  const summary = readSummary(cwd);
  if (!summary) return { roles: {}, note: 'no outcomes recorded yet' };
  return summary;
}

// Mutating, gated: append an outcome line.

export function outcomesRecord(args = {}) {
  if (args.confirm !== true) {
    return { error: 'outcomes_record requires confirm=true to write durable state' };
  }
  const cwd = cwdOf(args);
  if (!args.role || typeof args.success !== 'boolean') {
    return { error: 'outcomes_record requires role:string and success:boolean' };
  }
  const profile = args.profile ? String(args.profile) : resolveActiveScope(cwd)?.id;
  const file = recordOutcome(cwd, {
    role: String(args.role),
    intakeId: args.intake_id ? String(args.intake_id) : null,
    profile,
    success: !!args.success,
    escalated: !!args.escalated,
    durationMs: Number.isFinite(args.duration_ms) ? Number(args.duration_ms) : null,
    notes: args.notes ? String(args.notes) : null,
    source: args.source ? String(args.source) : 'mcp',
    sessionId: args.session_id ? String(args.session_id) : null,
  });
  if (!file) return { error: 'outcomes_record: write failed' };
  return { ok: true, file };
}

// Mutating, gated: persist a research finding.

export async function knowledgeAdd(args = {}) {
  if (args.confirm !== true) {
    return { error: 'knowledge_add requires confirm=true to write durable state' };
  }
  const cwd = cwdOf(args);
  try {
    const res = await addResearchFinding({
      cwd,
      slug: String(args.slug || ''),
      topic: String(args.topic || ''),
      body: String(args.body || ''),
      confidence: args.confidence ? String(args.confidence) : 'inferred',
      sources: Array.isArray(args.sources) ? args.sources : [],
      ttlDays: Number.isFinite(args.ttl_days) ? Number(args.ttl_days) : undefined,
    });
    return { ok: true, path: res.path, bytes: res.bytes };
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
}

// Mutating, gated: scaffold a draft scope.

export function scopeCreate(args = {}) {
  if (args.confirm !== true) {
    return { error: 'scope_create requires confirm=true to scaffold files' };
  }
  const cwd = cwdOf(args);
  if (!args.id) return { error: 'scope_create requires id:string' };
  try {
    const res = createDraftScope({
      cwd,
      id: String(args.id),
      displayName: args.display_name ? String(args.display_name) : undefined,
      seedRoles: Array.isArray(args.seed_roles) ? args.seed_roles.map(String) : [],
      seedDepartments: Array.isArray(args.seed_departments) ? args.seed_departments : [],
    });
    return {
      ok: true,
      dir: res.dir,
      briefPath: res.briefPath,
      draftPath: res.draftPath,
      personaPaths: res.personaPaths,
      departmentPaths: res.departmentPaths,
    };
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
}

// Mutating, gated, destructive: archive a curated scope.

export function scopeArchive(args = {}) {
  if (!args.id || !args.reason || String(args.reason).trim().length < 8) {
    return { error: 'scope_archive requires id:string and reason:string (>=8 chars)' };
  }
  try {
    return { ok: true, ...archiveScope({ id: String(args.id), reason: String(args.reason) }) };
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
}

// Read-only: sandbox roster.

export function sandboxList() {
  return { sandboxes: listSandboxes() };
}

// Read-only: GraphRAG global query over the entity graph.

export function knowledgeGraphAsk(args = {}) {
  const cwd = cwdOf(args);
  if (!args.query || typeof args.query !== 'string') {
    return { error: 'knowledge_graph_ask requires query:string' };
  }
  const topK = Number.isFinite(args.top_k) ? Number(args.top_k) : 5;
  const minSize = Number.isFinite(args.min_size) ? Number(args.min_size) : undefined;
  return askGlobal({ query: String(args.query), rootDir: cwd, topK, ...(minSize !== undefined ? { minSize } : {}) });
}

// Read-only: learning dashboard mirror.

export function learningStatus(args = {}) {
  const cwd = cwdOf(args);

  let observations = { total: 0, last24h: 0 };
  try {
    const idxPath = configPath(cwd, 'observations', 'index.json');
    if (existsSync(idxPath)) {
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      if (Array.isArray(idx)) {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        observations = {
          total: idx.length,
          last24h: idx.filter((e) => Date.parse(e?.createdAt) >= since).length,
        };
      }
    }
  } catch { /* best effort */ }

  let researchCount = 0;
  try {
    const dir = configPath(cwd, 'knowledge', 'external', 'research');
    if (existsSync(dir)) {
      researchCount = readdirSync(dir).filter((f) => f.endsWith('.md')).length;
    }
  } catch { /* best effort */ }

  const scope = resolveActiveScope(cwd);
  const outcomes = readSummary(cwd) || { roles: {} };

  return {
    scope: { id: scope.id, displayName: scope.displayName ?? scope.id, custom: scope.custom === true },
    observations,
    research: { count: researchCount },
    outcomes,
  };
}
