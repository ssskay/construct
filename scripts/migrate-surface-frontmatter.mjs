#!/usr/bin/env node
/**
 * scripts/migrate-surface-frontmatter.mjs — Migrate HTML-comment headers to
 * YAML frontmatter on personas/, commands/, and rules/. Skills migrated
 * separately via scripts/migrate-skill-frontmatter.mjs.
 *
 * Per-surface shape:
 *   personas/   — HTML comment header, no YAML. Result: YAML with name + description.
 *   commands/   — HTML comment header + YAML below with `description:`. Result: drop comment.
 *   rules/      — HTML comment header + YAML below with `paths:`. Result: drop comment, add `description:` to YAML.
 *
 * Description-extraction precedence:
 *   1. Body line starting with "Use when:" / "Use this skill when ..." (rare on these surfaces).
 *   2. HTML comment description prose, cleaned of markdown bleed.
 *   3. First body paragraph after the H1, capped to one sentence.
 *
 * Usage:
 *   node scripts/migrate-surface-frontmatter.mjs --surface=personas [--apply]
 *   node scripts/migrate-surface-frontmatter.mjs --surface=commands [--apply]
 *   node scripts/migrate-surface-frontmatter.mjs --surface=rules    [--apply]
 *   node scripts/migrate-surface-frontmatter.mjs --surface=all      [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SURFACE = args.find((a) => a.startsWith('--surface='))?.split('=')[1] || 'all';

const SURFACES = {
  personas: { root: 'personas', requireDescription: true, mergeExistingYaml: false, nameFromPath: true },
  commands: { root: 'commands', requireDescription: true, mergeExistingYaml: true,  nameFromPath: false },
  rules:    { root: 'rules',    requireDescription: true, mergeExistingYaml: true,  nameFromPath: false },
};

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function nameFromPath(absPath, surfaceRoot) {
  const rel = path.relative(path.join(REPO_ROOT, surfaceRoot), absPath).replace(/\.md$/, '');
  return rel.replace(/[/.]/g, '-').toLowerCase();
}

function parseSource(content) {
  const lines = content.split('\n');
  let i = 0;
  let htmlComment = null;
  let existingYaml = null;

  if (lines[0]?.trim() === '<!--') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '-->');
    if (end > 0) {
      htmlComment = lines.slice(1, end).join('\n');
      i = end + 1;
      while (i < lines.length && lines[i].trim() === '') i++;
    }
  }
  if (lines[i]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > i && l.trim() === '---');
    if (end > i) {
      try { existingYaml = yaml.load(lines.slice(i + 1, end).join('\n')) || {}; }
      catch (err) { existingYaml = { _parseError: err.message }; }
      i = end + 1;
      while (i < lines.length && lines[i].trim() === '') i++;
    }
  }
  return { htmlComment, existingYaml, body: lines.slice(i).join('\n') };
}

function cleanCandidate(text) {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.startsWith('|') || s.startsWith('#') || s.startsWith('---') || s.startsWith('>')) return null;
  if (/\|\s*\w+.*\|\s*\w+/.test(s)) return null;
  if (/<[^>]+>/.test(s)) return null;
  if (/```/.test(s)) return null;
  if (/\{[a-z_]+\}/i.test(s)) return null;
  return s;
}

function oneCleanSentence(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const m = trimmed.match(/^[\s\S]{20,}?[.!?](?=\s|$)/);
  if (m) return m[0].trim();
  return trimmed;
}

function commentHasBleed(c) {
  if (!c) return false;
  return /\|\s*\w+.*\|/.test(c) || /##/.test(c) || /```/.test(c);
}

function extractDescriptionFromComment(htmlComment, surfaceRoot, fileRel) {
  if (!htmlComment || commentHasBleed(htmlComment)) return null;
  const lines = htmlComment.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const pathPrefix = `${surfaceRoot}/${fileRel}`;
  const first = lines[0];
  let rest = first.startsWith(pathPrefix) ? first.slice(pathPrefix.length) : first;
  rest = rest.replace(/^\s*[.:]\s*/, '');
  const parenMatch = rest.match(/^\s*\(([^)]+)\)\s*(.*)$/);
  if (parenMatch) rest = parenMatch[2];
  const candidate = cleanCandidate(rest);
  if (candidate && candidate.length > 10) return oneCleanSentence(candidate);
  for (let i = 1; i < lines.length; i++) {
    const c = cleanCandidate(lines[i]);
    if (c && c.length > 10 && !c.startsWith('Loaded at sync')) return oneCleanSentence(c);
  }
  return null;
}

function extractFirstParagraph(body) {
  const lines = body.split('\n');
  let pastH1 = false;
  const collected = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!pastH1) {
      if (line.startsWith('# ')) pastH1 = true;
      else if (line && !line.startsWith('#')) { pastH1 = true; collected.push(line); }
      continue;
    }
    if (!line) { if (collected.length) break; continue; }
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('-')) {
      if (collected.length) break;
      continue;
    }
    collected.push(line);
  }
  return cleanCandidate(collected.join(' '));
}

