/**
 * lib/frameworks/schema.mjs — ADR-0062 persona reasoning framework schema validator.
 *
 * A framework is Markdown with YAML frontmatter (same convention as
 * specialists/prompts/*.md). validateFrameworkFrontmatter() checks the
 * frontmatter object in isolation (required fields, step shape, unique
 * `emits` tokens, `cites` enum, known `appliesToRole`) — it never reads
 * files itself, so it is usable directly against a parsed object in tests.
 * parseFrameworkFile() does the frontmatter extraction plus validation for
 * a file on disk, mirroring lib/packs/prompts.mjs's parseFrontmatter shape.
 *
 * Invalid frameworks fail closed: every error names the offending field and
 * (when available) the file path, per ADR-0062 §4 — no silent skip.
 */

import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

const CITES_VALUES = new Set(['source', 'prior-step']);

const STEP_REQUIRED_FIELDS = ['id', 'move', 'question', 'emits', 'cites'];

const MIN_STEPS = 3;
const MAX_STEPS = 6;

export function knownRolesFromSpecialists(specialists) {
  const roles = new Set();
  for (const spec of specialists || []) {
    if (spec && typeof spec.role === 'string' && spec.role) roles.add(spec.role);
  }
  return roles;
}

/**
 * Validate a parsed frontmatter object against the ADR-0062 schema.
 *
 * @param {object} fm               parsed YAML frontmatter
 * @param {object} opts
 * @param {string} [opts.filePath]  for error-message prefixing
 * @param {Set<string>|string[]} [opts.knownRoles]  roles appliesToRole may name; skipped when omitted
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateFrameworkFrontmatter(fm, { filePath, knownRoles } = {}) {
  const prefix = filePath ? `${filePath}: ` : '';
  const errors = [];

  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    return { valid: false, errors: [`${prefix}frontmatter must be a YAML object`] };
  }

  if (!fm.id || typeof fm.id !== 'string') {
    errors.push(`${prefix}missing required field: id`);
  }
  if (fm.version === undefined || fm.version === null) {
    errors.push(`${prefix}missing required field: version`);
  }
  if (!fm.appliesToRole || typeof fm.appliesToRole !== 'string') {
    errors.push(`${prefix}missing required field: appliesToRole`);
  } else if (knownRoles) {
    const roles = knownRoles instanceof Set ? knownRoles : new Set(knownRoles);
    if (roles.size > 0 && !roles.has(fm.appliesToRole)) {
      errors.push(`${prefix}appliesToRole '${fm.appliesToRole}' is not a known role`);
    }
  }
  if (!fm.summary || typeof fm.summary !== 'string') {
    errors.push(`${prefix}missing required field: summary`);
  }

  if (!Array.isArray(fm.steps) || fm.steps.length === 0) {
    errors.push(`${prefix}steps must be a non-empty array`);
    return { valid: errors.length === 0, errors };
  }

  if (fm.steps.length < MIN_STEPS || fm.steps.length > MAX_STEPS) {
    errors.push(`${prefix}steps must contain ${MIN_STEPS}-${MAX_STEPS} entries (got ${fm.steps.length})`);
  }

  const emitsSeen = new Map();
  const stepIdsSeen = new Set();

  fm.steps.forEach((step, idx) => {
    const stepPrefix = `${prefix}steps[${idx}]`;

    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${stepPrefix}: must be an object`);
      return;
    }

    for (const field of STEP_REQUIRED_FIELDS) {
      if (!step[field] || typeof step[field] !== 'string') {
        errors.push(`${stepPrefix}: missing required field: ${field}`);
      }
    }

    if (step.id) {
      if (stepIdsSeen.has(step.id)) {
        errors.push(`${stepPrefix}: duplicate step id '${step.id}'`);
      }
      stepIdsSeen.add(step.id);
    }

    if (step.emits) {
      if (emitsSeen.has(step.emits)) {
        errors.push(
          `${prefix}emits token '${step.emits}' is not unique within the framework (also used by step '${emitsSeen.get(step.emits)}')`
        );
      } else {
        emitsSeen.set(step.emits, step.id || `steps[${idx}]`);
      }
    }

    if (step.cites && !CITES_VALUES.has(step.cites)) {
      errors.push(`${stepPrefix}: cites must be one of ${[...CITES_VALUES].join(', ')} (got '${step.cites}')`);
    }
  });

  return { valid: errors.length === 0, errors };
}

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  try {
    return yaml.load(match[1]) || {};
  } catch {
    return null;
  }
}

/**
 * Read and validate a framework file from disk.
 *
 * @param {string} filePath
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.knownRoles]
 * @returns {{valid: boolean, errors: string[], frontmatter: object|null, body: string|null}}
 */
export function parseFrameworkFile(filePath, { knownRoles } = {}) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { valid: false, errors: [`${filePath}: failed to read file (${err.message})`], frontmatter: null, body: null };
  }

  const fm = parseFrontmatter(raw);
  if (!fm) {
    return { valid: false, errors: [`${filePath}: missing or invalid frontmatter`], frontmatter: null, body: null };
  }

  const result = validateFrameworkFrontmatter(fm, { filePath, knownRoles });
  const body = raw.replace(FRONTMATTER_RE, '');

  return { valid: result.valid, errors: result.errors, frontmatter: fm, body };
}
