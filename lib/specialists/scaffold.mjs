/**
 * lib/specialists/scaffold.mjs — scaffold and field-edit hybrid specialist prompts.
 *
 * The CLI harness side of ADR-0037: `construct specialist create` emits a
 * canonical skeleton (frontmatter + required sections) a human then fills in,
 * and `construct specialist edit` mutates frontmatter fields only (never the
 * prose body). Both validate against lib/specialists/prompt-schema.mjs before
 * declaring success, so a scaffolded file passes `lint:prompts` immediately.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { splitFrontmatter, validatePromptContent, PERSPECTIVE_FIELDS } from './prompt-schema.mjs';

function promptRelPath(role) {
  return path.join('specialists', 'prompts', `cx-${role}.md`);
}

/**
 * Render a canonical skeleton for a new specialist. Body sections are stubbed
 * with a one-line placeholder so the file is valid-shaped from creation.
 */
export function renderSkeleton({ role, perspective = {}, roleGuidance } = {}) {
  const fm = {
    name: `cx-${role}`,
    role,
    version: 1,
    perspective: {
      bias: perspective.bias || 'TODO: what this role is instinctively suspicious of',
      tension: perspective.tension || 'cx-TODO',
      openingQuestion: perspective.openingQuestion || 'TODO: the first diagnostic question',
      failureMode: perspective.failureMode || 'TODO: how this role fails when absent',
    },
    ...(roleGuidance ? { roleGuidance } : {}),
  };
  const body = [
    '## Orientation',
    '',
    'TODO: the role voice — the hard-won instinct that makes this specialist worth consulting.',
    '',
    '## Anti-fabrication contract',
    '',
    'Every load-bearing claim cites a source the reader can re-verify. When a fact is not in the source, write `unknown` or `[unverified]`. See `rules/common/no-fabrication.md`.',
    '',
    '## Output format',
    '',
    'TODO: the artifact this role produces, or the `get_template(...)` it delegates to.',
    '',
  ].join('\n');
  return `---\n${yaml.dump(fm).trimEnd()}\n---\n\n${body}`;
}

function buildFrontmatterFromRegistry(role, { perspective, roleGuidance, roleOverlays, docArtifacts } = {}) {
  if (!perspective || typeof perspective !== 'object') {
    throw new Error(`perspective is required to wrap legacy prompt cx-${role} (frontmatter is the source of truth)`);
  }
  const fm = {
    name: `cx-${role}`,
    role,
    version: 1,
    perspective,
  };
  if (roleGuidance) fm.roleGuidance = roleGuidance;
  if (Array.isArray(roleOverlays) && roleOverlays.length) fm.roleOverlays = roleOverlays;
  if (Array.isArray(docArtifacts) && docArtifacts.length) fm.templates = docArtifacts;
  return fm;
}

/**
 * Wrap a legacy prompt body with hybrid frontmatter from the registry entry.
 * The body bytes are preserved (emit-neutral) aside from a trailing newline.
 */
export function wrapLegacyPromptWithFrontmatter({ role, perspective, registryEntry = {}, body }) {
  const fm = buildFrontmatterFromRegistry(role, {
    perspective,
    roleGuidance: registryEntry.roleGuidance,
    roleOverlays: registryEntry.roleOverlays,
    docArtifacts: registryEntry.docArtifacts,
  });
  const normalizedBody = String(body ?? '').replace(/^\n+/, '');
  const withNl = normalizedBody.endsWith('\n') ? normalizedBody : `${normalizedBody}\n`;
  return `---\n${yaml.dump(fm).trimEnd()}\n---\n\n${withNl}`;
}

/**
 * Convert one on-disk legacy prompt to hybrid format in place.
 * @returns {{ path: string, relPath: string, converted: boolean }}
 */
export function convertLegacyPromptFile({ rootDir = process.cwd(), role, perspective, registryEntry } = {}) {
  const relPath = promptRelPath(role);
  const filePath = path.join(rootDir, relPath);
  if (!fs.existsSync(filePath)) throw new Error(`${relPath} does not exist`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter) return { path: filePath, relPath, converted: false };

  const persp = perspective ?? registryEntry?.perspective;
  if (!persp) {
    throw new Error(`perspective required to convert ${relPath} — pass explicitly or supply registryEntry.perspective`);
  }
  const content = wrapLegacyPromptWithFrontmatter({ role, perspective: persp, registryEntry, body });
  const { errors } = validatePromptContent({ content, id: `cx-${role}`, registryEntry });
  if (errors.length) throw new Error(`convert ${relPath} failed:\n  ${errors.join('\n  ')}`);

  fs.writeFileSync(filePath, content);
  return { path: filePath, relPath, converted: true };
}

/**
 * Create a specialist prompt draft on disk. Refuses to overwrite. Validates
 * the rendered skeleton before writing.
 * @returns {{ path: string, relPath: string }}
 */
export function createSpecialistDraft({ rootDir = process.cwd(), role, perspective, roleGuidance } = {}) {
  if (!role || !/^[a-z][a-z0-9-]*$/.test(role)) {
    throw new Error(`invalid role id "${role}" — use lowercase kebab-case (e.g. performance-auditor)`);
  }
  const relPath = promptRelPath(role);
  const filePath = path.join(rootDir, relPath);
  if (fs.existsSync(filePath)) throw new Error(`${relPath} already exists — refusing to overwrite`);

  const content = renderSkeleton({ role, perspective, roleGuidance });
  const { errors } = validatePromptContent({ content, id: `cx-${role}` });
  if (errors.length) throw new Error(`scaffold failed validation:\n  ${errors.join('\n  ')}`);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
  return { path: filePath, relPath };
}

/**
 * Edit a specialist's frontmatter only (never the prose body). Supported edits:
 * set a perspective field, add a role overlay, or bump the version.
 * @returns {{ path: string, frontmatter: object }}
 */
export function editSpecialistFrontmatter({ rootDir = process.cwd(), role, setPerspective = {}, addOverlay, bumpVersion = false } = {}) {
  const relPath = promptRelPath(role);
  const filePath = path.join(rootDir, relPath);
  if (!fs.existsSync(filePath)) throw new Error(`${relPath} does not exist`);

  const raw = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!frontmatter) throw new Error(`${relPath} has no frontmatter — convert it to the hybrid format first`);

  for (const [field, value] of Object.entries(setPerspective)) {
    if (!PERSPECTIVE_FIELDS.includes(field)) throw new Error(`unknown perspective field "${field}"`);
    frontmatter.perspective = { ...(frontmatter.perspective || {}), [field]: value };
  }
  if (addOverlay) {
    const overlays = new Set(Array.isArray(frontmatter.roleOverlays) ? frontmatter.roleOverlays : []);
    overlays.add(addOverlay);
    frontmatter.roleOverlays = [...overlays];
  }
  if (bumpVersion) {
    frontmatter.version = (Number.isInteger(frontmatter.version) ? frontmatter.version : 0) + 1;
  }

  const next = `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`;
  const { errors } = validatePromptContent({ content: next, id: `cx-${role}` });
  if (errors.length) throw new Error(`edit would break validation:\n  ${errors.join('\n  ')}`);

  fs.writeFileSync(filePath, next.endsWith('\n') ? next : `${next}\n`);
  return { path: filePath, frontmatter };
}