function ensureUseWhen(desc) {
  if (!desc) return desc;
  if (/use\s+when|use\s+this|use\s+to|use\s+for/i.test(desc)) return desc;
  return desc;
}

function buildDescription({ htmlComment, body, existingYaml, surfaceRoot, fileRel }) {
  if (existingYaml?.description && typeof existingYaml.description === 'string' && existingYaml.description.trim() && !/<[^>]+>/.test(existingYaml.description)) {
    return existingYaml.description.trim();
  }
  const fromComment = extractDescriptionFromComment(htmlComment, surfaceRoot, fileRel);
  if (fromComment) return ensureUseWhen(fromComment);
  const fromParagraph = extractFirstParagraph(body);
  if (fromParagraph) return ensureUseWhen(oneCleanSentence(fromParagraph));
  if (surfaceRoot === 'rules') {
    return generateRuleDescription(fileRel, existingYaml);
  }
  return null;
}

function generateRuleDescription(fileRel, existingYaml) {
  const parts = fileRel.replace(/\.md$/, '').split('/');
  const topic = parts[parts.length - 1].replace(/-/g, ' ');
  const lang = parts.length > 1 ? parts[0] : null;
  const paths = Array.isArray(existingYaml?.paths) ? existingYaml.paths : [];
  const pathHint = paths.length ? ` Applies to files matching ${paths.join(', ')}.` : '';
  if (lang && lang !== 'common') {
    return `Construct ${lang} ${topic} rule.${pathHint} Use when writing or reviewing ${lang} code that involves ${topic}.`;
  }
  return `Construct ${topic} rule. Use when ${topic} is in scope for the current change.`;
}

function buildYaml(out) {
  return yaml.dump(out, { lineWidth: 1200, noRefs: true, quotingType: '"', forceQuotes: false });
}

function migrateFile(absPath, surfaceKey) {
  const surface = SURFACES[surfaceKey];
  const content = fs.readFileSync(absPath, 'utf8');
  const parsed = parseSource(content);
  const fileRel = path.relative(path.join(REPO_ROOT, surface.root), absPath);

  const description = buildDescription({ ...parsed, surfaceRoot: surface.root, fileRel });

  const yamlOut = {};
  if (surface.nameFromPath) yamlOut.name = nameFromPath(absPath, surface.root);
  if (description) yamlOut.description = description;
  if (surface.mergeExistingYaml && parsed.existingYaml && !parsed.existingYaml._parseError) {
    for (const [k, v] of Object.entries(parsed.existingYaml)) {
      if (k in yamlOut) continue;
      yamlOut[k] = v;
    }
  }

  if (surface.requireDescription && !yamlOut.description) {
    return { absPath, changed: false, error: 'no description extracted' };
  }

  const newContent = `---\n${buildYaml(yamlOut)}---\n${parsed.body.replace(/^\n+/, '')}`;
  const changed = newContent !== content;
  if (APPLY && changed) fs.writeFileSync(absPath, newContent, 'utf8');
  return { absPath, changed, description: yamlOut.description };
}

function runSurface(surfaceKey) {
  const surface = SURFACES[surfaceKey];
  const root = path.join(REPO_ROOT, surface.root);
  if (!fs.existsSync(root)) {
    process.stdout.write(`  ${surfaceKey}: directory missing\n`);
    return { migrated: 0, errors: 0 };
  }
  const files = walk(root).sort();
  let migrated = 0;
  let errors = 0;
  for (const f of files) {
    try {
      const r = migrateFile(f, surfaceKey);
      if (r.error) { errors++; process.stdout.write(`    ✗ ${path.relative(REPO_ROOT, f)}: ${r.error}\n`); }
      else if (r.changed) migrated++;
    } catch (err) {
      errors++;
      process.stdout.write(`    ✗ ${path.relative(REPO_ROOT, f)}: ${err.message}\n`);
    }
  }
  process.stdout.write(`  ${surfaceKey}: ${migrated}/${files.length} migrated${APPLY ? '' : ' (dry-run)'}, ${errors} errors\n`);
  return { migrated, errors };
}

function main() {
  process.stdout.write(`migrate-surface-frontmatter (${APPLY ? 'APPLY' : 'dry-run'})\n`);
  const keys = SURFACE === 'all' ? Object.keys(SURFACES) : [SURFACE];
  let totalErrors = 0;
  for (const k of keys) {
    if (!SURFACES[k]) { process.stderr.write(`unknown surface: ${k}\n`); process.exit(2); }
    const r = runSurface(k);
    totalErrors += r.errors;
  }
  if (totalErrors > 0) process.exit(1);
}

main();
