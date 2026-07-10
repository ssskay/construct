/**
 * lib/publish-template.mjs — type-specific PDF template routing and brand tokens
 * for Construct distribution exports.
 *
 * Projects override via `.cx/publish-theme.typ`. Otherwise artifactType selects
 * bundled editorial (PRD), analytics (research), or decision (ADR/RFC) layouts.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { BRAND, BRAND_TOKENS } from './brand-tokens.mjs';

export { BRAND, BRAND_TOKENS };

export const ARTIFACT_TEMPLATE_MAP = {
  prd: 'construct-prd.typ',
  'prd-platform': 'construct-prd.typ',
  'prd-business': 'construct-prd.typ',
  'meta-prd': 'construct-prd.typ',
  strategy: 'construct-prd.typ',
  runbook: 'construct-prd.typ',
  memo: 'construct-prd.typ',
  'one-pager': 'construct-prd.typ',
  prfaq: 'construct-prd.typ',
  'backlog-proposal': 'construct-prd.typ',
  'customer-profile': 'construct-prd.typ',
  'test-plan': 'construct-prd.typ',
  'qa-strategy': 'construct-prd.typ',
  'changelog-entry': 'construct-prd.typ',
  'incident-report': 'construct-prd.typ',
  postmortem: 'construct-prd.typ',
  'research-brief': 'construct-research.typ',
  'evidence-brief': 'construct-research.typ',
  'signal-brief': 'construct-research.typ',
  'research-finding': 'construct-research.typ',
  'product-intelligence-report': 'construct-research.typ',
  adr: 'construct-decision.typ',
  rfc: 'construct-decision.typ',
  'rfc-platform': 'construct-decision.typ',
  'security-audit-report': 'construct-decision.typ',
};

const FALLBACK_TEMPLATE = 'construct-pdf.typ';

export function bundledTemplateDir(repoRoot) {
  return path.join(repoRoot, 'templates', 'distribution');
}

export function distributionFontsDir(repoRoot) {
  return path.join(bundledTemplateDir(repoRoot), 'fonts');
}

export function resolvePdfTemplatePath({
  artifactType = null,
  cwd = process.cwd(),
  repoRoot,
} = {}) {
  const root = repoRoot || cwd;
  const projectOverride = path.join(cwd, '.cx', 'publish-theme.typ');
  if (fs.existsSync(projectOverride)) return projectOverride;

  const dir = bundledTemplateDir(root);
  const mapped = artifactType ? ARTIFACT_TEMPLATE_MAP[artifactType] : null;
  if (mapped) {
    const typePath = path.join(dir, mapped);
    if (fs.existsSync(typePath)) return typePath;
  }

  const fallback = path.join(dir, FALLBACK_TEMPLATE);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

export function templateForArtifactType(artifactType) {
  if (!artifactType) return FALLBACK_TEMPLATE;
  return ARTIFACT_TEMPLATE_MAP[artifactType] || FALLBACK_TEMPLATE;
}

export function formatPublishDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCoverDuplicatesFromBody(body, metadata = {}) {
  let out = String(body || '').replace(/^\s+/, '');
  const title = metadata.title?.trim();
  if (title) {
    const h1Re = new RegExp(`^#\\s+${escapeRegExp(title)}\\s*\\n+`, 'i');
    out = out.replace(h1Re, '');
  }
  const lines = out.split('\n');
  while (lines.length && /^-\s+\*\*(Date|Owner|Status):?\*\*:?/i.test(lines[0].trim())) {
    lines.shift();
  }
  while (lines.length && lines[0].trim() === '') lines.shift();
  return `${lines.join('\n')}\n`;
}

export function preprocessMarkdownForPdfExport(content, metadata = {}) {
  if (!metadata?.title) return content;
  if (!content.startsWith('---')) return stripCoverDuplicatesFromBody(content, metadata);
  const end = content.indexOf('\n---', 3);
  if (end === -1) return stripCoverDuplicatesFromBody(content, metadata);
  const frontmatter = content.slice(0, end + 4);
  const body = stripCoverDuplicatesFromBody(content.slice(end + 4), metadata);
  return `${frontmatter}\n${body}`;
}

export function parseArtifactMetadata(inputPath) {
  const content = fs.readFileSync(inputPath, 'utf8');
  let fm = {};
  let body = content;
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      try {
        fm = yaml.load(content.slice(3, end)) || {};
      } catch {
        fm = {};
      }
      body = content.slice(end + 4);
    }
  }

  // Authors write both `**Date**: x` and `**Date:** x`; the contract accepts
  // either so the masthead never silently loses a field to colon placement.

  const h1 = body.match(/^#\s+(.+)$/m);
  const ownerMatch = body.match(/\*\*Owner:?\*\*:?\s*(\S+)/i);
  const dateMatch = body.match(/\*\*Date:?\*\*:?\s*(\S+)/i);

  return {
    title: fm.title || (h1 ? h1[1].trim() : path.basename(inputPath, path.extname(inputPath))),
    subtitle: fm.subtitle || '',
    date: formatPublishDate(fm.date || fm.last_verified_at || (dateMatch ? dateMatch[1] : '')),
    status: fm.status || '',
    owner: fm.owner || (ownerMatch ? ownerMatch[1] : ''),
    artifactType: fm.artifactType || fm.artifact_type || '',
    version: fm.version != null ? String(fm.version) : '',
    docId: fm.doc_id || fm.docId || '',
    classification: fm.classification || '',
  };
}

export function pandocMetadataArgs(metadata = {}) {
  const args = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value == null || value === '') continue;
    const safe = String(value).replace(/"/g, '\\"');
    args.push('-M', `${key}=${safe}`);
  }
  return args;
}
