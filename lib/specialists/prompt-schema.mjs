/**
 * lib/specialists/prompt-schema.mjs — validation for hybrid specialist prompt files.
 *
 * Specialist prompts are migrating from opaque free-form markdown to a hybrid
 * shape: YAML frontmatter (structured metadata) + markdown body (the authored
 * prose), mirroring skills/roles/*.md. This validates the frontmatter and the
 * canonical-section contract, and gates the highest-value invariant — the
 * frontmatter `perspective{}` is the sole source of truth (ADR-0037); registry.json
 * carries routing metadata only.
 *
 * A file with no frontmatter is treated as not-yet-converted: reported, never an
 * error, so the linter can run across a half-migrated corpus. Frontmatter is the
 * source of truth; section checks are warnings until the body-normalization
 * phase, so adding frontmatter alone never fails the gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { loadRegistry as loadRuntimeRegistry } from '../registry/loader.mjs';

export const REQUIRED_FRONTMATTER = ['name', 'role', 'version', 'perspective'];
export const PERSPECTIVE_FIELDS = ['bias', 'tension', 'openingQuestion', 'failureMode'];
export const OPTIONAL_FRONTMATTER = ['roleGuidance', 'roleOverlays', 'templates', 'preloadRoleGuidance'];
export const REQUIRED_SECTIONS = ['Anti-fabrication contract', 'Output format'];
export const CANONICAL_SECTIONS = [
  'Orientation', 'Anti-fabrication contract', 'Productive tension',
  'Opening question', 'Failure mode', 'Domain overlays', 'Output format',
];

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Split a prompt file into { frontmatter, body }. frontmatter is null when the
 * file has none (unconverted), or undefined when the YAML failed to parse.
 */
export function splitFrontmatter(text) {
  const raw = String(text ?? '');
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: null, body: raw };
  try {
    const fm = yaml.load(m[1]);
    return { frontmatter: (fm && typeof fm === 'object') ? fm : {}, body: raw.slice(m[0].length) };
  } catch (err) {
    return { frontmatter: undefined, body: raw.slice(m[0].length), error: err.message };
  }
}

function hasHeading(body, title) {
  const target = String(title).trim().toLowerCase();
  const re = /^#{1,6}\s+(.+)$/gm;
  let m;
  while ((m = re.exec(body))) {
    if (m[1].trim().toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Validate one prompt file's content against the hybrid format.
 *
 * @param {object} opts
 * @param {string} opts.content - raw file content
 * @param {string} [opts.id] - display id (cx-<role>) for messages
 * @param {object} [opts.registryEntry] - the matching registry specialist (for drift checks)
 * @returns {{ converted: boolean, errors: string[], warnings: string[] }}
 */
export function validatePromptContent({ content, id = '(prompt)', registryEntry } = {}) {
  const errors = [];
  const warnings = [];
  const { frontmatter, body, error } = splitFrontmatter(content);

  if (frontmatter === null) {
    return { converted: false, errors, warnings: [`${id}: no frontmatter — not yet converted to the hybrid format`] };
  }
  if (frontmatter === undefined) {
    errors.push(`${id}: frontmatter is not valid YAML — ${error}`);
    return { converted: true, errors, warnings };
  }

  for (const field of REQUIRED_FRONTMATTER) {
    if (frontmatter[field] == null || frontmatter[field] === '') {
      errors.push(`${id}: missing required frontmatter field "${field}"`);
    }
  }

  if (frontmatter.name && registryEntry?.name) {
    const expected = `cx-${registryEntry.name}`;
    if (frontmatter.name !== expected) {
      errors.push(`${id}: frontmatter name "${frontmatter.name}" must equal "${expected}" (registry name)`);
    }
  }
  if (frontmatter.version != null && !Number.isInteger(frontmatter.version)) {
    errors.push(`${id}: frontmatter version must be an integer (got ${JSON.stringify(frontmatter.version)})`);
  }

  const persp = frontmatter.perspective;
  if (persp && typeof persp === 'object') {
    for (const f of PERSPECTIVE_FIELDS) {
      if (!persp[f] || !String(persp[f]).trim()) errors.push(`${id}: perspective.${f} is required and must be non-empty`);
    }
  } else if (frontmatter.perspective != null) {
    errors.push(`${id}: perspective must be an object with ${PERSPECTIVE_FIELDS.join(', ')}`);
  }

  const known = new Set([...REQUIRED_FRONTMATTER, ...OPTIONAL_FRONTMATTER]);
  for (const key of Object.keys(frontmatter)) {
    if (!known.has(key)) warnings.push(`${id}: unknown frontmatter key "${key}"`);
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!hasHeading(body, section)) warnings.push(`${id}: missing canonical section "## ${section}" (warn-only until body normalization)`);
  }

  return { converted: true, errors, warnings };
}

/**
 * Validate every specialist prompt file referenced by the registry.
 * @returns {{ errors: string[], warnings: string[], total: number, converted: number }}
 */
export function validatePromptFiles({ rootDir = process.cwd(), registry } = {}) {
  const errors = [];
  const warnings = [];
  let total = 0;
  let converted = 0;

  const reg = registry ?? loadPromptRegistry(rootDir);
  const specialists = Array.isArray(reg?.specialists) ? reg.specialists : Object.values(reg?.specialists || {});
  const byName = new Map(specialists.map((s) => [s.name, s]));

  const seen = new Set();
  for (const entry of specialists) {
    if (!entry?.promptFile || !entry.promptFile.startsWith('specialists/prompts/')) continue;
    if (seen.has(entry.promptFile)) continue;
    seen.add(entry.promptFile);
    const filePath = path.join(rootDir, entry.promptFile);
    if (!fs.existsSync(filePath)) { errors.push(`${entry.name}: promptFile ${entry.promptFile} does not exist`); continue; }
    total += 1;
    const content = fs.readFileSync(filePath, 'utf8');
    const result = validatePromptContent({ content, id: `cx-${entry.name}`, registryEntry: byName.get(entry.name) });
    if (result.converted) converted += 1;
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { errors, warnings, total, converted };
}

function loadPromptRegistry(rootDir) {
  try {
    return loadRuntimeRegistry({ rootDir });
  } catch {
    return { specialists: [] };
  }
}

/**
 * Resolve a specialist's perspective from its prompt frontmatter.
 * @param {string} agentName - registry name or cx-prefixed id
 * @returns {object|null}
 */
export function resolvePerspectiveFromPrompt(agentName, { rootDir = process.cwd(), registry } = {}) {
  const reg = registry ?? loadPromptRegistry(rootDir);
  const normalized = String(agentName ?? '').trim().replace(/^cx-/, '');
  const entry = (reg.specialists ?? []).find((s) => s.name === normalized);
  if (!entry?.promptFile) return null;
  const filePath = path.join(rootDir, entry.promptFile);
  if (!fs.existsSync(filePath)) return null;
  const { frontmatter } = splitFrontmatter(fs.readFileSync(filePath, 'utf8'));
  const persp = frontmatter?.perspective;
  return persp && typeof persp === 'object' ? persp : null;
}
