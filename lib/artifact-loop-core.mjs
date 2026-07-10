/**
 * lib/artifact-loop-core.mjs — Surface-neutral Construct artifact loop core.
 *
 * Intent resolution, typed-artifact drafting helpers, workflow-plan invocation,
 * on-disk materialization, and the release gate — with zero host UI imports so
 * the MCP server and supported hosts share one author→materialize→validate path.
 *
 * Provenance (construct-ifwhw.2): `invokeWorkflow` here always runs with
 * `approvalMode: 'proposal-only'`, so it never durably records itself, and
 * without a separate write the authored file (when one gets written) was
 * the only evidence an `author_artifact` call happened at all.
 * `runConstructArtifactLoop` writes one observation
 * (lib/observation-store.mjs) per invocation, unconditionally and before the
 * draft-presence branch, carrying the resolved workflow plan (traceId,
 * workflowId, selected roles) — a `.cx/observations/<id>.json` record exists
 * whether or not a draft was present to materialize, independent of whether
 * the artifact FILE gets written: the no-draft branch below still returns
 * early with `path: null`, unchanged from prior behavior; only the
 * provenance write is new.
 */
import fs from 'node:fs';
import path from 'node:path';

import { findConstructRoot, getArtifactEntry } from './artifact-manifest.mjs';
import { validateArtifactRelease } from './artifact-release-gate.mjs';
import { detectDocAuthoringIntent, resolveDocTypeMention } from './orchestration-policy.mjs';
import { invokeWorkflow } from './embedded-contract/workflow-invoke.mjs';
import { getTemplate } from './mcp/tools/skills.mjs';
import { addObservation } from './observation-store.mjs';

const LOOP_INTENT_RE = [
  /\brun (?:it )?through (?:the )?(?:actual )?construct (?:artifact )?loop\b/i,
  /\brun (?:this|that|it) through construct\b/i,
  /\b(execute|run) (?:the )?(?:artifact|prd) (?:pipeline|workflow|gate)\b/i,
  /\bconstruct(?:\s+artifact)?\s+loop\b/i,
  /\bthrough the construct (?:artifact )?loop\b/i,
];

const LOOP_DOC_GATE_RE = /\b(?:loop|release gate|artifact gate|artifact validate)\b/i;
const AUTHOR_VERBS_RE = /\b(write|writing|draft|drafting|create|creating|author|authoring|produce|producing|compose|composing|prepare|preparing|generate|generating)\b/i;
const VALIDATE_FOLLOWUP_RE = /\b(run|execute|push|send|put)\b.*\b(?:it|this|that|the draft)\b.*\b(?:through|via)\b/i;
const QUESTION_PREFIX_RE = /^\s*(what|how|why|when|where|who|which|is|are|does|do|can|could|should|would|tell me about|explain)\b/i;

const OUTPUT_DIR_BY_TYPE = {
  prd: 'docs/specs/prd',
  'prd-platform': 'docs/prd-platform',
  'prd-business': 'docs/prd-business',
  'meta-prd': 'docs/meta-prd',
  adr: 'docs/decisions/adr',
  rfc: 'docs/decisions/rfc',
  'research-brief': '.cx/research',
  'evidence-brief': '.cx/knowledge/internal/evidence-briefs',
  runbook: 'docs/runbooks',
  strategy: '.cx',
};

const WORKFLOW_BY_TYPE = {
  prd: 'prd-draft',
  'prd-platform': 'prd-draft',
  'prd-business': 'prd-draft',
  'meta-prd': 'prd-draft',
  adr: 'architecture-review',
  rfc: 'architecture-review',
};

export function lastAssistantBody(turnBlocks = []) {
  for (let i = turnBlocks.length - 1; i >= 0; i--) {
    const item = turnBlocks[i];
    if (item?.kind === 'turn' && item.block?.assistant?.trim()) {
      return item.block.assistant.trim();
    }
  }
  return null;
}

export function lastUserBody(turnBlocks = []) {
  for (let i = turnBlocks.length - 1; i >= 0; i--) {
    const item = turnBlocks[i];
    if (item?.kind === 'turn' && item.block?.userText?.trim()) {
      return item.block.userText.trim();
    }
  }
  return null;
}

function combinedContext(text, turnBlocks) {
  const parts = [String(text || ''), lastUserBody(turnBlocks), lastAssistantBody(turnBlocks)].filter(Boolean);
  return parts.join('\n');
}

function mentionsConstructLoop(text) {
  return LOOP_INTENT_RE.some((re) => re.test(text));
}

function isQuestion(text) {
  const t = String(text || '').trim();
  return QUESTION_PREFIX_RE.test(t) || /\?\s*$/.test(t);
}

