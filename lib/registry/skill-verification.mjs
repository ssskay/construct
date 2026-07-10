/**
 * lib/registry/skill-verification.mjs — verification-bar lint for workflow skills.
 *
 * docs/*-workflow.md skills must carry inputs, artifactType, and verificationBar
 * in YAML frontmatter so anti-slop gates apply to the skill layer.
 */

import fs from 'node:fs';
import path from 'node:path';
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

export function lintWorkflowSkillVerification(skillsRoot) {
  const errors = [];
  const warnings = [];
  const docsDir = path.join(skillsRoot, 'docs');
  if (!fs.existsSync(docsDir)) return { valid: true, errors, warnings, checked: 0 };

  for (const entry of fs.readdirSync(docsDir)) {
    if (!entry.endsWith('-workflow.md')) continue;
    const rel = `docs/${entry.replace(/\.md$/, '')}`;
    const filePath = path.join(docsDir, entry);
    const raw = fs.readFileSync(filePath, 'utf8');
    const fm = parseFrontmatter(raw);
    if (!fm) {
      errors.push(`${rel}: missing or invalid YAML frontmatter`);
      continue;
    }
    if (!fm.inputs || !Array.isArray(fm.inputs) || fm.inputs.length === 0) {
      warnings.push(`${rel}: missing frontmatter.inputs`);
    }
    if (!fm.artifactType || typeof fm.artifactType !== 'string') {
      warnings.push(`${rel}: missing frontmatter.artifactType`);
    }
    if (!fm.verificationBar || typeof fm.verificationBar !== 'string') {
      warnings.push(`${rel}: missing frontmatter.verificationBar`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checked: fs.readdirSync(docsDir).filter((f) => f.endsWith('-workflow.md')).length,
  };
}
