#!/usr/bin/env node
/**
 * lib/init-unified.mjs — unified bootstrap for Construct project state and documentation system.
 *
 * Replaces both `construct init` and `construct init-docs`.
 *
 * Usage:
 *   node lib/init-unified.mjs [target-path] [--docs-preset=lean|product|full] [--docs-lanes=adrs,prds] [--with-architecture] [--with-readme]
 *   construct init [path] [--docs-preset=lean|product|full] [--docs-lanes=adrs,prds] [--with-architecture] [--with-readme]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildContextJson,
  buildContextMarkdown,
  buildPlanTemplate,
  writeStampedIfMissing,
} from "./project-init-shared.mjs";
import { multiSelect } from './tty-prompts.mjs';
import { execSync, spawnSync } from 'node:child_process';
import { stageProjectAdapters } from './install/stage-project.mjs';
import { missingIgnorePatterns, isConstructPackageRepo } from './host-disposition.mjs';
import { HOST_KEYS, displayNameToKey } from './platforms/capabilities.mjs';
import { DOC_LANES, LANE_ORDER, DOC_PRESETS } from './init/doc-lanes.mjs';
import { initWorkflow } from './workflow-state.mjs';
import { isMainModule } from './roots.mjs';

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const TEMPLATE_DIR = path.join(ROOT_DIR, "templates", "docs");

const args = process.argv.slice(2);
const targetArg = args.find((arg) => !arg.startsWith("--"));
const target = path.resolve(targetArg ?? process.cwd());

// Documentation flags - granular control
const withDocsFlag = args.find((arg) => arg.startsWith("--with-docs="));
const withAllDocsFlag = args.includes("--with-all-docs");
const withAdrsFlag = args.includes("--with-adrs");
const withRfcsFlag = args.includes("--with-rfcs");
const withRunbooksFlag = args.includes("--with-runbooks");
const withPostmortemsFlag = args.includes("--with-postmortems");
const withArchitectureFlag = args.includes("--with-architecture");
const withReadmeFlag = args.includes("--with-readme");
const withDevcontainerFlag = args.includes("--devcontainer");
const withSeedIndexFlag = args.includes("--seed-index");

// --watch-inbox opts into continuous inbox watching non-interactively (the
// interactive prompt asks the same question; skipInteractive runs default to
// off unless this flag is present, matching --with-adrs/--with-readme).
const watchInboxFlag = args.includes("--watch-inbox");

// Behavior flags
const verbose = args.includes("--verbose") || args.includes("-v");
const interactive = args.includes("--interactive") || args.includes("-i");
const quiet = args.includes("--quiet") || args.includes("-q");
const skipInteractive = !interactive;
// --force bypasses the existing-content detector so init writes its full
// scaffold even when populated lane dirs / a custom intake script / a root
// templates/ already exist (issue #97).
const forceScaffold = args.includes("--force");

// --no-beads skips tracker initialization entirely and marks beads as disabled
// in the result. Use when the host environment cannot run bd (e.g. ephemeral CI).
const noBeads = args.includes("--no-beads");

// `bd init` is git-native and unconditionally commits its bootstrap; ADR-0027
// §3 requires init to leave the host repo's commit history untouched unless the
// user opts in. --commit-bootstrap keeps that commit; the default withholds it.
const commitBootstrap = args.includes("--commit-bootstrap");

// Adapter selection (construct-4xy6 / ADR-0027 §1). By default init writes
// adapters only for hosts detected on the machine; --with-<host> force-includes
// one, --all-hosts writes every adapter set. Copilot (`.github/`) is opt-in only
// — never written by detection — so init never touches a repo's CI directory
// without --with-copilot.
const withHostFlags = new Set(HOST_KEYS.filter((k) => args.includes(`--with-${k}`)));
const allHosts = args.includes("--all-hosts");

// Active scope selector. `--scope=<id>` writes the field into the
// project's construct.config.json so resolveActiveScope picks it up
// on first run. Unknown ids are rejected with the available catalog.
const scopeArg = args.find((arg) => arg.startsWith("--scope="));
const scopeId = scopeArg ? scopeArg.split("=")[1] : null;

const created = [];
const skipped = [];

async function confirm(question) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim() !== 'n');
    });
  });
}

async function checkPrerequisites() {
  const { checkPrerequisites: sharedCheck } = await import('./health-check.mjs');
  const os = await import('node:os');
  const homeDir = os.homedir();
  
  const result = await sharedCheck({ 
    interactive: true, 
    homeDir 
  });
  
  if (!result.ok) {
    console.log('\n💡 Run `construct install --yes` to install missing dependencies automatically.');
    
    const runInstall = await confirm('\n🔧 Run `construct install` now? [Y/n] ');
    if (runInstall) {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'construct'), 'install', '--yes'], {
        stdio: 'inherit',
        env: process.env,
      });
      
      if (result.status !== 0) {
        console.log('\n⚠️  Install did not complete successfully. You can run `construct install` manually later.');
        const continueAnyway = await confirm('\nContinue with project initialization anyway? [y/N] ');
        if (!continueAnyway) {
          process.exit(1);
        }
      } else {
        console.log('\n✅ Install complete! Continuing with project initialization...\n');
      }
    } else {
      console.log('\n⏭️  Skipping install. You can run `construct install` later.');
      const continueAnyway = await confirm('\nContinue with project initialization anyway? [y/N] ');
      if (!continueAnyway) {
        process.exit(1);
      }
    }
  }
  
  return result.ok;
}

const docsPresetArg = args.find((arg) => arg.startsWith('--docs-preset='));
const docsLanesArg = args.find((arg) => arg.startsWith('--docs-lanes='));
const docsPresetName = docsPresetArg ? docsPresetArg.split('=')[1].toLowerCase() : 'lean';

// Project type detection
function detectProjectType(targetPath) {
  const files = fs.readdirSync(targetPath);
  const hasPackageJson = files.includes('package.json');
  const hasCargoToml = files.includes('Cargo.toml');
  const hasGoMod = files.includes('go.mod');
  const hasRequirementsTxt = files.includes('requirements.txt') || files.includes('pyproject.toml');
  const hasDockerfile = files.includes('Dockerfile') || files.includes('docker-compose.yml');
  const hasK8s = files.some(f => f.endsWith('.yaml') && (f.includes('deployment') || f.includes('service') || f.includes('ingress')));
  
  // Read package.json if present
  let packageInfo = null;
  if (hasPackageJson) {
    try {
      packageInfo = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf8'));
    } catch {}
  }
  
  // Detect type
  if (hasK8s) return { type: 'platform', label: 'Platform/Infrastructure', icon: '☸️' };
  if (hasDockerfile && hasPackageJson) return { type: 'api', label: 'API Service', icon: '🔌' };
  if (packageInfo?.dependencies?.express || packageInfo?.dependencies?.fastify) return { type: 'api', label: 'API Service', icon: '🔌' };
  if (packageInfo?.dependencies?.react || packageInfo?.dependencies?.vue || packageInfo?.dependencies?.svelte) return { type: 'webapp', label: 'Web Application', icon: '🌐' };
  if (hasCargoToml) return { type: 'system', label: 'Systems/CLI Tool', icon: '⚙️' };
  if (hasGoMod) return { type: 'backend', label: 'Go Backend', icon: '🔋' };
  if (hasRequirementsTxt) return { type: 'data', label: 'Data/ML Project', icon: '📊' };
  if (packageInfo?.bin) return { type: 'cli', label: 'CLI Tool', icon: '⌨️' };
  if (files.includes('README.md') && !hasPackageJson) return { type: 'docs', label: 'Documentation Project', icon: '📚' };
  
  return { type: 'generic', label: 'Generic Project', icon: '📦' };
}

// Suggest lanes based on project type and detected files
function suggestLanes(targetPath, projectType) {
  const suggestions = [];
  const files = fs.readdirSync(targetPath);

  // ADRs for any non-trivial project
  if (projectType.type !== 'docs') {
    suggestions.push({ lane: 'adrs', reason: 'Track architectural decisions', recommended: true });
  }
  
  // RFCs for APIs and platform projects
  if (['api', 'platform', 'backend'].includes(projectType.type)) {
    suggestions.push({ lane: 'rfcs', reason: 'Design reviews for API changes', recommended: true });
  }
  
  // Runbooks for deployed services
  if (['api', 'platform', 'webapp', 'backend'].includes(projectType.type)) {
    suggestions.push({ lane: 'runbooks', reason: 'Operational procedures and on-call docs', recommended: false });
  }
  
  // Postmortems for production services
  if (['api', 'platform', 'webapp', 'backend'].includes(projectType.type)) {
    suggestions.push({ lane: 'postmortems', reason: 'Incident retrospectives', recommended: false });
  }
  
  // PRDs for product-focused projects
  if (['webapp', 'api'].includes(projectType.type)) {
    suggestions.push({ lane: 'prds', reason: 'Product requirements', recommended: false });
  }
  
  // Notes for all projects
  suggestions.push({ lane: 'notes', reason: 'General notes and scratchpad', recommended: true });
  
  return suggestions;
}

// Parse --with-docs flag value
function parseWithDocs(value) {
  if (!value || value === 'all') {
    return LANE_ORDER;
  }
  
  // Map singular aliases to canonical lane keys BEFORE validating, so
  // `--with-docs=adr,rfc` resolves rather than being silently filtered out.
  const ALIASES = { adr: 'adrs', rfc: 'rfcs', runbook: 'runbooks', postmortem: 'postmortems', prd: 'prds', brief: 'briefs', memo: 'memos', changelog: 'changelogs', meeting: 'meetings', note: 'notes' };

  const requested = value.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const resolved = [];
  const unknown = [];
  for (const lane of requested) {
    const canonical = ALIASES[lane] || lane;
    if (LANE_ORDER.includes(canonical)) resolved.push(canonical);
    else unknown.push(lane);
  }

  // Surface typo'd lanes loudly instead of dropping them silently; valid lanes
  // still proceed so one bad token does not abort init.
  if (unknown.length) {
    console.warn(`Warning: ignoring unknown --with-docs lane(s): ${unknown.join(', ')}. Valid lanes: ${LANE_ORDER.join(', ')}`);
  }

  return [...new Set(resolved)]; // dedupe
}

function inferProjectName(targetPath) {
  const packageJsonPath = path.join(targetPath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      return pkg.name || path.basename(targetPath);
    } catch {}
  }
  return path.basename(targetPath);
}

function normalizeAnswer(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}



// Index only the lanes actually scaffolded — advertising lanes that have no
// directory sends readers to dead links. Project-framed: this is the team's doc
// surface, not Construct's tooling, so the body carries no `construct` commands.

function buildDocsReadme(projectName, selectedLanes = []) {
  const laneLines = [...selectedLanes]
    .sort()
    .map((lane) => {
      const meta = DOC_LANES[lane];
      const label = meta?.title ?? lane;
      const laneDir = meta?.dir ?? lane;
      const desc = meta?.description ?? "Custom documentation lane.";
      return `- [${label}](./${laneDir}/) — ${desc}`;
    });

  return `# ${projectName} Documentation

> The canonical home for this project's long-lived documents — decision records, briefs, notes, and runbooks.

## Operating model

- Keep each document focused on one lane's purpose; start from the per-lane \`templates/\`.
- Link durable work to the project's tracker and \`plan.md\`, and update related documents in the same change.
- Prune a lane when it stops serving a real purpose rather than letting it collect stale templates.

## Lanes

${laneLines.join("\n")}
`;
}

function buildLaneReadme(laneKey) {
  const lane = DOC_LANES[laneKey];
  if (!lane) return `# ${laneKey}\n\nDocumentation lane.`;
  
  return `# ${lane.title}

${lane.description}

## Templates

This directory includes starter templates in the \`templates/\` subdirectory.`;
}

function buildNotesTemplate() {
  return `# Title

Date: {{date}}
Author: {{author}}
Related: {{related-issue}}

## Context

What prompted this note? What problem are we trying to understand?

## Observations

- Fact 1
- Fact 2  
- Fact 3

## Questions

- What don't we know yet?
- What assumptions need testing?

## Next Steps

- [ ] Action 1
- [ ] Action 2`;
}

function buildMeetingNotesTemplate() {
  return `# {{meeting-title}}

Date: {{date}}
Time: {{time}}
Attendees: {{attendees}}

## Agenda

1. Topic 1
2. Topic 2
3. Topic 3

## Notes

### Topic 1

- Key point
- Decision
- Action item

### Topic 2

- Key point  
- Decision
- Action item

## Decisions

- Decision 1
- Decision 2

## Action Items

- [ ] @owner: Task description (due: {{date}})
- [ ] @owner: Task description (due: {{date}})`;
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    skipped.push(path.relative(target, filePath));
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  created.push(path.relative(target, filePath));
  return true;
}

function copyLaneTemplates(laneKey) {
  const lane = DOC_LANES[laneKey];
  if (!lane) return;
  
  const laneRoot = path.join(target, "docs", lane.dir);
  writeIfMissing(path.join(laneRoot, "README.md"), buildLaneReadme(laneKey));
  
  for (const [index, templateName] of lane.templates.entries()) {
    const outputName = index === 0 ? "_template.md" : templateName.replace(/\.md$/, ".template.md");
    let content;
    
    if (templateName === "__notes-template__") {
      content = buildNotesTemplate();
    } else if (templateName === '__meeting-notes-template__') {
      content = buildMeetingNotesTemplate();
    } else {
      const templatePath = path.join(TEMPLATE_DIR, templateName);
      if (fs.existsSync(templatePath)) {
        content = fs.readFileSync(templatePath, "utf8");
      } else {
        content = `# ${templateName.replace('.md', '')}\n\nTemplate file.`;
      }
    }
    
    writeIfMissing(path.join(laneRoot, "templates", outputName), content);
  }
}

async function askDocumentationQuestions() {
  // Non-interactive mode: use flags or defaults (lean preset by default)
  if (skipInteractive) {
    let lanes = [];

    if (docsLanesArg) {
      lanes = parseWithDocs(docsLanesArg.split('=')[1]);
    } else if (withAllDocsFlag) {
      lanes = LANE_ORDER;
    } else if (withDocsFlag) {
      lanes = parseWithDocs(withDocsFlag.split('=')[1]);
    } else {
      if (withAdrsFlag) lanes.push('adrs');
      if (withRfcsFlag) lanes.push('rfcs');
      if (withRunbooksFlag) lanes.push('runbooks');
      if (withPostmortemsFlag) lanes.push('postmortems');
    }

    if (lanes.length === 0) {
      lanes = DOC_PRESETS[docsPresetName] ?? DOC_PRESETS.lean;
    }

    return {
      lanes: [...new Set(lanes)],
      withArchitecture: withArchitectureFlag,
      withReadme: withReadmeFlag || !fs.existsSync(path.join(target, "README.md")),
      docsPreset: docsPresetName,
    };
  }
  
  // Interactive mode: project-aware workflow
  const projectType = detectProjectType(target);
  const suggestions = suggestLanes(target, projectType);
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DOCUMENTATION SETUP');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Detected project type: ${projectType.icon} ${projectType.label}`);
  console.log('');
  
  // Ask about README.md
  let withReadme = withReadmeFlag;
  if (!withReadmeFlag && !fs.existsSync(path.join(target, "README.md"))) {
    const response = await confirm('Create README.md? [Y/n] ');
    withReadme = response;
  }
  
  // Build options for multi-select with suggestions pre-checked
  const suggestedLaneNames = new Set([
    ...(DOC_PRESETS[docsPresetName] ?? DOC_PRESETS.lean),
    ...suggestions.filter((s) => s.recommended).map((s) => s.lane),
  ]);
  const laneOptions = LANE_ORDER.map(lane => {
    const suggestion = suggestions.find(s => s.lane === lane);
    return {
      label: DOC_LANES[lane].title,
      value: lane,
      checked: suggestion?.recommended ?? suggestedLaneNames.has(lane),
      description: DOC_LANES[lane].description,
      suggestion: suggestion?.reason,
    };
  });
  
  // Show checkbox multi-select
  console.log('');
  console.log('Documentation lanes are directories under docs/ that organize specific');
  console.log('types of written work — decisions (ADRs), proposals (RFCs), incidents, etc.');
  console.log('Select which ones you need (recommended items are pre-checked).');
  console.log('');
  
  const selectedLanes = await multiSelect({
    title: 'Documentation Lanes',
    instructions: 'Press Enter to confirm your selection',
    options: laneOptions,
  });
  
  // Ask about architecture doc
  let withArchitecture = withArchitectureFlag;
  if (!withArchitectureFlag) {
    console.log('');
    const archResponse = await confirm('Create docs/architecture.md? [y/N] ');
    withArchitecture = archResponse;
  }
  
  return { lanes: selectedLanes, withArchitecture, withReadme, docsPreset: docsPresetName };
}

// Intake collection — suggest directories to watch for context
function discoverProjectDirs(targetPath) {
  const dirs = [];
  let entries;
  try { entries = fs.readdirSync(targetPath, { withFileTypes: true }); } catch { return dirs; }
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Skip hidden dirs, node_modules, build artifacts
    if (name.startsWith('.')) continue;
    if (name === 'node_modules') continue;
    if (name === 'dist' || name === 'build' || name === '.next' || name === '.out') continue;
    dirs.push(name);
  }
  return dirs.sort();
}

// Extra inbox-style directories the user can opt into. These are NOT
// source-code, doc, or test directories: they're places where unsorted
// signals tend to land (downloads, scratch notes, exported research). The
// canonical `inbox/` at the project root is always watched and not listed
// here.
//
// Historically this list included `src/`, `docs/`, `tests/`, etc., and
// `init --yes` auto-enabled every one that existed in the project. That
// turned every code change, doc edit, and test file into a synthetic
// "intake signal" and polluted the queue with hundreds of false positives.
// Watching project artifact directories is opt-in only; an empty list is
// the correct default.
const INTAKE_DIR_PRESETS = [];

async function askIntakeCollection(targetPath, skipInteractive) {
  // Non-interactive default: empty parentDirs. The canonical `inbox/` zone
  // handles every well-defined signal path. Users who want to watch additional
  // directories opt in explicitly via `construct intake config set --add-dir=<path>`.
  if (skipInteractive) {
    return null;
  }

  // Interactive mode: no presets to surface — the user must name the
  // directory they want watched. Skipped entirely when the preset list
  // is empty (the current default after the auto-include regression).
  if (INTAKE_DIR_PRESETS.length === 0) {
    return null;
  }

  const existingDirs = discoverProjectDirs(targetPath);
  const presetOptions = INTAKE_DIR_PRESETS.map(p => ({
    label: p.label,
    value: p.value,
    checked: false,
    description: p.reason,
  }));

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  INTAKE COLLECTION');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Intake watches `inbox/` at the project root.');
  console.log('Add extra directories ONLY if signals (customer notes, exports,');
  console.log('PDFs, etc.) regularly land there. Do not select code or finished');
  console.log('artifact directories like src/, docs/, or tests/.');
  console.log('');

  void existingDirs;
  const selected = await multiSelect({
    title: 'Additional Inbox Directories',
    instructions: 'Press Enter to confirm your selection (or pick none)',
    options: presetOptions,
  });

  if (selected.length === 0) {
    console.log('');
    console.log('No extra directories selected. The inbox watcher will scan');
    console.log('`inbox/` only. Add more later with:');
    console.log('  construct intake config set --add-dir=<path>');
    console.log('');
    return null;
  }

  console.log('');
  console.log(`Watching ${selected.length} extra directory(ies):`);
  for (const d of selected) console.log(`  • ${d}/`);
  console.log('');

  return { parentDirs: selected, maxDepth: 4 };
}

// Continuous inbox watching (construct-b2t01.1) — asked once, at init time.
// `autoEmbed:true` is the existing construct.config.json field the embed
// daemon's inbox-watcher job (lib/embed/daemon.mjs Job #9) reads to decide
// whether the daemon should stay running; `construct embed supervise`
// installs the launchd/systemd unit that keeps the daemon alive across
// reboots. Non-interactive runs never block on stdin: skipInteractive
// returns the --watch-inbox flag value (default false) directly.

async function askWatchInboxQuestion(skipInteractive) {
  if (skipInteractive) {
    return watchInboxFlag;
  }

  console.log('');
  return confirm('Watch inbox/ continuously with the embed daemon (autoEmbed)? [y/N] ');
}

// A greenfield README belongs to the project, not to Construct: a neutral
// skeleton the owner fills in. Construct's presence is one delineated pointer to
// AGENTS.md, never project-identity content or a tooling command reference —
// matching how a native agent stays out of the host's README (ADR-0027 §2).

function buildProjectReadme(projectName) {
  return `# ${projectName}

> Briefly describe what this project does and who it is for.

## Getting started

Document how to install dependencies and run the project.

## Development

Document how to build, test, and contribute.

---

<sub>Agent workflows for this repository are configured in [\`AGENTS.md\`](AGENTS.md), managed with [Construct](https://github.com/geraldmaron/construct).</sub>
`;
}

function preflight(target) {
  // Check git repo
  try {
    execSync('git rev-parse --show-toplevel', { cwd: target, stdio: 'ignore' });
  } catch {
    throw new Error('Not a git repository. Run `git init` first.');
  }
  
  // A dirty working tree before init/upgrade is surfaced by default so the user knows scaffolding
  // lands on top of uncommitted changes; the file-count detail stays behind --verbose.

  const porcelain = execSync('git status --porcelain', { cwd: target, encoding: 'utf8' }).trim();
  const clean = porcelain === '';
  if (!clean) {
    console.warn('Warning: Working tree has uncommitted changes');
    if (verbose && porcelain.split('\n').length > 10) {
      console.warn(`  (${porcelain.split('\n').length} files modified)`);
    }
  }
  
  // Check tests (silent unless verbose)
  if (verbose) {
    try {
      execSync('npm test -- --passWithNoTests', { cwd: target, timeout: 30000, stdio: 'ignore' });
    } catch {
      console.warn('Warning: Tests do not pass (or no tests)');
    }
  }
  
  return { clean };
}

function gitHeadSha(cwd) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Restore the host repo's commit pointer to where init found it, leaving every
// bd-written file in the working tree (uncommitted, unstaged) for the user to
// commit on their own terms. When the bootstrap commit was the repo's first,
// drop the branch ref so the repo returns to "no commits yet". bd's issue data
// lives in Dolt, not this git commit, so the tracker stays fully functional.

function undoBootstrapCommit(cwd, headBefore) {
  const headAfter = gitHeadSha(cwd);
  if (!headAfter || headAfter === headBefore) return false;
  if (headBefore) {
    spawnSync("git", ["reset", "--mixed", headBefore], { cwd, stdio: "ignore" });
  } else {
    spawnSync("git", ["update-ref", "-d", "HEAD"], { cwd, stdio: "ignore" });
    spawnSync("git", ["reset"], { cwd, stdio: "ignore" });
  }
  return true;
}

function initializeBeadsTracker(target, { commitBootstrap = false } = {}) {
  // bd init prints verbose, host-specific output (a doubled "Claude Code
  // integration installed", a "Restart Claude Code" line that ignores the other
  // synced hosts) that interleaves with Construct's own flow. Capture it and let
  // the caller print one clean summary; the captured prefix names the issue ids.

  // bd init is git-native and unconditionally commits its bootstrap (.beads/*,
  // .gitignore, agent files) with no flag to suppress it. Capture HEAD first so
  // the commit can be withheld unless --commit-bootstrap (ADR-0027 §3).

  const headBefore = gitHeadSha(target);

  const result = spawnSync("bd", ["init"], {
    cwd: target,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    killSignal: "SIGTERM",
    timeout: 30_000,
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("bd init timed out after 30s");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-2).join(" ");
    throw new Error(`bd init exited with code ${result.status ?? "unknown"}${tail ? `: ${tail}` : ""}`);
  }
  const withheldCommit = commitBootstrap ? false : undoBootstrapCommit(target, headBefore);
  const prefixMatch = (result.stdout || "").match(/Issue prefix:\s*(\S+)/);
  return { prefix: prefixMatch ? prefixMatch[1] : null, withheldCommit };
}

// Resolve the host adapter sets init should write (construct-4xy6). Returns null
// for "all hosts" (--all-hosts), otherwise the union of detected hosts and
// --with-<host> flags. Copilot is excluded from detection so `.github/` is only
// written on explicit --with-copilot; selecting VS Code pulls in claude because
// VS Code reads `.claude/agents` natively; an empty result falls back to claude.

async function resolveAdapterHosts() {
  if (allHosts) return null;
  const detected = new Set();
  try {
    const { detectHostCapabilities } = await import('./host-capabilities.mjs');
    const nameToKey = displayNameToKey();
    for (const cap of detectHostCapabilities()) {
      if (cap.availability === 'installed' && nameToKey[cap.host]) detected.add(nameToKey[cap.host]);
    }
  } catch { /* detection is advisory; fall back to flags + baseline */ }
  detected.delete('copilot');
  const selected = new Set([...detected, ...withHostFlags]);

  // An empty selection writes no adapters: nothing detected and no --with-<host>
  // flag means the user is guided by docs to run sync with an explicit host,
  // rather than scaffolding a sidecar they did not ask for.

  return HOST_KEYS.filter((k) => selected.has(k));
}