function isValidateFollowUp(text) {
  return VALIDATE_FOLLOWUP_RE.test(text)
    || /\b(?:run|execute)\b.*\b(?:artifact|release)\s+gate\b/i.test(text)
    || /\bvalidate (?:the )?(?:draft|artifact|prd)\b/i.test(text);
}

export function hasSubstantialDraft(turnBlocks = []) {
  const draft = lastAssistantBody(turnBlocks);
  return Boolean(draft && normalizeDraftMarkdown(draft).length >= 400 && /^#\s+/m.test(normalizeDraftMarkdown(draft)));
}

/**
 * Resolve whether the user wants to author+loop or validate an existing draft.
 * Returns null when the message should follow the normal host path.
 */
export function resolveArtifactLoopRequest(text, { turnBlocks = [], explicit = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;

  const loopMention = explicit || mentionsConstructLoop(t);
  const docIntent = detectDocAuthoringIntent(combinedContext(t, turnBlocks));
  const hybridLoopDoc = !loopMention && Boolean(docIntent) && LOOP_DOC_GATE_RE.test(t);

  if (!loopMention && !hybridLoopDoc) return null;
  if (!explicit && isQuestion(t)) return null;

  const artifactType = resolveLoopArtifactType(t, turnBlocks);
  const hasDraft = hasSubstantialDraft(turnBlocks);
  const wantsAuthor = Boolean(
    explicit && t.replace(/^\/loop\s*/i, '').trim()
    || detectDocAuthoringIntent(t)
    || docIntent
    || AUTHOR_VERBS_RE.test(t),
  );

  if (hasDraft && (isValidateFollowUp(t) || (!wantsAuthor && loopMention))) {
    return { mode: 'validate', artifactType };
  }

  if (wantsAuthor) {
    return { mode: 'author', artifactType };
  }

  if (hasDraft) {
    return { mode: 'validate', artifactType };
  }

  return null;
}

export function detectConstructLoopIntent(text, { turnBlocks = [], explicit = false } = {}) {
  return resolveArtifactLoopRequest(text, { turnBlocks, explicit }) !== null;
}

export function resolveLoopArtifactType(text, turnBlocks) {
  const blob = combinedContext(text, turnBlocks);
  let type = detectDocAuthoringIntent(blob)?.docType || resolveDocTypeMention(blob) || 'prd';
  const platformSignals = /\bplatform prd\b|\bteam mode\b|\bteam deployments\b|\benterprise\b|\boidc\b|\bsso\b|\bapi contract\b/i.test(blob);
  if (platformSignals && (type === 'prd' || !type)) type = 'prd-platform';
  if (/\bbusiness prd\b|\bmarket\b|\bpricing strategy\b/i.test(blob)) type = 'prd-business';
  if (/\bmeta[\s-]prd\b/i.test(blob)) type = 'meta-prd';
  return type;
}

function extractLoopSubject(userText) {
  return String(userText || '')
    .replace(/^\/loop\s*/i, '')
    .replace(/\b(?:use |the )?construct(?:\s+artifact)?\s+loop\b/gi, '')
    .replace(/\b(?:to|and)\s+(?:write|draft|create|generate|author|compose|produce|prepare)\b/gi, '')
    .replace(/\b(?:write|draft|create|generate|author|compose|produce|prepare)\b/gi, '')
    .replace(/\b(?:a|an|the)\s+/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildArtifactAuthoringPrompt({
  userText,
  artifactType,
  rootDir,
  gateErrors = [],
} = {}) {
  const root = rootDir || findConstructRoot();
  const entry = getArtifactEntry(artifactType, { rootDir: root });
  const subject = extractLoopSubject(userText) || 'the requested topic';
  const sectionHeadings = (entry?.structureRequirements || [])
    .map((section) => `## ${section}`)
    .join('\n');
  const visualLines = (entry?.visualRequirements || []).map((req) => {
    if (req.check === 'artifact-has-mermaid') {
      return `- Include a fenced \`\`\`mermaid\`\`\` block with a ${req.diagram || 'flowchart'} diagram`;
    }
    if (req.check === 'artifact-table-has-columns' && Array.isArray(req.columns)) {
      return `- Include a markdown table with columns: ${req.columns.join(' | ')} (with at least one data row)`;
    }
    return `- Satisfy visual requirement: ${req.id}`;
  });
  let templateExcerpt = '';
  try {
    const tmpl = getTemplate({ name: artifactType }, { ROOT_DIR: root });
    if (tmpl?.content) {
      templateExcerpt = tmpl.content.split('\n').slice(0, 40).join('\n');
    }
  } catch { /* template excerpt is best-effort */ }

  const gateBlock = gateErrors.length
    ? `\nPrevious draft failed the release gate. Fix every item:\n${gateErrors.map((e) => `- ${e}`).join('\n')}\n`
    : '';

  return `${String(userText || '').trim()}

Produce a complete ${artifactType} markdown document for: ${subject}.
${gateBlock}
Required structure (use these ## headings):
${sectionHeadings || '## Problem\n## Goals and non-goals\n## Success metrics'}

Visual requirements:
${visualLines.length ? visualLines.join('\n') : '- Include a mermaid flowchart and a metrics table when applicable'}

Content rules:
- Start with a single # title line
- Write at least three prose paragraphs (not lists/tables alone) across the document
- Use repo tools to find relevant paths before claiming facts; cite file paths or URLs
- Mark unsupported claims [unverified]
- Output only the document markdown (no preamble)

Template reference (shape only):
${templateExcerpt || '(no template excerpt)'}`;
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56) || 'draft';
}

function extractTitle(draft, fallback = 'draft-artifact') {
  if (!draft) return fallback;
  const normalized = normalizeDraftMarkdown(draft);
  const prd = normalized.match(/^#\s+(?:PRD:\s*)?(.+)$/m);
  if (prd?.[1]) return prd[1].trim();
  const h1 = normalized.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].trim();
  return fallback;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function outputPathForType(artifactType, slug, cwd, entry = null) {
  const relDir = OUTPUT_DIR_BY_TYPE[artifactType] || entry?.outputDir || 'docs/specs/prd';
  const fileName = artifactType === 'adr'
    ? `ADR-draft-${slug}.md`
    : `${todayStamp()}-${slug}.md`;
  return path.join(cwd, relDir, fileName);
}

function fillTemplate(template, { title, date }) {
  return template
    .replace(/\{title\}/g, title)
    .replace(/\{YYYY-MM-DD\}/g, date)
    .replace(/\{name\}/g, 'cx-product-manager');
}

export function ensureFrontmatter(body, artifactType) {
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(body)) return body;
  return `---
artifactType: ${artifactType}
status: draft
owner: cx-product-manager
last_verified_at: ${todayStamp()}
---

${body.trim()}\n`;
}

export function normalizeDraftMarkdown(draft) {
  let text = String(draft || '').trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

export function extractArtifactMarkdown(text) {
  const normalized = normalizeDraftMarkdown(text);
  if (!normalized) return null;
  const idx = normalized.search(/^#\s+/m);
  if (idx < 0) return null;
  const doc = normalized.slice(idx).trim();
  if (doc.length < 200) return null;
  return doc;
}

// An adhoc artifact has no fixed template: the supplied instructions become the
// scaffold body, marked [unverified] so it clears the citation gate as an
// unresearched draft. Free-form structure, still through the release gate.

function buildAdhocScaffold({ title, instructions }) {
  const instr = String(instructions || '').trim();
  const bodyText = instr
    || 'Free-form artifact. Expand this from the supplied instructions and evidence.';
  return ensureFrontmatter(
    `# ${title}\n\n${bodyText}\n\n> Scope: adhoc artifact — structure follows the instructions above.\n\n[unverified]\n`,
    'adhoc',
  );
}

function buildDraftBody({ artifactType, title, draftFromHost, draftMarkdown, rootDir, allowScaffold = true, instructions }) {
  const source = draftMarkdown || (draftFromHost ? normalizeDraftMarkdown(draftFromHost) : null);
  if (source && source.length >= 200 && /^#\s+/m.test(source)) {
    return ensureFrontmatter(source, artifactType);
  }
  if (!allowScaffold) return null;
  if (artifactType === 'adhoc') {
    return buildAdhocScaffold({ title, instructions });
  }
  const tmpl = getTemplate({ name: artifactType }, { ROOT_DIR: rootDir });
  if (tmpl?.content) {
    return fillTemplate(tmpl.content, { title, date: todayStamp() });
  }
  return ensureFrontmatter(`# ${title}\n\n## Summary\n\nDraft scaffold — expand from workflow plan and evidence.\n`, artifactType);
}

// A provenance-store write failure must not block artifact authoring: the
// failure surfaces on the returned result for the caller to see, never as a
// thrown error past this boundary.

async function recordArtifactProvenance({ cwd, invokePlan, artifactType, workflowType, title, relPath }) {
  const specialists = (invokePlan?.selectedRoles || []).map((r) => `cx-${r}`);
  try {
    const observation = await addObservation(cwd, {
      role: invokePlan?.trace?.role || 'product-manager',
      category: 'decision',
      summary: `author_artifact: ${artifactType} workflow plan resolved (${workflowType})`,
      content: `traceId=${invokePlan?.traceId || 'none'}; workflowId=${invokePlan?.workflowId || 'none'}; roles=${specialists.join(',') || 'none'}; status=${invokePlan?.status || 'unknown'}`,
      tags: ['artifact-loop', `artifact/${artifactType}`, `workflow/${workflowType}`],
      source: 'artifact-loop-core',
      extras: {
        traceId: invokePlan?.traceId || null,
        workflowId: invokePlan?.workflowId || null,
        workflowType,
        artifactType,
        title,
        relPath,
        selectedRoles: specialists,
        roleStrategy: invokePlan?.roleStrategy || null,
      },
    });
    return { ok: true, id: observation?.id ?? null, store: '.cx/observations' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function runConstructArtifactLoop({
  text = '',
  turnBlocks = [],
  cwd = process.cwd(),
  rootDir,
  explicit = false,
  artifactType: artifactTypeOverride,
  draftMarkdown,
  allowScaffold = true,
  instructions,
  titleOverride,
} = {}) {
  const root = rootDir || findConstructRoot(cwd);
  const draftFromHost = draftMarkdown ? null : lastAssistantBody(turnBlocks);
  const resolvedDraft = draftMarkdown || extractArtifactMarkdown(draftFromHost);
  const artifactType = artifactTypeOverride || resolveLoopArtifactType(text, turnBlocks);
  const entry = getArtifactEntry(artifactType, { rootDir: root, cwd });
  const title = titleOverride?.trim() || extractTitle(
    resolvedDraft || draftFromHost,
    explicit ? (extractLoopSubject(text) || 'draft-artifact') : 'draft-artifact',
  );
  const slug = slugify(title);
  const outPath = outputPathForType(artifactType, slug, cwd, entry);
  const relPath = path.relative(cwd, outPath);
  const workflowType = WORKFLOW_BY_TYPE[artifactType] || 'prd-draft';
  const input = [
    `Artifact loop: ${artifactType}`,
    `Title: ${title}`,
    resolvedDraft || draftFromHost
      ? `Draft excerpt:\n${(resolvedDraft || draftFromHost).slice(0, 4000)}`
      : String(text),
  ].join('\n\n');

  const invokePlan = await invokeWorkflow({
    workflowType,
    input,
    approvalMode: 'proposal-only',
    trace: true,
  });

  const provenance = await recordArtifactProvenance({ cwd, invokePlan, artifactType, workflowType, title, relPath });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = buildDraftBody({
    artifactType,
    title,
    draftFromHost,
    draftMarkdown: resolvedDraft,
    rootDir: root,
    allowScaffold,
    instructions,
  });
  if (!body) {
    return {
      ok: false,
      artifactType,
      path: null,
      relPath,
      title,
      slug,
      workflowType,
      invokePlan,
      provenance,
      validation: { ok: false, errors: ['No draft content to materialize'], warnings: [] },
      summary: 'Release gate: not run — no draft content to materialize.',
      draftMissing: true,
      overlay: {
        intent: 'doc-authoring',
        workCategory: 'artifact-loop',
        track: 'orchestrated',
        specialists: (invokePlan?.selectedRoles || ['product-manager', 'architect']).map((r) => `cx-${r}`),
        dispatchSummary: `artifact loop: ${artifactType} → validate`,
      },
    };
  }
  fs.writeFileSync(outPath, body.endsWith('\n') ? body : `${body}\n`);

  const validation = validateArtifactRelease({
    filePath: outPath,
    type: artifactType,
    cwd,
    rootDir: root,
  });

  const gateStatus = validation.ok
    ? 'PASS'
    : `FAIL (${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'})`;
  const summary = validation.ok
    ? [
      `Wrote ${relPath} (${artifactType}).`,
      `Release gate: ${gateStatus}`,
      invokePlan?.selectedRoles?.length
        ? `Workflow plan (${workflowType}): ${invokePlan.selectedRoles.map((r) => `cx-${r}`).join(' → ')}`
        : `Workflow plan (${workflowType}): ${invokePlan?.status || 'proposed'}`,
      'Next: address gate findings, run specialists per plan, then `construct publish` if distributing.',
    ].join('\n')
    : [
      `Draft failed release gate for ${relPath} (${artifactType}).`,
      `Release gate: ${gateStatus}`,
      invokePlan?.selectedRoles?.length
        ? `Workflow plan (${workflowType}): ${invokePlan.selectedRoles.map((r) => `cx-${r}`).join(' → ')}`
        : `Workflow plan (${workflowType}): ${invokePlan?.status || 'proposed'}`,
      'Next: fix gate errors below, re-run `/loop` or `construct artifact validate`.',
    ].join('\n');

  return {
    ok: validation.ok,
    artifactType,
    path: outPath,
    relPath,
    title,
    slug,
    workflowType,
    invokePlan,
    provenance,
    validation,
    summary,
    overlay: {
      intent: 'doc-authoring',
      workCategory: 'artifact-loop',
      track: 'orchestrated',
      specialists: (invokePlan?.selectedRoles || ['product-manager', 'architect']).map((r) => `cx-${r}`),
      dispatchSummary: `artifact loop: ${artifactType} → validate`,
    },
  };
}
