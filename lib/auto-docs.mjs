/**
 * lib/auto-docs.mjs — regenerate managed regions in markdown docs and generated docs-site references.
 *
 * Managed regions are HTML comment markers in the form:
 *   <!-- AUTO:region-name -->
 *   content
 *   <!-- /AUTO:region-name -->
 *
 * Running regenerateDocs() is idempotent. With check:true it returns whether
 * anything would change without writing files — the mode CI uses to detect drift.
 *
 * buildSite() is retained for compatibility; the public site now renders docs/
 * directly through Next.js (apps/docs/) and buildFumadocsReference() emits
 * generated reference Markdown into docs/guides/reference/.
 */

import fs from 'node:fs';
import { loadRegistry } from './registry/loader.mjs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { CLI_COMMANDS_BY_CATEGORY, CATEGORY_ORDER } from './cli-commands.mjs';

// A raw `|` inside a markdown table cell is parsed as a column delimiter, so a
// description like `--scope=project|user|both` splits the row into phantom
// columns. Escape pipes (and flatten newlines) for any value emitted into a cell.

function tableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// --- region helpers ---

function replaceRegion(content, regionName, newBody) {
  const open = `<!-- AUTO:${regionName} -->`;
  const close = `<!-- /AUTO:${regionName} -->`;
  const before = content.indexOf(open);
  const after = content.indexOf(close);
  if (before === -1 || after === -1) return null;
  return content.slice(0, before + open.length) + '\n' + newBody + '\n' + content.slice(after);
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function writeIfChanged(filePath, newContent) {
  const existing = readFile(filePath);
  if (existing === newContent) return false;
  fs.writeFileSync(filePath, newContent, 'utf8');
  return true;
}

// --- region generators ---

function buildCommandsTable() {
  const rows = [];
  for (const category of CATEGORY_ORDER) {
    const cmds = CLI_COMMANDS_BY_CATEGORY[category] ?? [];
    if (!cmds.length) continue;
    rows.push(`### ${category}\n`);
    rows.push('| Command | What it does |');
    rows.push('|---|---|');
    for (const cmd of cmds) {
      rows.push(`| \`construct ${cmd.name}\` | ${tableCell(cmd.description)} |`);
    }
    rows.push('');
  }
  return rows.join('\n').trimEnd();
}

function buildCoreDocsContract() {
  return [
    '## Required core documents',
    '',
    '| File | Purpose | Update when |',
    '|---|---|---|',
    '| `AGENTS.md` | Canonical agent operating contract | Workflow rules, tracker hierarchy, or repo-wide guardrails change |',
    '| `.cx/context.md` | Human-readable resumable project context | Active work, decisions, architecture assumptions, or open questions change |',
    '| `.cx/context.json` | Machine-readable resumable context | Context state needs to stay in sync with `.cx/context.md` |',
    '| `docs/README.md` | Docs index and maintenance contract | Core docs set or maintenance expectations change |',
    '| `docs/guides/concepts/architecture.mdx` | Canonical architecture and invariants | Runtime shape, contracts, boundaries, or major dependencies change |',
    '',
    '`plan.md` is a local working document. `construct init` creates it for the active session, but it is gitignored and not committed; durable work belongs in the tracker (Beads or external).',
    '',
    'Tracker hierarchy: external tracker (prefer Beads) for durable work, `plan.md` for the local working plan, and cass-memory via MCP `memory` for cross-session recall.',
    '',
    '`AGENTS.md` is the canonical agent instruction file. On case-sensitive filesystems you may also add a lowercase `agents.md` shim for tools that require it.',
    'All LLMs working in the repo, including Construct, must read these as project state, keep them current when work changes project reality, and prune stale sections instead of letting managed docs drift.',
  ].join('\n');
}

const DIR_DESCRIPTIONS = {
  apps: 'User-facing apps shipped from this repo (dashboard, docs)',
  bin: 'CLI entrypoint (`construct`)',
  commands: 'Command prompt assets',
  config: 'Repo-wide controlled vocabulary (tag-vocabulary.json)',
  deploy: 'Terraform and deployment configs',
  docs: 'Architecture notes, runbooks, and documentation contract',
  examples: 'Example projects and persona fixtures',
  lib: 'Core runtime: CLI, hooks, MCP, providers, oracle, sync',
  packages: 'Shared workspace packages (e.g. cx-ui)',
  personas: 'Persona prompt definitions',
  platforms: 'Host adapter capability configs',
  profiles: 'Profile catalog',
  registry: 'Product capability registry',
  rules: 'Coding and quality standards',
  schemas: 'Registry and config JSON Schema',
  scripts: 'Audit, alignment, release, and sync scripts',
  skills: 'Reusable domain knowledge files',
  specialists: 'Org registry, contracts, and specialist prompts',
  templates: 'Doc and workflow templates',
  tests: 'Test suite',
};

function buildStructureSection(rootDir) {
  // git stderr must be discarded: from the published package rootDir is not a
  // repository, and execSync's default stdio prints "fatal: not a git repository"
  // to the user's terminal before the catch fires (doctor and sync both hit this).

  let trackedDirs;
  try {
    const out = execSync('git ls-tree --name-only HEAD', { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    trackedDirs = new Set(out.trim().split('\n').filter(Boolean));
  } catch {
    trackedDirs = null;
  }
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && (trackedDirs === null || trackedDirs.has(e.name)))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const lines = ['```text', 'construct/'];
  for (const entry of entries) {
    const desc = DIR_DESCRIPTIONS[entry.name] ?? '';
    lines.push(`├── ${entry.name.padEnd(16)} ${desc}`.trimEnd());
  }
  lines.push('```');
  return lines.join('\n');
}

function extractHookSummary(hookPath) {
  try {
    const src = fs.readFileSync(hookPath, 'utf8');
    const match = src.match(/\/\*\*[\s\S]*?\*\//);
    if (!match) return '';
    const block = match[0].replace(/^\/\*\*|\*\/$/g, '').trim();
    const lines = block.split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim());
    const purposeLine = lines.find(l => l.includes('—'));
    if (purposeLine) {
      const idx = purposeLine.indexOf('—');
      return purposeLine.slice(idx + 1).trim();
    }
    return lines.find(l => l.length > 0) ?? '';
  } catch { return ''; }
}

function buildHooksTable(rootDir) {
  const hooksDir = path.join(rootDir, 'lib', 'hooks');
  const files = fs.readdirSync(hooksDir)
    .filter(f => f.endsWith('.mjs'))
    .sort();

  const rows = ['| Hook | Description |', '|---|---|'];
  for (const f of files) {
    const name = f.replace(/\.mjs$/, '');
    const desc = extractHookSummary(path.join(hooksDir, f));
    rows.push(`| \`${name}\` | ${desc} |`);
  }
  return rows.join('\n');
}

function buildAgentsTable(rootDir) {
  const registryPath = path.join(rootDir, 'specialists', 'org');
  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return ''; }

  const agents = [
    ...(registry.orchestrator ? [{ ...registry.orchestrator, name: registry.orchestrator.name }] : []),
    ...Object.values(registry.specialists ?? {}),
  ];
  if (!agents.length) return '';

  const rows = ['| Specialist | Tier | Purpose |', '|---|---|---|'];
  for (const agent of agents.slice(0, 30)) {
    const name = agent.name ?? agent.id ?? 'n/a';
    const tier = agent.modelTier ?? agent.tier ?? agent.model_tier ?? 'n/a';
    const purpose = (agent.description ?? agent.purpose ?? '')
      .split('\n')[0].slice(0, 80)
      .replace(/ — /g, '. ').replace(/—/g, ',');
    rows.push(`| \`${name}\` | ${tier} | ${purpose} |`);
  }
  if (agents.length > 30) rows.push(`| *(+${agents.length - 30} more)* | | |`);
  return rows.join('\n');
}

// --- public API ---

/**
 * Regenerate all AUTO regions in README.md, docs/README.md, and docs/guides/concepts/architecture.mdx.
 * Returns { changed: string[], checked: boolean }.
 * With check:true writes nothing and sets changed to files that would differ.
 */
export async function regenerateDocs({ rootDir, check = false } = {}) {
  rootDir = rootDir ?? process.cwd();
  const changed = [];

  const jobs = [
    {
      file: path.join(rootDir, 'README.md'),
      regions: {
        commands: buildCommandsTable(),
        structure: buildStructureSection(rootDir),
        hooks: buildHooksTable(rootDir),
      },
    },
    {
      file: path.join(rootDir, 'docs', 'guides', 'concepts', 'architecture.mdx'),
      regions: {
        agents: buildAgentsTable(rootDir),
      },
    },
    {
      file: path.join(rootDir, 'docs', 'README.md'),
      regions: {
        'core-docs': buildCoreDocsContract(),
      },
    },
  ];

  for (const { file, regions } of jobs) {
    let content = readFile(file);
    if (!content) continue;
    let modified = false;
    for (const [regionName, body] of Object.entries(regions)) {
      if (!body) continue;
      const updated = replaceRegion(content, regionName, body);
      if (updated === null) continue;
      if (updated !== content) {
        content = updated;
        modified = true;
      }
    }
    if (!modified) continue;
    if (check) {
      changed.push(file);
    } else {
      writeIfChanged(file, content);
      changed.push(file);
    }
  }

  return { changed, checked: check };
}

/**
 * Check CLI command coverage against how-to links in docs/README.md.
 *
 * Returns an object with:
 *   - covered: string[]    commands that have a linked guide
 *   - uncovered: string[]  commands with no linked guide in docs/README.md
 *   - total: number
 *
 * A command is considered covered if its name appears in docs/README.md or in
 * a linked cookbook/how-to guide.
 */
export function checkDocsCoverage({ rootDir } = {}) {
  rootDir = rootDir ?? process.cwd();
  const docsReadme = readFile(path.join(rootDir, 'docs', 'README.md')) ?? '';

  // Extract all href targets from markdown links in docs/README.md
  const linkTargets = [...docsReadme.matchAll(/\[.*?\]\((.*?)\)/g)].map(m => m[1]);

  // Build a combined corpus: docs/README.md + every linked guide file
  let corpus = docsReadme;
  for (const target of linkTargets) {
    if (!target.startsWith('./guides/cookbook/')) continue;
    const filePath = path.join(rootDir, 'docs', target.replace(/^\.\//, ''));
    const content = readFile(filePath);
    if (content) corpus += '\n' + content;
  }

  // Capture command mentions from both inline code (`construct cmd`) and code blocks (bare lines)
  const mentionedCmds = new Set([
    ...corpus.matchAll(/`construct\s+([\w:_-]+)`/g),
    ...corpus.matchAll(/^construct\s+([\w:_-]+)/gm),
  ].map(m => m[1]));

  // Collect all command names from the registry
  const allCommands = [];
  for (const cmds of Object.values(CLI_COMMANDS_BY_CATEGORY)) {
    for (const cmd of cmds) allCommands.push(cmd.name);
  }

  // Skip internal / plumbing commands and simple commands covered by getting-started.md
  const skipList = new Set([
    'version', 'diff', 'validate', 'docs:update', 'docs:site', 'docs:check', 'sync',
    'list', 'setup', 'show', 'hosts', 'plugin', 'mcp', 'evals',
    'telemetry-backfill', 'lint:comments', 'lint:research',
    // short commands documented in getting-started.md
    'up', 'down', 'status', 'serve', 'init', 'update', 'doctor',
    // team sub-commands — covered as part of review how-to
    'team',
    // covered in getting-started.md under Memory Layer section
    'bootstrap', 'memory',
    // niche overlay command — documented in registry description
    'headhunt',
  ]);

  const covered = [];
  const uncovered = [];

  for (const name of allCommands) {
    if (skipList.has(name)) continue;
    const slug = name.replace(':', '-');
    const isCovered =
      linkTargets.some(t => t.includes(slug) || t.includes(name)) ||
      mentionedCmds.has(name);
    if (isCovered) covered.push(name);
    else uncovered.push(name);
  }

  return { covered, uncovered, total: covered.length + uncovered.length };
}

// Categories surfaced in the generated CLI reference. Internal commands (e.g.,
// `construct hook <name>`) are not user-facing reference material.
const REFERENCE_CATEGORIES = [
  'Core',
  'Work',
  'Models & Integrations',
  'Integrations',
  'Observability',
  'Diagnostics',
  'Advanced',
];

function slugify(category) {
  return category.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderCommandPage(category, commands) {
  const lines = [];
  lines.push('---');
  lines.push(`title: ${category}`);
  lines.push(`description: ${category} commands for Construct.`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${category}`);
  lines.push('');
  lines.push('| Command | What it does |');
  lines.push('|---|---|');
  for (const cmd of commands) {
    lines.push(`| \`construct ${cmd.name}\` | ${tableCell(cmd.description)} |`);
  }
  lines.push('');
  for (const cmd of commands) {
    lines.push(`## construct ${cmd.name}`);
    lines.push('');
    lines.push(cmd.description);
    lines.push('');
    if (cmd.usage) {
      lines.push('**Usage**');
      lines.push('');
      lines.push('```bash');
      lines.push(cmd.usage);
      lines.push('```');
      lines.push('');
    }
    if (cmd.subcommands && cmd.subcommands.length) {
      lines.push('**Subcommands**');
      lines.push('');
      for (const sub of cmd.subcommands) {
        const name = typeof sub === 'string' ? sub : sub.name;
        const description = typeof sub === 'string' ? '' : (sub.desc || sub.description || '');
        lines.push(`- \`${name}\`${description ? ` — ${description}` : ''}`);
      }
      lines.push('');
    }
    if (cmd.options && cmd.options.length) {
      lines.push('**Options**');
      lines.push('');
      lines.push('| Flag | Description |');
      lines.push('|---|---|');
      for (const opt of cmd.options) {
        lines.push(`| \`${opt.flag}\` | ${opt.desc} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderHooksPage(rootDir) {
  return [
    '---',
    'title: Hooks',
    'description: Hooks fire during Claude Code sessions, on file edits, commits, pushes, and prompts. Generated from lib/hooks/.',
    '---',
    '',
    '> Generated from `lib/hooks/`. Re-run `construct docs:site` to refresh.',
    '',
    'Hooks are wired in `platforms/claude/settings.template.json` and execute as child processes during Claude Code sessions. Each hook reads JSON on stdin, performs its check or transform, and exits with a status that signals whether the surrounding tool call should proceed.',
    '',
    buildHooksTable(rootDir),
    '',
  ].join('\n');
}

function renderAgentsPage(rootDir) {
  const table = buildAgentsTable(rootDir);
  if (!table) return null;
  return [
    '---',
    'title: Specialists',
    'description: The 28 specialists behind the construct persona. Generated from specialists/org.',
    '---',
    '',
    '> Generated from `specialists/org`. Re-run `construct docs:site` to refresh.',
    '',
    'Construct ships one persona (`construct`) and 28 specialists behind it. You address `@construct` for all everyday work; it routes to specialists internally. Each specialist has a role, model tier, and prompt file that defines its decision authority.',
    '',
    table,
    '',
  ].join('\n');
}

/**
 * Emit MDX reference pages into docs/guides/reference/ for the Next.js docs site
 * in apps/docs/. Mirrors the data sources behind AUTO regions and buildSite()
 * but writes Markdown files the docs app can pull in directly (no MkDocs
 * intermediate). Name kept for backwards compatibility with callers that
 * still import buildFumadocsReference; the rendering layer is now plain
 * Next.js + @next/mdx.
 */
export function buildFumadocsReference({ rootDir } = {}) {
  rootDir = rootDir ?? process.cwd();
  const refDir = path.join(rootDir, 'docs', 'guides', 'reference');
  const cliDir = path.join(refDir, 'cli');
  fs.mkdirSync(cliDir, { recursive: true });

  const written = [];

  const cliPages = [];
  for (const category of REFERENCE_CATEGORIES) {
    const commands = CLI_COMMANDS_BY_CATEGORY[category] ?? [];
    if (!commands.length) continue;
    const slug = slugify(category);
    const out = path.join(cliDir, `${slug}.md`);
    if (writeIfChanged(out, renderCommandPage(category, commands))) {
      written.push(path.relative(rootDir, out));
    }
    cliPages.push(slug);
  }

  const cliMeta = path.join(cliDir, 'meta.json');
  const cliMetaContent = JSON.stringify({ title: 'CLI', pages: ['index', ...cliPages] }, null, 2) + '\n';
  if (writeIfChanged(cliMeta, cliMetaContent)) written.push(path.relative(rootDir, cliMeta));

  const cliIndexContent = [
    '---',
    'title: CLI',
    'description: Every construct command, grouped by category. Generated from lib/cli-commands.mjs.',
    '---',
    '',
    '> Generated from `lib/cli-commands.mjs`. Re-run `construct docs:site` to refresh.',
    '',
    'Commands are grouped by what they do. Pick a category below.',
    '',
    ...REFERENCE_CATEGORIES.map((cat) => {
      const slug = slugify(cat);
      const commands = CLI_COMMANDS_BY_CATEGORY[cat] ?? [];
      if (!commands.length) return null;
      return `- [${cat}](/guides/reference/cli/${slug}) — ${commands.length} command${commands.length === 1 ? '' : 's'}`;
    }).filter(Boolean),
    '',
  ].join('\n');
  if (writeIfChanged(path.join(cliDir, 'index.md'), cliIndexContent)) {
    written.push(path.relative(rootDir, path.join(cliDir, 'index.md')));
  }

  const hooksPage = path.join(refDir, 'hooks.md');
  if (writeIfChanged(hooksPage, renderHooksPage(rootDir))) {
    written.push(path.relative(rootDir, hooksPage));
  }

  const specialistsContent = renderAgentsPage(rootDir);
  if (specialistsContent) {
    const specialistsPage = path.join(refDir, 'specialists.md');
    if (writeIfChanged(specialistsPage, specialistsContent)) {
      written.push(path.relative(rootDir, specialistsPage));
    }
    const legacyAgentsPage = path.join(refDir, 'agents.md');
    if (fs.existsSync(legacyAgentsPage)) {
      fs.unlinkSync(legacyAgentsPage);
      written.push(`- ${path.relative(rootDir, legacyAgentsPage)}`);
    }
  }

  return { written };
}

export function checkFumadocsReferenceDrift({ rootDir } = {}) {
  rootDir = rootDir ?? process.cwd();
  const refDir = path.join(rootDir, 'docs', 'guides', 'reference');
  const cliDir = path.join(refDir, 'cli');
  const drift = [];

  for (const category of REFERENCE_CATEGORIES) {
    const commands = CLI_COMMANDS_BY_CATEGORY[category] ?? [];
    if (!commands.length) continue;
    const slug = slugify(category);
    const out = path.join(cliDir, `${slug}.md`);
    const content = renderCommandPage(category, commands);
    if (readFile(out) !== content) drift.push(path.relative(rootDir, out));
  }

  const cliPages = REFERENCE_CATEGORIES
    .map((cat) => ({ cat, commands: CLI_COMMANDS_BY_CATEGORY[cat] ?? [] }))
    .filter(({ commands }) => commands.length)
    .map(({ cat }) => slugify(cat));
  const cliMetaContent = JSON.stringify({ title: 'CLI', pages: ['index', ...cliPages] }, null, 2) + '\n';
  const cliMeta = path.join(cliDir, 'meta.json');
  if (readFile(cliMeta) !== cliMetaContent) drift.push(path.relative(rootDir, cliMeta));

  const cliIndexContent = [
    '---',
    'title: CLI',
    'description: Every construct command, grouped by category. Generated from lib/cli-commands.mjs.',
    '---',
    '',
    '> Generated from `lib/cli-commands.mjs`. Re-run `construct docs:site` to refresh.',
    '',
    'Commands are grouped by what they do. Pick a category below.',
    '',
    ...REFERENCE_CATEGORIES.map((cat) => {
      const slug = slugify(cat);
      const commands = CLI_COMMANDS_BY_CATEGORY[cat] ?? [];
      if (!commands.length) return null;
      return `- [${cat}](/guides/reference/cli/${slug}) — ${commands.length} command${commands.length === 1 ? '' : 's'}`;
    }).filter(Boolean),
    '',
  ].join('\n');
  const cliIndex = path.join(cliDir, 'index.md');
  if (readFile(cliIndex) !== cliIndexContent) drift.push(path.relative(rootDir, cliIndex));

  const hooksPage = path.join(refDir, 'hooks.md');
  const hooksContent = renderHooksPage(rootDir);
  if (hooksContent && readFile(hooksPage) !== hooksContent) drift.push(path.relative(rootDir, hooksPage));

  const specialistsContent = renderAgentsPage(rootDir);
  const specialistsPage = path.join(refDir, 'specialists.md');
  if (specialistsContent && readFile(specialistsPage) !== specialistsContent) {
    drift.push(path.relative(rootDir, specialistsPage));
  }
  const legacyAgentsPage = path.join(refDir, 'agents.md');
  if (fs.existsSync(legacyAgentsPage)) drift.push(path.relative(rootDir, legacyAgentsPage));

  return { drift };
}
