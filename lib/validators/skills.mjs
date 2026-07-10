/**
 * lib/validators/skills.mjs — Validate the structure of skill files.
 *
 * After the YAML-frontmatter migration, every skill file under `skills/` has:
 *
 *   ---
 *   name: <kebab-case>
 *   description: "<≤1024 chars, includes a 'use when' trigger>"
 *   [inputs: [<string>, …]  — optional, surfaced by capability discovery]
 *   [artifactType: <string> — optional, surfaced by capability discovery]
 *   [role/applies_to/inherits/version/scopes/cap for role files]
 *   ---
 *   # <Title>
 *   Use when: <trigger condition>
 *   <body>
 *
 * The validator splits findings into hard errors (block the build) and soft
 * warnings (surfaced by `construct doctor` without failing it):
 *
 *   Hard errors:
 *     - frontmatter missing or not parseable as YAML
 *     - name missing, > 64 chars, fails ^[a-z0-9][a-z0-9-]*$, or contains
 *       reserved tokens (anthropic, claude)
 *     - description missing, empty, > 1024 chars, contains XML/HTML tags,
 *       or missing a "use when" trigger clause
 *     - missing H1 title (in body)
 *     - title over 80 chars
 *     - duplicate relative paths across roots
 *     - unreadable file
 *
 *   Soft warnings:
 *     - body opener missing or doesn't match a "Use this skill when/to/for ..."
 *       form (YAML description is now primary; body opener is a behavioral hint)
 *     - body opener over 240 chars
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

const DESCRIPTION_MAX = 1024;
const NAME_MAX = 64;
const TITLE_MAX_CHARS = 80;
const BODY_OPENER_MAX = 240;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

const TRIGGER_PATTERN = /^(?:use\s+(?:this\s+(?:skill\s+)?)?(?:when|to|for|if)\b|when\s+to\s+use\b|trigger\s*:|use\s+when\s*:)/i;

function* walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield full;
  }
}

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };
  try {
    const parsed = yaml.load(match[1]) || {};
    return { frontmatter: parsed, body: content.slice(match[0].length) };
  } catch (err) {
    return { frontmatter: null, body: content.slice(match[0].length), yamlError: err.message };
  }
}

function extractTitleAndOpener(body) {
  const lines = body.split(/\r?\n/);
  let title = null;
  let opener = null;
  let inBody = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!title) {
      const m = line.match(/^#\s+(.+?)\s*$/);
      if (m) { title = m[1]; inBody = true; continue; }
    } else if (inBody && line && !line.startsWith('#') && !line.startsWith('<!--')) {
      opener = line;
      break;
    }
  }
  return { title, opener };
}

function validateName(name) {
  if (!name) return 'frontmatter.name is missing';
  if (typeof name !== 'string') return `frontmatter.name must be a string (got ${typeof name})`;
  if (!NAME_RE.test(name)) return `frontmatter.name "${name}" must match ${NAME_RE}`;
  if (name.length > NAME_MAX) return `frontmatter.name "${name}" exceeds ${NAME_MAX} chars`;
  if (/\banthropic\b|\bclaude\b/.test(name)) return `frontmatter.name "${name}" contains reserved token`;
  return null;
}

function validateDescription(description) {
  if (!description) return 'frontmatter.description is missing or empty';
  if (typeof description !== 'string') return `frontmatter.description must be a string (got ${typeof description})`;
  if (description.length > DESCRIPTION_MAX) return `frontmatter.description ${description.length} > ${DESCRIPTION_MAX} chars`;
  if (/<[A-Za-z][^>]*>/.test(description)) return 'frontmatter.description contains XML/HTML tags';
  if (!/use\s+when|use\s+this/i.test(description)) return 'frontmatter.description missing "use when" trigger clause';
  return null;
}

// Optional embedded-contract metadata: surfaced by capability discovery when
// present. Validated only when present so the field stays opt-in and is
// populated incrementally — inputs is a list of strings, artifactType a string.

function validateOptionalMetadata(frontmatter) {
  const issues = [];
  if ('inputs' in frontmatter && frontmatter.inputs !== null) {
    if (!Array.isArray(frontmatter.inputs) || frontmatter.inputs.some((i) => typeof i !== 'string')) {
      issues.push('frontmatter.inputs must be a list of strings when present');
    }
  }
  if ('artifactType' in frontmatter && frontmatter.artifactType !== null && typeof frontmatter.artifactType !== 'string') {
    issues.push('frontmatter.artifactType must be a string when present');
  }
  return issues;
}

export function validateSkills(roots) {
  const dirs = Array.isArray(roots) ? roots : [roots];
  const errors = [];
  const warnings = [];
  const skills = [];
  const seenRelative = new Map();
  const seenNames = new Map();

  for (const dir of dirs) {
    let exists = false;
    try { exists = statSync(dir).isDirectory(); } catch { exists = false; }
    if (!exists) continue;

    for (const filePath of walk(dir)) {
      const rel = path.relative(dir, filePath);
      if (rel === 'routing.md') continue;

      const prevSource = seenRelative.get(rel);
      if (prevSource) {
        errors.push(`duplicate skill path '${rel}' in ${prevSource} and ${dir}`);
      } else {
        seenRelative.set(rel, dir);
      }

      let raw;
      try { raw = readFileSync(filePath, 'utf8'); }
      catch (err) { errors.push(`${rel}: cannot read (${err.message})`); continue; }

      const { frontmatter, body, yamlError } = parseFrontmatter(raw);

      if (yamlError) {
        errors.push(`${rel}: frontmatter YAML parse error — ${yamlError}`);
        continue;
      }
      if (!frontmatter) {
        errors.push(`${rel}: missing YAML frontmatter block (---name/description---)`);
        continue;
      }

      const nameErr = validateName(frontmatter.name);
      if (nameErr) errors.push(`${rel}: ${nameErr}`);
      else {
        const dupName = seenNames.get(frontmatter.name);
        if (dupName) errors.push(`${rel}: duplicate frontmatter.name "${frontmatter.name}" (also in ${dupName})`);
        else seenNames.set(frontmatter.name, rel);
      }

      const descErr = validateDescription(frontmatter.description);
      if (descErr) errors.push(`${rel}: ${descErr}`);

      for (const issue of validateOptionalMetadata(frontmatter)) errors.push(`${rel}: ${issue}`);

      const { title, opener } = extractTitleAndOpener(body);

      if (!title) {
        errors.push(`${rel}: missing H1 title (e.g. "# Skill Name")`);
      } else if (title.length > TITLE_MAX_CHARS) {
        errors.push(`${rel}: title exceeds ${TITLE_MAX_CHARS} chars (got ${title.length})`);
      }

      if (!opener) {
        warnings.push(`${rel}: no trigger opener in body after the H1 — YAML description still primary, but body opener helps in-task behavior`);
      } else if (!TRIGGER_PATTERN.test(opener)) {
        warnings.push(`${rel}: body opener should start with "Use this skill when/to/for ..." (got "${opener.slice(0, 60)}…")`);
      } else if (opener.length > BODY_OPENER_MAX) {
        warnings.push(`${rel}: body opener exceeds ${BODY_OPENER_MAX} chars (got ${opener.length})`);
      }

      skills.push({ path: rel, name: frontmatter.name, description: frontmatter.description, title, opener });
    }
  }

  return { valid: errors.length === 0, errors, warnings, skills };
}
