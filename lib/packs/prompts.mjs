/**
 * lib/packs/prompts.mjs — pack prompt-file validation and registry resolution.
 *
 * A pack manifest's `prompts` map declares `{ specialistId: relativePath }`,
 * relative to that pack's own directory (`_packDir`, set by
 * lib/packs/loader.mjs for every manifest-loaded pack) — a project pack's
 * prompt paths are relative to the project, not to the Construct install.
 * The core pack (lib/packs/core-pack.mjs) has no `_packDir`; its prompts map
 * uses paths relative to `packageRoot` (the Construct install), the fallback
 * root used whenever a pack carries no `_packDir` of its own.
 *
 * validatePackPrompts() confirms every declared file exists AND carries
 * parseable YAML frontmatter with a `role` field — the two things worker.mjs
 * needs before it can trust a persona prompt. In team/enterprise deployment
 * mode a miss is a hard load-time error (the pack is rejected, naming the
 * missing file) per LMCP-E2: a governed pack must never let a specialist run
 * under the wrong persona.
 *
 * resolvePersonaPrompt() is the ONLY path worker.mjs uses to read a persona
 * body: a walk of the pack list in the order given (the caller sorts by tier
 * precedence — project before user before builtin, per ADR-0055), returning
 * the first pack that declares the role, or `{ found: false }` when no pack
 * in the registry declares it. No fallback to reading specialists/prompts/
 * directly exists — that would defeat the pack boundary the registry is
 * meant to enforce.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  try {
    return yaml.load(match[1]) || {};
  } catch {
    return null;
  }
}

function packPromptRoot(pack, fallbackRoot) {
  return pack?._packDir || fallbackRoot;
}

/**
 * Validate every prompt file a pack declares.
 *
 * @param {object} pack        a manifest object carrying `prompts: {id: relPath}`
 * @param {object} opts
 * @param {string} opts.packageRoot   fallback root for packs with no `_packDir` (e.g. the core pack)
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePackPrompts(pack, { packageRoot } = {}) {
  const errors = [];
  const prompts = pack?.prompts || {};
  const root = packPromptRoot(pack, packageRoot);

  for (const [specId, relPath] of Object.entries(prompts)) {
    if (typeof relPath !== 'string' || !relPath) {
      errors.push(`pack '${pack.id}': prompt entry for '${specId}' has no file path`);
      continue;
    }
    const absPath = join(root, relPath);
    if (!existsSync(absPath)) {
      errors.push(`pack '${pack.id}': declared prompt file missing for '${specId}': ${relPath}`);
      continue;
    }
    let raw;
    try {
      raw = readFileSync(absPath, 'utf8');
    } catch (err) {
      errors.push(`pack '${pack.id}': declared prompt file unreadable for '${specId}': ${relPath} (${err.message})`);
      continue;
    }
    const fm = parseFrontmatter(raw);
    if (!fm) {
      errors.push(`pack '${pack.id}': prompt file missing or invalid frontmatter for '${specId}': ${relPath}`);
      continue;
    }
    if (!fm.role || typeof fm.role !== 'string') {
      errors.push(`pack '${pack.id}': prompt frontmatter missing 'role' for '${specId}': ${relPath}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Resolve one specialist's persona prompt through the pack registry only.
 *
 * Packs are tried in the order given (the caller sorts by tier precedence;
 * see the module header) — the first pack declaring the role wins.
 *
 * @param {string} role         specialist id, e.g. 'cx-engineer' (accepts 'engineer' too)
 * @param {object} opts
 * @param {object[]} opts.packs      pack list, tier-precedence ordered (see loadAllPacks)
 * @param {string} opts.packageRoot  fallback root for packs with no `_packDir` (e.g. the core pack)
 * @returns {{found: true, content: string, packId: string} | {found: false}}
 */
export function resolvePersonaPrompt(role, { packs, packageRoot }) {
  const slug = String(role || '').replace(/^cx-/, '');
  const specId = `cx-${slug}`;

  for (const pack of packs || []) {
    const relPath = pack?.prompts?.[specId];
    if (!relPath) continue;
    const absPath = join(packPromptRoot(pack, packageRoot), relPath);
    if (!existsSync(absPath)) continue;
    try {
      return { found: true, content: readFileSync(absPath, 'utf8'), packId: pack.id };
    } catch {
      continue;
    }
  }

  return { found: false };
}
