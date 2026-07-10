/**
 * lib/packs/core-pack.mjs — programmatic builtin core pack loader.
 *
 * Reads specialists/org/ directory structure and wraps it as the
 * @construct/core pack. This is the builtin tier pack that provides
 * all default specialists, teams, prompts, and reasoning frameworks
 * (ADR-0062) shipped with Construct.
 *
 * `embedBindings` (LMCP-E4) ships default per-specialist provider read/
 * search grants and write-proposal grants for the built-in specialists most
 * likely to run embedded: cx-product-manager, cx-operations, cx-engineer.
 * These are defaults only — a project may override them via a project-tier
 * pack (.cx/packs) under the same specialist id.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

// Default per-specialist embed bindings (LMCP-E4). Read/search only — no
// specialist gets an autonomous write; `proposals` names the write kinds a
// specialist may propose, and every proposal still passes through
// AuthorityGuard's approval-queued path before anything executes.
const DEFAULT_EMBED_BINDINGS = Object.freeze({
  'cx-product-manager': {
    providers: [
      { id: 'atlassian-jira', capabilities: ['read', 'search'] },
      { id: 'atlassian-confluence', capabilities: ['read', 'search'] },
    ],
    proposals: ['atlassian-jira.createIssue'],
  },
  'cx-operations': {
    providers: [
      { id: 'atlassian-jira', capabilities: ['read', 'search'] },
      { id: 'atlassian-confluence', capabilities: ['read', 'search'] },
      { id: 'slack', capabilities: ['read', 'search'] },
    ],
    proposals: ['atlassian-jira.createIssue', 'slack.postMessage'],
  },
  'cx-engineer': {
    providers: [
      { id: 'github', capabilities: ['read', 'search'] },
      { id: 'atlassian-jira', capabilities: ['read', 'search'] },
    ],
    proposals: ['github.createIssue'],
  },
});

export function loadCorePack(rootDir = PACKAGE_ROOT) {
  const orgDir = join(rootDir, 'specialists', 'org');
  const specialistDir = join(orgDir, 'specialists');
  const teamDir = join(orgDir, 'teams');
  const frameworkDir = join(orgDir, 'frameworks');

  const specialists = existsSync(specialistDir)
    ? readdirSync(specialistDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
    : [];

  const teams = existsSync(teamDir)
    ? readdirSync(teamDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
    : [];

  const prompts = {};
  for (const specId of specialists) {
    try {
      const spec = JSON.parse(readFileSync(join(specialistDir, `${specId}.json`), 'utf8'));
      if (spec.promptFile) prompts[specId] = spec.promptFile;
    } catch {}
  }

  // frameworks map keys by frontmatter `id` (not filename) so a project-tier
  // override in .cx/packs can declare the same id from a differently named
  // file and still win under mergePackTiers/resolveFramework precedence.
  const frameworks = {};
  if (existsSync(frameworkDir)) {
    for (const file of readdirSync(frameworkDir).filter(f => f.endsWith('.md'))) {
      try {
        const raw = readFileSync(join(frameworkDir, file), 'utf8');
        const match = raw.match(FRONTMATTER_RE);
        const fm = match ? yaml.load(match[1]) : null;
        if (fm?.id) frameworks[fm.id] = join('specialists', 'org', 'frameworks', file);
      } catch {}
    }
  }

  // Only bind specialists actually present on disk — a stripped-down or
  // customized org directory should not surface bindings for personas it
  // doesn't ship.
  const embedBindings = {};
  for (const [specId, binding] of Object.entries(DEFAULT_EMBED_BINDINGS)) {
    if (specialists.includes(specId)) embedBindings[specId] = binding;
  }

  return {
    id: '@construct/core',
    version: '0.0.0',
    compatVersion: 1,
    teams,
    specialists,
    prompts,
    embedBindings,
    frameworks,
    _tier: 'builtin',
    _sourceDir: orgDir,
  };
}