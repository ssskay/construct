#!/usr/bin/env node
/**
 * scripts/migrate-skill-frontmatter.mjs — One-shot migration from HTML-comment
 * headers to YAML frontmatter on every file under skills/.
 *
 * Source shape (before):
 *   <!--
 *   skills/<path>.md (Display Name) <description>
 *   ...
 *   -->
 *   [optional ---\n<yaml>\n--- block, role files only]
 *   # Title
 *   <body>
 *
 * Target shape (after):
 *   ---
 *   name: <kebab-case-derived-from-path>      # ^[a-z0-9][a-z0-9-]*$, ≤64 chars
 *   description: "..."                         # third-person, includes Use when …, ≤1024 chars
 *   <preserved role/applies_to/inherits/version/profiles/cap for role files>
 *   ---
 *   # Title
 *   <body>
 *
 * Description-extraction precedence:
 *   1. Body line matching /^use\s+when[: ]/i (most reliable; many skills already
 *      have a "Use when: ..." trigger line as the first body paragraph).
 *   2. HTML comment description text, cleaned of markdown bleed (| # etc.).
 *   3. First clean body paragraph after the H1, capped to one sentence.
 *
 * Role files (skills/roles/*.md) get a programmatically-generated description
 * from role name + applies_to, replacing the generic "Anti-pattern guidance
 * for the <role> role" stub that every role file currently shares.
 *
 * Usage:
 *   node scripts/migrate-skill-frontmatter.mjs           # dry-run (default, safe)
 *   node scripts/migrate-skill-frontmatter.mjs --apply   # write changes
 *   node scripts/migrate-skill-frontmatter.mjs --only=roles  # limit by path substring
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

const DESCRIPTION_MAX = 1024;
const NAME_MAX = 64;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = args.find((a) => a.startsWith('--only='))?.split('=')[1] || null;

function walkSkills(dir) {
  const results = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'routing.md') {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results.sort();
}

function relSkillPath(absPath) {
  return path.relative(SKILLS_DIR, absPath).replace(/\.md$/, '');
}

// Map a skill path to a spec-compliant kebab-case name.
// Examples:
//   roles/architect.ai-systems → roles-architect-ai-systems
//   devops/git-workflow        → devops-git-workflow

function nameFromPath(relPath) {
  return relPath.replace(/[/.]/g, '-').toLowerCase();
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
  let s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.startsWith('|') || s.startsWith('#') || s.startsWith('---')) return null;
  if (/\|\s*\w+.*\|\s*\w+/.test(s)) return null;
  if (/<[A-Za-z][^>]*>/.test(s)) return null;
  if (/```/.test(s)) return null;
  return s;
}

function extractTitle(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function fallbackFromTitle(body, relPath) {
  const title = extractTitle(body);
  const topic = title || relPath.split('/').pop().replace(/[-.]/g, ' ');
  return `Patterns, anti-patterns, and reference guidance for ${topic}. Use when the task involves ${topic.toLowerCase()}.`;
}

// Prefer the body's `Use when:` line — it's the most reliable trigger source
// across the corpus and avoids the HTML-comment-bleed bug entirely.

function extractUseWhenFromBody(body) {
  const lines = body.split('\n');
  let pastH1 = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('# ')) { pastH1 = true; continue; }
    if (!pastH1) continue;
    if (line.startsWith('##') || line.startsWith('<!--')) break;
    if (/^use\s+when[: ]/i.test(line) || /^use\s+this\s+(skill\s+)?(when|to|for)/i.test(line)) {
      const collected = [line];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) break;
        if (next.startsWith('#') || next.startsWith('|') || next.startsWith('-')) break;
        collected.push(next);
      }
      return cleanCandidate(collected.join(' '));
    }
    break;
  }
  return null;
}

function commentHasBleed(htmlComment) {
  if (!htmlComment) return false;
  return /\|\s*\w+.*\|/.test(htmlComment) || /##/.test(htmlComment) || /```/.test(htmlComment);
}

function oneCleanSentence(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const m = trimmed.match(/^[\s\S]{20,}?[.!?](?=\s|$)/);
  if (m) return m[0].trim();
  const trailing = trimmed.replace(/[.!?]?\s+\S{1,3}\.?$/, '');
  return (trailing.length >= 15 ? trailing : trimmed);
}

function extractDescriptionFromHtmlComment(htmlComment, relPath) {
  if (!htmlComment) return null;
  if (commentHasBleed(htmlComment)) return null;
  const lines = htmlComment.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const pathPrefix = `skills/${relPath}.md`;
  const first = lines[0];
  let rest = first.startsWith(pathPrefix) ? first.slice(pathPrefix.length) : first;
  rest = rest.replace(/^\s*[.:]\s*/, '');
  const parenMatch = rest.match(/^\s*\(([^)]+)\)\s*(.*)$/);
  if (parenMatch) rest = parenMatch[2];
  const candidate = cleanCandidate(rest);
  if (candidate && candidate.length > 10) return oneCleanSentence(candidate);
  for (let i = 1; i < lines.length; i++) {
    const c = cleanCandidate(lines[i]);
    if (c && c.length > 10 && !c.startsWith('Loaded at sync') && !c.startsWith('Covers common')) {
      return oneCleanSentence(c);
    }
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

function firstSentence(text, max = DESCRIPTION_MAX) {
  if (!text) return text;
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const m = trimmed.match(/^[\s\S]{40,}?[.!?](?=\s|$)/);
  if (m && m[0].length <= max) return m[0];
  return trimmed.slice(0, max - 1) + '…';
}

function ensureUseWhen(desc, fallback) {
  if (!desc) return fallback;
  if (/use\s+when|use\s+this/i.test(desc)) return desc;
  return `${desc.replace(/[.!?]+$/, '')}. ${fallback}`;
}

const ACRONYMS = new Set(['ai', 'ml', 'ui', 'ux', 'api', 'sre', 'qa', 'rd', 'sql', 'llm', 'cli', 'mcp', 'sdk', 'aws', 'gcp', 'k8s', 'ci', 'cd']);

function titleCase(s) {
  return s.split(/\s+/).map((w) => {
    if (!w) return w;
    if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ');
}

function generateRoleDescription(role, appliesTo) {
  const parts = role.split('.').map((p) => titleCase(p.replace(/-/g, ' ')));
  const roleLabel = parts.join(' — ');
  const specialists = Array.isArray(appliesTo) && appliesTo.length
    ? appliesTo.join(', ')
    : null;
  const useWhen = specialists
    ? `Use when reviewing or generating work by ${specialists}, or when an agent is acting in the ${roleLabel} role.`
    : `Use when an agent is acting in the ${roleLabel} role.`;
  return `Surfaces anti-patterns, failure modes, and counter-moves specific to the ${roleLabel} role. ${useWhen}`;
}

function buildDescription({ relPath, htmlComment, existingYaml, body }) {
  if (relPath.startsWith('roles/') && existingYaml?.role) {
    return generateRoleDescription(existingYaml.role, existingYaml.applies_to);
  }
  const fallback = 'Use when the task matches the trigger conditions described in the body.';
  const fromBody = extractUseWhenFromBody(body);
  if (fromBody) return firstSentence(fromBody);
  const fromComment = extractDescriptionFromHtmlComment(htmlComment, relPath);
  if (fromComment) return firstSentence(ensureUseWhen(fromComment, fallback));
  const fromParagraph = extractFirstParagraph(body);
  if (fromParagraph) return firstSentence(ensureUseWhen(fromParagraph, fallback));
  return fallbackFromTitle(body, relPath);
}

function buildFrontmatter(name, description, existingYaml) {
  const out = { name, description };
  if (existingYaml && typeof existingYaml === 'object' && !existingYaml._parseError) {
    for (const key of ['role', 'applies_to', 'inherits', 'version', 'profiles', 'cap']) {
      if (key in existingYaml) out[key] = existingYaml[key];
    }
  }
  return yaml.dump(out, { lineWidth: 1200, noRefs: true, quotingType: '"', forceQuotes: false });
}

function validateName(name) {
  if (!NAME_RE.test(name)) return `name "${name}" violates ${NAME_RE}`;
  if (name.length > NAME_MAX) return `name "${name}" exceeds ${NAME_MAX} chars`;
  if (/\banthropic\b|\bclaude\b/.test(name)) return `name "${name}" contains reserved token`;
  return null;
}

function validateDescription(desc) {
  if (!desc) return 'description is empty';
  if (desc.length > DESCRIPTION_MAX) return `description ${desc.length} > ${DESCRIPTION_MAX}`;
  if (/<[A-Za-z][^>]*>/.test(desc)) return 'description contains XML/HTML tags';
  if (!/use\s+when|use\s+this/i.test(desc)) return 'description missing "use when" trigger clause';
  return null;
}

function migrateFile(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  const relPath = relSkillPath(absPath);
  const parsed = parseSource(content);
  const name = nameFromPath(relPath);
  const description = buildDescription({ ...parsed, relPath });

  const nameErr = validateName(name);
  const descErr = validateDescription(description);

  const frontmatter = buildFrontmatter(name, description, parsed.existingYaml);
  const newContent = `---\n${frontmatter}---\n${parsed.body.replace(/^\n+/, '')}`;

  const hadBleed = !!(parsed.htmlComment && (/\|\s*\w+.*\|/.test(parsed.htmlComment) || /##/.test(parsed.htmlComment)));

  if (APPLY && !nameErr && !descErr && newContent !== content) {
    fs.writeFileSync(absPath, newContent, 'utf8');
  }
  return { relPath, name, description, nameErr, descErr, hadBleed, changed: newContent !== content };
}

function main() {
  const files = walkSkills(SKILLS_DIR).filter((f) => !ONLY || relSkillPath(f).includes(ONLY));
  const results = [];
  for (const f of files) {
    try { results.push(migrateFile(f)); }
    catch (err) { results.push({ relPath: relSkillPath(f), error: err.message }); }
  }

  const errors = results.filter((r) => r.nameErr || r.descErr || r.error);
  const bleed = results.filter((r) => r.hadBleed);

  process.stdout.write(`Scanned ${results.length} skill files (${APPLY ? 'APPLY' : 'dry-run'}).\n`);
  process.stdout.write(`Bleed cases detected and cleaned: ${bleed.length}\n`);
  process.stdout.write(`Validation errors: ${errors.length}\n\n`);

  if (errors.length) {
    for (const e of errors) {
      process.stdout.write(`  ✗ ${e.relPath}: ${e.error || e.nameErr || e.descErr}\n`);
    }
    process.exit(1);
  }

  const sample = results.slice(0, 6);
  process.stdout.write('Sample generated frontmatter (first 6):\n');
  for (const r of sample) {
    process.stdout.write(`\n  ${r.relPath}\n`);
    process.stdout.write(`    name: ${r.name}\n`);
    const desc = r.description.length > 180 ? r.description.slice(0, 180) + '…' : r.description;
    process.stdout.write(`    description: ${desc}\n`);
  }
  if (!APPLY) process.stdout.write('\nRe-run with --apply to write changes.\n');
}

main();