async function main() {
  const projectName = inferProjectName(target);

  const { clean } = preflight(target);

  // Interactive sessions check machine prerequisites up front and offer to run
  // `construct install` before any scaffolding, so a missing dependency is
  // surfaced at the start rather than midway. Non-interactive runs rely on
  // preflight's git check and stay silent so CI/tests are unaffected.
  if (interactive && process.stdin.isTTY) {
    await checkPrerequisites();
  }

  if (!quiet) {
    console.log(`Initializing Construct in ${path.relative(process.cwd(), target) || "."}`);
  }

  // Scaffold the central project config so the configuration surface is
  // discoverable (ADR-0027 §1 / construct-e13x). Organized by design —
  // surfaces all major configurable blocks (deployment, telemetry,
  // orchestration, etc.) so the user can discover and edit options easily.
  // A fresh file is written on every init; skip-if-exists preserves user edits.

  {
    const { findProjectConfigPath, loadProjectConfig, writeProjectConfig, PROJECT_CONFIG_FILENAME } = await import('./config/project-config.mjs');
    const { DEFAULT_PROJECT_CONFIG } = await import('./config/schema.mjs');

    if (scopeId) {
      const { loadScope, listScopes } = await import('./scopes/loader.mjs');
      if (!loadScope(scopeId)) {
        console.error(`Unknown scope: ${scopeId}. Available: ${listScopes().join(', ')}`);
        process.exit(1);
      }
    }
    const found = findProjectConfigPath(target);
    const cfgPath = found || path.join(target, PROJECT_CONFIG_FILENAME);

    // loadProjectConfig returns { path, raw, config, source }. Persist .raw (the
    // on-disk JSON) so user customizations survive and defaults are not silently
    // materialized into the file.

    if (!found) {
      const cfg = {
        $schema: "./node_modules/@geraldmaron/construct/schemas/project-config.schema.json",
        ...DEFAULT_PROJECT_CONFIG,
        scope: scopeId || 'rnd',
      };
      // Explicitly write the full default config object so all options are
      // visible and discoverable to the user in the file. The $schema property
      // provides inline documentation and validation in supported editors.
      writeProjectConfig(cfgPath, cfg, { validate: true, silent: true });
      created.push(PROJECT_CONFIG_FILENAME);
      if (!quiet && scopeId) console.log(`Scope set to ${scopeId}.`);
    } else if (scopeId) {
      const loaded = loadProjectConfig(target);
      const cfg = loaded?.raw ? { ...loaded.raw } : { version: 1 };
      cfg.scope = scopeId;
      writeProjectConfig(cfgPath, cfg, { validate: true, silent: true });
      if (!quiet) console.log(`Scope set to ${scopeId}.`);
    }
  }

  // Resolve active scope to drive capability-gated scaffolding (intake
  // archetype, attribution stamping). Falls back to rnd when no scope is
  // configured — matches resolveActiveScope semantics elsewhere.

  const { resolveActiveScope } = await import('./scopes/loader.mjs');
  const activeProfile = resolveActiveScope(target, scopeId) ?? null;
  const intakeCap = activeProfile?.capabilities?.intake ?? null;
  const { gatherAttribution } = await import('./intake/attribution.mjs');
  const attribution = intakeCap?.attribution ? gatherAttribution() : null;

  // AGENTS.md and CLAUDE.md are user-owned files (ADR-0027 §2). Construct does
  // not author their bodies — bd init creates them with the project skeleton and
  // the Beads block, and the injectIntoAgentFile pass below adds Construct's
  // guidance as a fenced marker block only. Pre-writing a doctrine body here
  // would land un-fenced Construct content that sync/doctor cannot reconcile.

  writeStampedIfMissing({
    targetRoot: target,
    created,
    skipped,
    filePath: path.join(target, "plan.md"),
    content: buildPlanTemplate(),
    generator: "construct/init",
    attribution,
  });

  writeStampedIfMissing({
    targetRoot: target,
    created,
    skipped,
    filePath: path.join(target, ".cx", "context.json"),
    content: buildContextJson(projectName, { attribution }),
    generator: "construct/init",
  });

  writeStampedIfMissing({
    targetRoot: target,
    created,
    skipped,
    filePath: path.join(target, ".cx", "context.md"),
    content: buildContextMarkdown(),
    generator: "construct/init",
    attribution,
  });

  const { created: workflowCreated } = initWorkflow(target, projectName || "Project workflow");
  if (workflowCreated) created.push(".cx/workflow.json");
  
  // `.cx/` already exists from the context writes above and is gitignored in full
  // (ADR-0027), so a keep file there could never be tracked. No dead keep file is written.


  // Detect existing project content once; the result feeds three decisions
  // below: skip the inbox/ drop zone on custom intake, skip lane scaffolding
  // for lanes already covered elsewhere, and skip per-lane templates/ when
  // root templates/ already has them. --force bypasses every check.

  const { detectExistingContent, shouldSkipProjectInbox, shouldScaffoldLane, formatDeferralSummary } =
    await import('./init/detect-existing-structure.mjs');
  const detection = detectExistingContent(target);
  const inboxDecision = shouldSkipProjectInbox(detection, { force: forceScaffold });

  // Single canonical drop zone (ADR-0045 §C): the visible project-root `inbox/`.
  // Raw drops stay out of source via host-disposition IGNORED_PATTERNS
  // (ADR-0027 §1). Machine/runtime intake state lives under the gitignored
  // `.cx/intake/` tree, created lazily by the queue on first use — init no
  // longer scaffolds the deprecated `.cx/inbox/` drop zone. Skipped when a
  // custom intake pipeline already owns the project root.

  if (!inboxDecision.skip) {
    const rootInbox = path.join(target, 'inbox');
    if (!fs.existsSync(rootInbox)) {
      fs.mkdirSync(rootInbox, { recursive: true });
      created.push('inbox/');
    }

    // Writers assemble files under `inbox/.staging/` and atomically rename them
    // into `inbox/`; the gitignored staging dir keeps a half-written drop
    // invisible to the watcher until it lands.

    fs.mkdirSync(path.join(rootInbox, '.staging'), { recursive: true });

    if (intakeCap?.dedup === 'sha256') {
      const { saveManifest, loadManifest, MANIFEST_REL_PATH } = await import('./intake/manifest.mjs');
      const manifestExists = fs.existsSync(path.join(target, MANIFEST_REL_PATH));
      if (!manifestExists) {
        saveManifest(target, loadManifest(target));
        created.push(MANIFEST_REL_PATH);
      }
    }
  } else {
    console.log(`[init:intake] skipping inbox/ — ${inboxDecision.reason}. Run with --force to scaffold anyway.`);
    skipped.push('inbox/ (deferred to existing intake)');
  }

  // Gitignore every Construct-generated artifact whose disposition is `ignored`
  // (ADR-0027 §1): the six adapter dirs, the `.construct/` launcher, `.cx/`
  // runtime state, and the generated config files all carry machine-specific
  // absolute paths (MCP server paths, env-resolved tokens) and are recreated by
  // `construct sync`, so they are never committed. Mirrors Construct's own repo
  // .gitignore 1:1. Idempotent per-pattern: a pattern already matched exactly,
  // by its bare/slashed form, or by a broader `*` / `**`, is left untouched.

  const isToolRepo = isConstructPackageRepo(target);

  if (!isToolRepo) {
    try {
      const gitignorePath = path.join(target, '.gitignore');
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
      const missing = missingIgnorePatterns(existing);
      if (missing.length > 0) {
        const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        const block = `${prefix}\n# Construct — generated adapters, launcher, and runtime state.\n# Machine-specific, recreated by \`construct sync\`; never source (ADR-0027).\n${missing.join('\n')}\n`;
        fs.writeFileSync(gitignorePath, existing + block, 'utf8');
        created.push(existing.length === 0 ? '.gitignore (Construct ignores)' : `.gitignore (+${missing.length} Construct ignore${missing.length === 1 ? '' : 's'})`);
      }
    } catch (err) {
      console.warn(`⚠️  Could not update .gitignore: ${err.message}`);
    }
  } else if (verbose) {
    console.log('[init:conflation] inside Construct repository; skipping .gitignore mutation.');
  }

  // Resolve which host adapter sets to write (construct-4xy6). Default: the
  // hosts detected on this machine, plus any --with-<host>. VS Code reads
  // .claude/agents natively, so selecting it pulls in claude. Copilot is opt-in
  // only — never written by detection. --all-hosts writes every set; an empty
  // selection falls back to the .claude/ baseline so a project is never bare.

  const adapterHosts = await resolveAdapterHosts();

  // Stage .construct/ launcher + sync the selected adapter sets so init produces
  // the same project shape as a fresh `npm install` of the package as a dep.

  if (!isToolRepo) {
    try {
      let pkgVersion = '';
      try {
        pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '';
      } catch { /* fall through with empty version */ }
      const stagingPre = fs.existsSync(path.join(target, '.construct', 'run.mjs'));
      const claudePre = fs.existsSync(path.join(target, '.claude', 'settings.json'));
      stageProjectAdapters({
        projectRoot: target,
        packageRoot: ROOT_DIR,
        pkgVersion,
        hosts: adapterHosts,
        log: (msg) => console.log(`[init:stage] ${msg}`),
      });
      if (!quiet && adapterHosts) {
        console.log(`  Adapters: ${adapterHosts.join(', ')} (add more with --with-<host>, or --all-hosts).`);
      }
      if (!stagingPre && fs.existsSync(path.join(target, '.construct', 'run.mjs'))) {
        created.push('.construct/ (launcher staged)');
      }
      if (!claudePre && fs.existsSync(path.join(target, '.claude', 'settings.json'))) {
        created.push('.claude/ (agents + settings)');
      }

      // construct init writes project scope only. Global wiring (the `construct`
      // front-door agent in `~/.claude/agents/`, `~/.codex/agents/`, etc.) is
      // installed once by `construct sync --global` or the npm postinstall.
      // Specialists, slash commands, and skills live with the repo per each
      // host's documented best-practice scope.

    } catch (err) {
      console.warn(`⚠️  Adapter staging failed: ${err.message}`);
    }
  } else if (verbose) {
    console.log('[init:conflation] inside Construct repository; skipping .construct/ launcher staging.');
  }

  // Cache a host-agnostic project profile at .cx/project-profile.json (gitignored)
  // so per-host skill filtering has a signal to scope against. Owned by init —
  // install must not read the cwd (ADR-0027 §3).

  try {
    const { detectProjectProfile, writeProfile } = await import('./project-profile.mjs');
    const profile = detectProjectProfile(target);
    if (profile.tags.length > 0) {
      writeProfile(profile, target);
      created.push('.cx/project-profile.json');
    }
  } catch { /* project profiling is advisory; init proceeds */ }

  // Tool orientation describes Construct, not the project, so it belongs in the
  // ignored .cx/ tree rather than the host repo root — never read as project
  // content, never committed (ADR-0027 §1). Written once; skip-when-exists keeps
  // user edits across subsequent inits and `npm install` rebuilds.

  const guideSrc = path.join(ROOT_DIR, 'templates', 'docs', 'construct_guide.md');
  const guideDst = path.join(target, '.cx', 'construct_guide.md');
  if (fs.existsSync(guideSrc) && !fs.existsSync(guideDst)) {
    try {
      fs.mkdirSync(path.dirname(guideDst), { recursive: true });
      fs.copyFileSync(guideSrc, guideDst);
      created.push('.cx/construct_guide.md');
    } catch (err) {
      console.warn(`⚠️  Could not write .cx/construct_guide.md: ${err.message}`);
    }
  } else if (fs.existsSync(guideDst)) {
    skipped.push('.cx/construct_guide.md');
  }

  // Auto-init beads. Fail-closed: a tracker failure leaves the project in an
  // inconsistent state (no hooks, no issue tracking) — better to stop early than
  // silently proceed. Pass --no-beads to opt out for ephemeral/CI environments.
  const beadsMeta = path.join(target, ".beads", "metadata.json");
  let beadsReady = false;
  if (noBeads) {
    console.log('  ⚠️  Skipping task tracker initialization (--no-beads).');
    skipped.push('.beads/ (--no-beads)');
  } else if (!fs.existsSync(beadsMeta) && !isToolRepo) {
    console.log('');
    console.log('Initializing the task tracker (beads — local-first, git-synced, works offline)…');
    fs.mkdirSync(path.join(target, ".beads"), { recursive: true });
    const beads = initializeBeadsTracker(target, { commitBootstrap });
    created.push(".beads/ (initialized)");
    const prefixNote = beads?.prefix ? ` — issues prefixed \`${beads.prefix}-\`` : "";
    console.log(`  ✓ Task tracker ready${prefixNote}. Run \`bd quickstart\` to start.`);
    if (beads?.withheldCommit) {
      console.log("    Bootstrap files left uncommitted (commit them yourself, or re-run with --commit-bootstrap).");
    }
    console.log('');
    beadsReady = true;
  } else if (fs.existsSync(beadsMeta)) {
    beadsReady = true;
  }

  // Wire the project's git hooks to .beads/hooks so Construct's pre-commit
  // secret-scan and policy gates activate. Owned by init, not install (ADR-0027
  // §3): install must never mutate the cwd repo. Idempotent — no-op when
  // .beads/hooks/pre-commit is absent or a non-default custom path is set.
  // Skipped when beads is disabled or was not successfully initialized.

  if (beadsReady) {
    try {
      const { ensureGitHooksPath } = await import('./git-hooks-path.mjs');
      const hooks = ensureGitHooksPath({ cwd: target });
      if (hooks.status === 'set') {
        created.push('git core.hooksPath → .beads/hooks');
        if (!quiet) console.log(`  ✓ ${hooks.message}`);
      } else if (hooks.status === 'warning' && !quiet) {
        console.log(`  ⚠️  ${hooks.message}`);
      }
    } catch { /* git-hooks wiring is advisory; init proceeds */ }
  }

  // Inject Construct's integration guidance into AGENTS.md and CLAUDE.md as a
  // versioned, hash-stamped marker block (ADR-0027 §2). Runs after bd init so
  // the block survives whatever bd wrote, preserves all content outside the
  // markers, and dedups against a sibling Beads Integration block. Idempotent:
  // same hash is a no-op, a version/hash bump replaces the block content only.

  try {
    const { injectIntoAgentFile, CONSTRUCT_INTEGRATION_VERSION } = await import('./agent-instructions/inject.mjs');
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const res = injectIntoAgentFile(path.join(target, name), {
        version: CONSTRUCT_INTEGRATION_VERSION,
        header: `# ${projectName}\n`,
      });
      if (!res.existed) created.push(`${name} (Construct integration)`);
    }
  } catch (err) {
    console.warn(`⚠️  Could not inject agent-instruction block: ${err.message}`);
  }

  // Intake policy — write the single-zone model (ADR-0045 §C) so the user can
  // inspect what's watched and edit it directly. The canonical `inbox/` at the
  // project root is the only drop zone; empty parentDirs is correct — extra
  // dirs are opt-in.

  const intakeConfig = (await askIntakeCollection(target, skipInteractive)) ?? { parentDirs: [], maxDepth: 4 };

  const { saveIntakePolicy } = await import('./config/intake-policy.mjs');
  try {
    saveIntakePolicy(target, {
      maxDepth: intakeConfig.maxDepth,
      additionalDirs: intakeConfig.parentDirs ?? [],
    });
    created.push('construct.config.json (intakePolicy)');
  } catch (err) {
    console.warn(`⚠️  Could not write intake policy: ${err.message}`);
  }

  // Continuous inbox watching — prompt once (construct-b2t01.1). On yes, wire
  // autoEmbed:true into construct.config.json and offer to install background
  // supervision; on no, print the commands to enable it later.

  const watchInbox = await askWatchInboxQuestion(skipInteractive);
  if (watchInbox) {
    try {
      const { findProjectConfigPath, loadProjectConfig, writeProjectConfig, PROJECT_CONFIG_FILENAME } = await import('./config/project-config.mjs');
      const cfgPath = findProjectConfigPath(target) || path.join(target, PROJECT_CONFIG_FILENAME);
      const loaded = loadProjectConfig(target);
      const cfg = loaded?.raw ? { ...loaded.raw } : { version: 1 };
      cfg.autoEmbed = true;
      writeProjectConfig(cfgPath, cfg, { validate: true, silent: true });
      if (!quiet) {
        console.log('  ✓ Continuous inbox watching enabled (autoEmbed: true).');
      }
    } catch (err) {
      console.warn(`⚠️  Could not enable autoEmbed: ${err.message}`);
    }

    // Actually installing a launchd/systemd unit is only offered interactively
    // — a non-interactive run (--yes, CI) that opted into --watch-inbox still
    // gets autoEmbed wired, but supervision install stays a printed next step
    // so init never mutates system service state without a human present.
    if (!skipInteractive && (await confirm('Run `construct embed supervise` now to keep the daemon running in the background (launchd/systemd)? [Y/n] '))) {
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'construct'), 'embed', 'supervise'], {
        cwd: target,
        stdio: quiet ? 'ignore' : 'inherit',
        env: process.env,
      });
      if (result.status !== 0 && !quiet) {
        console.log('  ⚠️  Could not install supervision automatically. Run `construct embed supervise` manually later.');
      }
    } else if (!quiet) {
      console.log('  Run `construct embed supervise` later to keep the daemon running in the background.');
    }
  } else if (!quiet) {
    console.log('  Continuous inbox watching is off. Enable it later with:');
    console.log('    construct config set autoEmbed true');
    console.log('    construct embed supervise');
  }

  // Ask about documentation system
  const { lanes, withArchitecture, withReadme, docsPreset: userDocsPreset } = await askDocumentationQuestions();
  
  // Create README.md if requested or missing
  const readmePath = path.join(target, "README.md");
  if (withReadme || !fs.existsSync(readmePath)) {
    writeIfMissing(readmePath, buildProjectReadme(projectName));
  }

  // Create documentation system if lanes specified
  if (lanes.length > 0) {
    // Filter out lanes that the project already covers elsewhere
    // (issue #97: don't create docs/notes/meetings/ when internal/meetings/
    // has 12 markdown files). --force bypasses the filter.

    const deferredLanes = [];
    const lanesToScaffold = [];
    for (const laneKey of lanes) {
      const decision = shouldScaffoldLane(laneKey, detection, { force: forceScaffold });
      if (decision.skip) {
        deferredLanes.push({ laneKey, reason: decision.reason });
      } else {
        lanesToScaffold.push(laneKey);
      }
    }
    for (const { laneKey, reason } of deferredLanes) {
      console.log(`[init:docs] skipping docs/${DOC_LANES[laneKey].dir}/ — ${reason}. Run with --force to scaffold anyway.`);
      skipped.push(`docs/${DOC_LANES[laneKey].dir}/ (deferred to existing project structure)`);
    }

    if (lanesToScaffold.length > 0) {
      writeIfMissing(
        path.join(target, "docs", "README.md"),
        buildDocsReadme(projectName, lanesToScaffold)
      );

      for (const laneKey of lanesToScaffold) {
        copyLaneTemplates(laneKey);
      }
    }

    // Create architecture.md if requested
    if (withArchitecture) {
      writeIfMissing(
        path.join(target, "docs", "architecture.md"),
        `# ${projectName} Architecture\n\n## Overview\n\n## Components\n\n## Data Flow\n\n## Deployment\n`
      );
    }
  }

  // End-of-init summary block for what got deferred to existing project
  // structure. Mirrors the "Created:" section so users see WHY their docs/
  // tree is leaner than the default scaffold.

  if (!forceScaffold) {
    const summary = formatDeferralSummary(detection);
    if (summary && !quiet) {
      console.log('');
      console.log('Deferred to existing project structure (use --force to scaffold anyway):');
      console.log(summary);
    }
  }
  
  // Output results (respect quiet mode)
  if (!quiet) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SETUP COMPLETE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    
    if (created.length) {
      console.log('Created:');
      for (const file of created) console.log(`  ${file}`);
      console.log('');
    }
    
    if (skipped.length && verbose) {
      console.log('Already exist (skipped):');
      for (const file of skipped) console.log(`  ${file}`);
      console.log('');
    }
    
    console.log(`${created.length} created, ${skipped.length} skipped`);
    console.log('');

    if (lanes.length > 0) {
      console.log('Documentation lanes enabled:');
      for (const lane of lanes) {
        console.log(`  • ${DOC_LANES[lane].title}`);
      }
      console.log('');
    }
  }

  // Vector-index seeding (embedding the project's existing docs so the agent
  // can compare new intake against established PRDs/RFCs/ADRs) is opt-in via
  // --seed-index (construct-rf26.17): the default init path performs zero
  // embedding work and never touches LanceDB, so a project that never uses
  // semantic search never pays for the model cache or the index directory.
  // `construct ingest` provisions both lazily on first real use.

  if (withSeedIndexFlag) {
    try {
      const { syncFileStateToSql } = await import('./storage/sync.mjs');
      const projectName = path.basename(target);
      const seed = await syncFileStateToSql(target, { env: process.env, project: projectName });
      if (seed?.status === 'ok' && (seed.documentsSynced || 0) > 0) {
        console.log(`\n🔍 Indexed existing project material: ${seed.documentsSynced} doc(s), ${seed.embeddingsSynced || 0} embeddings.`);
        console.log(`   The agent can now compare new intake (inbox/) against your existing PRDs, ADRs, and notes.`);
      }
    } catch { /* silent — corpus seeding is best-effort, not a setup blocker */ }
  }

  // ── Devcontainer recipe ────────────────────────────────────────────────
  if (withDevcontainerFlag) {
    const dcDir = path.join(target, '.devcontainer');
    const templateDir = path.join(ROOT_DIR, 'templates', 'devcontainer');
    fs.mkdirSync(dcDir, { recursive: true });
    for (const file of ['devcontainer.json', 'Dockerfile.devcontainer']) {
      const src = path.join(templateDir, file);
      const dst = path.join(dcDir, file);
      if (fs.existsSync(dst)) { skipped.push(`.devcontainer/${file}`); continue; }
      if (fs.existsSync(src)) { fs.copyFileSync(src, dst); created.push(`.devcontainer/${file}`); }
    }
  }

  if (!quiet) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  NEXT STEPS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    // Number steps from a running counter so the list stays sequential when
    // the optional intake step is absent (was: hard-coded 1,2,4 → a visible gap).
    let step = 0;
    console.log(`${++step}. Review AGENTS.md`);
    console.log('   Operating rules and guidelines for this project');
    console.log('');
    console.log(`${++step}. Edit plan.md`);
    console.log('   Add your current work and tasks');
    console.log('');
    if (created.includes('inbox/')) {
      console.log(`${++step}. Use Intake`);
      console.log('   Drop files in inbox/ for processing');
      console.log('   Run: construct intake');
      console.log('');
    }
    console.log(`${++step}. Start working`);
    console.log('   Address @construct in your editor to begin');
    console.log('');
  }
  
  // Auto-start services by default (silent unless verbose)
  const shouldStart = !args.includes('--no-start') && 
    (args.includes('--auto-start') || !interactive);
  
  if (shouldStart) {
    if (verbose) console.log('\nStarting services...');
    try {
      const { startServices } = await import('./service-manager.mjs');
      const { homedir } = await import('node:os');

      const { results } = await startServices({
        rootDir: target,
        homeDir: homedir(),
      });
      
      if (!quiet) {
        console.log('\nServices:');
        for (const svc of results) {
          if (svc.status === 'started' || svc.status === 'reused') {
            const status = svc.status === 'reused' ? ' (running)' : '';
            console.log(`  ${svc.name}${status}${svc.url ? ` ${svc.url}` : ''}`);
          } else if (svc.status === 'failed') {
            console.log(`  ${svc.name} — failed${svc.note ? ` (${svc.note})` : ''}`);
          }
        }

        const telemetrySvc = results.find(r => r.name === 'Telemetry' && r.url?.includes('localhost'));
        if (telemetrySvc) console.log(`\nTelemetry: ${telemetrySvc.url}`);
        console.log('\nStop services with `construct stop`');
      }
    } catch (error) {
      console.error(`Services could not be started: ${error.message}`);
      console.error(`Run 'construct dev' manually when ready`);
    }
  } else if (!quiet) {
    console.log(`\nRun 'construct dev' to start services`);
  }

  // First-run honesty signal (construct-vzg2i.1): tells the user, at the
  // moment they finish `construct init`, whether specialists will actually
  // reason (EXECUTE) or only produce a plan (PLAN) — reuses the same
  // readiness resolution `construct doctor` and orchestration_run itself
  // call, so this can never diverge from what a real run would do. Printed
  // unconditionally (not gated on --quiet): silently degrading execute to
  // plan is the exact failure this line exists to prevent.
  try {
    const { buildOrchestrationReadiness, formatFirstRunExecutionReadiness } = await import('./orchestration/readiness.mjs');
    const readiness = buildOrchestrationReadiness({}, { env: process.env, cwd: target });
    console.log(formatFirstRunExecutionReadiness(readiness));
  } catch (error) {
    console.error(`Orchestration readiness check failed: ${error.message}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

export default main;
