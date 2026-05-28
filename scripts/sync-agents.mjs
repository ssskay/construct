#!/usr/bin/env node
/**
 * sync-agents.mjs — regenerate agent adapters for all platforms from agents/registry.json.
 *
 * Reads registry.json, resolves env vars and model tiers, then writes Claude Code,
 * OpenCode, Codex, Copilot, VS Code, and Cursor adapters. Called by 'construct sync'.
 *
 * Flags:
 *   --dry-run             Print a diff of what would change without writing anything.
 *   --force               Bypass prompt word-cap hard stop (still warns).
 *   --project             Write to the current project's .claude/ directory only.
 *   --compress-personas   Run the engine's Compressor on every persona prompt
 *                         before writing platform adapters. The source persona
 *                         file is unchanged; only the runtime adapter is shorter.
 *                         Lossy by definition — opt-in only.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateCompletions } from "../lib/completions.mjs";
import {
  buildCodexMcpEntry,
  getCodexConfigPath,
  readCodexConfig,
  removeDanglingConstructMcpMarkers,
  removeDanglingConstructMcpTimeouts,
  removeTomlTables,
  serializeCodexMcpTable,
  tomlString,
  writeCodexConfig,
} from "../lib/codex-config.mjs";
import { findOpenCodeConfigPath, readOpenCodeConfig, writeOpenCodeConfig } from "../lib/opencode-config.mjs";
import { resolvePromptContract } from "../lib/prompt-composer.js";
import {
  buildClaudeMcpEntry,
  buildOpenCodeMcpEntry,
  getOpenCodeMcpId,
} from "../lib/mcp-platform-config.mjs";
import { loadConstructEnv } from "../lib/env-config.mjs";
import { inlineRoleAntiPatterns, PROMPT_WORD_CAP } from "../lib/role-preload.mjs";
import { resolveActiveProfile } from "../lib/profiles/loader.mjs";
import { resolveTiersForPrimary } from "../lib/model-router.mjs";
import { stampFrontmatter } from "../lib/doc-stamp.mjs";

const home = os.homedir();
const root = path.resolve(import.meta.dirname, "..");

const mergedEnv = loadConstructEnv({ rootDir: root, homeDir: home, env: process.env });
for (const [key, value] of Object.entries(mergedEnv)) {
  if (!(key in process.env)) process.env[key] = value;
}
if (!process.env.CX_TOOLKIT_DIR) process.env.CX_TOOLKIT_DIR = root;
const registryPath = path.join(root, "agents", "registry.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));

function validateRegistry(registry) {
  const errors = [];
  if (!registry.version) errors.push("Missing 'version' field");
  if (!registry.system) errors.push("Missing 'system' field");
  if (!registry.prefix) errors.push("Missing 'prefix' field");
  if (!Array.isArray(registry.agents)) errors.push("Missing or invalid 'agents' array");
  if (!Array.isArray(registry.personas)) errors.push("Missing or invalid 'personas' array");
  const validTiers = new Set(["reasoning", "standard", "fast"]);
  const names = new Set();

  for (const persona of registry.personas ?? []) {
    if (!persona.name) { errors.push("Persona missing 'name'"); continue; }
    if (names.has(persona.name)) errors.push(`Duplicate name: ${persona.name}`);
    names.add(persona.name);
    if (!persona.description) errors.push(`${persona.name}: missing 'description'`);
    if (!persona.promptFile) errors.push(`${persona.name}: missing 'promptFile'`);
    if (!persona.displayName) errors.push(`${persona.name}: missing 'displayName'`);
  }

  for (const agent of registry.agents ?? []) {
    if (!agent.name) { errors.push("Agent missing 'name'"); continue; }
    if (names.has(agent.name)) errors.push(`Duplicate name: ${agent.name}`);
    names.add(agent.name);
    if (!agent.prompt && !agent.promptFile) errors.push(`${agent.name}: missing 'prompt' or 'promptFile'`);
    if (!agent.description) errors.push(`${agent.name}: missing 'description'`);
    if (!agent.model && !agent.modelTier) errors.push(`${agent.name}: needs 'model' or 'modelTier'`);
    if (agent.modelTier && !validTiers.has(agent.modelTier)) errors.push(`${agent.name}: invalid modelTier '${agent.modelTier}'`);
    if (!agent.claudeTools) errors.push(`${agent.name}: missing 'claudeTools'`);
    if (agent.modelGuidance && typeof agent.modelGuidance !== "object") {
      errors.push(`${agent.name}: modelGuidance must be an object`);
    }
  }

  if (registry.modelGuidance) {
    if (typeof registry.modelGuidance !== "object" || Array.isArray(registry.modelGuidance)) {
      errors.push("Top-level modelGuidance must be an object");
    } else {
      for (const [key, val] of Object.entries(registry.modelGuidance)) {
        if (typeof val !== "string") errors.push(`modelGuidance.${key}: value must be a string`);
      }
    }
  }

  if (!registry.models || typeof registry.models !== "object") {
    errors.push("Missing or invalid 'models' object");
  } else {
    for (const tier of ["reasoning", "standard", "fast"]) {
      const t = registry.models[tier];
      if (!t || typeof t !== "object") {
        errors.push(`models.${tier}: missing tier object`);
        continue;
      }
      if (t.primary !== null && (typeof t.primary !== "string" || !t.primary)) {
        errors.push(`models.${tier}: primary must be null or a non-empty string`);
      }
    }
  }

  return errors;
}

const validationErrors = validateRegistry(registry);
if (validationErrors.length > 0) {
  console.error("Registry validation failed:");
  for (const err of validationErrors) console.error(`  - ${err}`);
  process.exit(1);
}

// Sync-time contract validation: contracts.json shape, schema refs, and
// producer/consumer name resolution against the registry above.
{
  const { validateContractsFile } = await import("../lib/contracts/validate.mjs");
  const contractsResult = validateContractsFile();
  if (!contractsResult.ok) {
    console.error("Contract validation failed:");
    for (const err of contractsResult.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
}

// --- Dry-run + lockfile + two-phase write infrastructure ---

const DRY_RUN = process.argv.includes("--dry-run");
const COMPRESS_PERSONAS = process.argv.includes("--compress-personas");
const projectDir = process.argv.includes("--project") ? process.cwd() : null;
const lockPath = path.join(projectDir || root, ".cx", "sync.lock");
const stagingDir = path.join(projectDir || root, ".cx", "sync-staging");

/** Acquire an exclusive lockfile. Aborts if already held by a live process. */
function acquireLock() {
  if (DRY_RUN) return;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      const holder = fs.readFileSync(lockPath, "utf8").trim();
      // Check whether the holding process is still alive
      let holderAlive = false;
      try { process.kill(Number(holder), 0); holderAlive = true; } catch { /* dead */ }
      if (holderAlive) {
        console.error(`[sync] Another sync is already running (pid ${holder}). Aborting.`);
        console.error(`[sync] If this is stale, remove .cx/sync.lock and retry.`);
        process.exit(1);
      }
      // Stale lock — steal it
      fs.writeFileSync(lockPath, String(process.pid), { flag: "w" });
      return;
    }
    throw err;
  }
}

/** Release the lockfile. Called in a finally block. */
function releaseLock() {
  if (DRY_RUN) return;
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

/**
 * Staging-aware write. In dry-run mode, writes to the staging dir instead of the
 * real destination and records the path pair for diff output. In normal mode,
 * writes to staging first, then the real path is swapped in by commitStaging().
 */
const _stagedPairs = []; // [{ staging, real, content }]

function writeFile(file, content) {
  mkdirp(path.dirname(file));
  const stamped = file.endsWith('.md') ? stampFrontmatter(content, { generator: 'construct/sync-agents' }) : content;

  if (DRY_RUN) {
    // Stage in memory only — compare against current on-disk content.
    let current = "";
    try { current = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
    if (current !== stamped) _stagedPairs.push({ real: file, staging: null, content: stamped, current });
    return;
  }

  // Two-phase: write to staging, commit later.
  const rel = path.relative(projectDir || root, file);
  const stagingPath = path.join(stagingDir, rel);
  mkdirp(path.dirname(stagingPath));
  fs.writeFileSync(stagingPath, stamped);
  _stagedPairs.push({ real: file, staging: stagingPath, content: stamped });
}

/** Atomically rename all staged files into their real destinations. */
function commitStaging() {
  for (const { real, staging } of _stagedPairs) {
    if (!staging) continue;
    mkdirp(path.dirname(real));
    fs.renameSync(staging, real);
  }
  // Clean up staging dir.
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ok */ }
}

/** Print a human-readable diff summary for --dry-run mode. */
function printDryRunDiff() {
  if (_stagedPairs.length === 0) {
    console.log("[sync --dry-run] No changes — all outputs are already up to date.");
    return;
  }
  console.log(`[sync --dry-run] ${_stagedPairs.length} file(s) would change:\n`);
  for (const { real } of _stagedPairs) {
    console.log(`  ~ ${path.relative(root, real)}`);
  }
  console.log("\nRe-run without --dry-run to apply.");
}

const systemName = registry.system;
const agentPrefix = `${registry.prefix}-`;
const sharedGuidance = registry.sharedGuidance ?? [];
const platformGuidance = registry.platformGuidance ?? {};
const globalModelGuidance = registry.modelGuidance ?? {};

const generatedHeader = `# Generated by ${systemName}/sync-agents.mjs. Edit agents/registry.json instead.`;
const generatedMarkdownNote = [
  '<!--',
  `Generated by construct sync from agents/registry.json.`,
  'Do not edit this file directly — changes will be overwritten on next sync.',
  'Regenerate: construct sync',
  '-->',
  '',
  '> Generated from `agents/registry.json`. Edit the registry, then run `construct sync`.',
].join('\n');

const standardConstructTools = [
  "list_skills",
  "get_skill",
  "search_skills",
  "workflow_status",
  "workflow_update_task",
  "workflow_needs_main_input",
  "memory_search",
  "memory_add_observations",
  "cx_trace",
  "cx_score",
].join(",");
const managedStart = `# BEGIN ${systemName.toUpperCase()} AGENTS`;
const managedEnd = `# END ${systemName.toUpperCase()} AGENTS`;
const mdManagedStart = `<!-- BEGIN ${systemName.toUpperCase()} AGENTS -->`;
const mdManagedEnd = `<!-- END ${systemName.toUpperCase()} AGENTS -->`;

const registryModels = registry.models ?? {};

const envPrefix = registry.prefix.toUpperCase();

// Substitute __VAR_NAME__ placeholders with actual env vars.
// Falls back to the placeholder string if the env var is not set.
function resolveEnvBlock(envObj) {
  if (!envObj) return undefined;
  const result = {};
  for (const [k, v] of Object.entries(envObj)) {
    if (typeof v === "string") {
      result[k] = v.replace(/__([A-Z0-9_]+)__/g, (_, name) => process.env[name] ?? v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function resolveArgs(args) {
  if (!Array.isArray(args)) return args;
  return args.map((a) => (typeof a === "string"
    ? a.replace(/__([A-Z0-9_]+)__/g, (_, name) => process.env[name] ?? `__${name}__`)
    : a));
}

function extractFallbackChain(tierDef) {
  if (typeof tierDef === "string") return [tierDef];
  if (tierDef && typeof tierDef === "object") {
    const chain = [];
    if (tierDef.primary) chain.push(tierDef.primary);
    if (Array.isArray(tierDef.fallback)) chain.push(...tierDef.fallback);
    return chain;
  }
  return [];
}

const hardDefaults = {
  reasoning: "openrouter/deepseek/deepseek-r1",
  standard: "openrouter/qwen/qwen3-coder:free",
  fast: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
};

// Primary model auto-detection: if the user picked a model in OpenCode config,
// derive tiered siblings from the same provider family so subagents share the
// primary's provider. Explicit CX_MODEL_* env wins if set.
const primaryFromOpenCode = (() => {
  try {
    const cfg = readOpenCodeConfig(findOpenCodeConfigPath()) ?? {};
    return cfg.model || cfg.defaultModel || null;
  } catch { return null; }
})();
const familyTiers = primaryFromOpenCode ? (resolveTiersForPrimary(primaryFromOpenCode) || {}) : {};

const resolvedModels = {
  reasoning: process.env[`${envPrefix}_MODEL_REASONING`]
    || familyTiers.reasoning
    || extractFallbackChain(registryModels.reasoning)[0]
    || hardDefaults.reasoning,
  standard: process.env[`${envPrefix}_MODEL_STANDARD`]
    || familyTiers.standard
    || extractFallbackChain(registryModels.standard)[0]
    || hardDefaults.standard,
  fast: process.env[`${envPrefix}_MODEL_FAST`]
    || familyTiers.fast
    || extractFallbackChain(registryModels.fast)[0]
    || hardDefaults.fast,
};
if (primaryFromOpenCode && (familyTiers.reasoning || familyTiers.standard || familyTiers.fast)) {
  console.log(`[sync] Tier models derived from primary '${primaryFromOpenCode}': reasoning=${resolvedModels.reasoning} standard=${resolvedModels.standard} fast=${resolvedModels.fast}`);
}

// Full ordered fallback chains per tier (env override → registry chain → hard default)
const resolvedFallbackChains = {
  reasoning: [
    ...(process.env[`${envPrefix}_MODEL_REASONING`] ? [process.env[`${envPrefix}_MODEL_REASONING`]] : []),
    ...extractFallbackChain(registryModels.reasoning),
    hardDefaults.reasoning,
  ].filter((v, i, a) => v && a.indexOf(v) === i),
  standard: [
    ...(process.env[`${envPrefix}_MODEL_STANDARD`] ? [process.env[`${envPrefix}_MODEL_STANDARD`]] : []),
    ...extractFallbackChain(registryModels.standard),
    hardDefaults.standard,
  ].filter((v, i, a) => v && a.indexOf(v) === i),
  fast: [
    ...(process.env[`${envPrefix}_MODEL_FAST`] ? [process.env[`${envPrefix}_MODEL_FAST`]] : []),
    ...extractFallbackChain(registryModels.fast),
    hardDefaults.fast,
  ].filter((v, i, a) => v && a.indexOf(v) === i),
};

function resolveModel(entry) {
  if (entry.model) return entry.model;
  const tier = entry.modelTier && resolvedModels[entry.modelTier] ? entry.modelTier : "standard";
  return resolvedModels[tier];
}

function resolveModelChain(entry) {
  if (entry.model) return [entry.model];
  const tier = entry.modelTier && resolvedFallbackChains[entry.modelTier] ? entry.modelTier : "standard";
  return resolvedFallbackChains[tier];
}

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

function adapterName(entry) {
  return entry.isPersona ? entry.name : `${agentPrefix}${entry.name}`;
}

function loadPersonaPrompt(persona) {
  const promptPath = persona.promptFile ? path.join(root, persona.promptFile) : null;
  const fallback = `You are ${persona.displayName}. ${persona.description}`;
   const { prompt } = resolvePromptContract(persona, {
    rootDir: root,
    registry,
    fallback,
  });
  if (!prompt) {
    console.warn(`Warning: prompt file not found for persona ${persona.name}: ${promptPath}`);
    return fallback;
  }
  return prompt;
}

export function buildAgentRoster(allEntries) {
  return allEntries.map((e) => `- ${adapterName(e)}: ${e.when_to_use || e.description}`).join("\n");
}

function buildModelGuidanceBlock(entry) {
  const merged = { ...globalModelGuidance, ...(entry.modelGuidance ?? {}) };
  const families = Object.keys(merged);
  if (families.length === 0) return "";
  const lines = families.map((family) => `- ${merged[family]}`).join("\n");
  return `\n\nModel-specific guidance (apply only the section that matches your model family):\n${lines}`;
}

function buildRoleFooter(entry) {
  const lines = [];
  const collaborators = Array.isArray(entry.collaborators) ? entry.collaborators.filter(Boolean) : [];
  if (collaborators.length > 0) {
    lines.push(`Collaborators: ${collaborators.map((c) => (c.startsWith("cx-") ? c : `cx-${c}`)).join(", ")}.`);
  }
  if (entry.isPersona !== true && entry.canEdit === false) {
    lines.push("Do not implement code or edit source files.");
  }
  if (entry.returnsStructured !== false) {
    lines.push("Return exactly one terminal state per task: DONE (with evidence) | BLOCKED (with concrete blocker) | NEEDS_MAIN_INPUT (with question + safe default).");
  }
  if (lines.length === 0) return "";
  return `\n\n${lines.join("\n")}`;
}

function buildPrompt(entry, allEntries, platform) {
  let prompt = resolvePromptContract(entry, {
    rootDir: root,
    registry,
    fallback: entry.prompt || '',
  }).prompt;

  prompt = inlineRoleAntiPatterns(prompt, root, entry.name, console.warn, { preload: entry.preloadRoleGuidance === true });

  if (entry.injectAgentRoster && allEntries) {
    const roster = buildAgentRoster(allEntries);
    prompt = `Available specialist agents:\n${roster}\n\n${prompt}`;
  }

  prompt += buildRoleFooter(entry);

  const platformItems = platformGuidance[platform] ?? [];
  const allGuidance = [...sharedGuidance, ...platformItems];
  if (allGuidance.length > 0) {
    const guidance = allGuidance.map((item) => `- ${item}`).join("\n");
    prompt = `${prompt}\n\nOperating guidance:\n${guidance}`;
  }

  prompt += buildModelGuidanceBlock(entry);

  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const effectiveCap = Number(entry.wordCapOverride) > 0 ? entry.wordCapOverride : PROMPT_WORD_CAP;
  if (wordCount > effectiveCap) {
    const msg = `[sync] ${entry.name}: prompt is ${wordCount} words (cap ${effectiveCap})`;
    if (process.env.CONSTRUCT_SYNC_FORCE === '1' || process.argv.includes('--force')) {
      console.warn(`${msg} — proceeding due to --force / CONSTRUCT_SYNC_FORCE=1.`);
    } else {
      console.error(`${msg}`);
      console.error(
        `[sync] Hard cap exceeded. Options:\n` +
        `   - trim the prompt body or move detail to a skill (preferred)\n` +
        `   - set "wordCapOverride": <N> on this entry in agents/registry.json with a written reason\n` +
        `   - re-run with --force or CONSTRUCT_SYNC_FORCE=1 as a temporary escape hatch\n` +
        `Prompt budget is a hard contract because every over-cap agent degrades every session that dispatches it.`,
      );
      process.exit(1);
    }
  }

  return prompt;
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function replaceManagedBlock(text, block, start = managedStart, end = managedEnd) {
  const pattern = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");
  const normalizedBlock = `${start}\n${block.trimEnd()}\n${end}\n`;
  if (pattern.test(text)) return text.replace(pattern, `\n${normalizedBlock}`);
  return `${text.trimEnd()}\n\n${normalizedBlock}`;
}

const MANIFEST_FILE = ".construct-manifest";

function readManifest(dir) {
  const p = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(p)) return new Set();
  return new Set(fs.readFileSync(p, "utf8").split("\n").filter(Boolean));
}

function writeManifest(dir, files) {
  if (DRY_RUN) return;
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), [...files].sort().join("\n") + "\n");
}

function removeStaleAdapters(dir, ext, entries) {
  if (!fs.existsSync(dir)) return;

  const expected = new Set();
  for (const e of entries) {
    expected.add(`${adapterName(e)}${ext}`);
  }

  // Stale manifest entries — delete files not in the current expected set.
  const previouslyWritten = readManifest(dir);
  for (const file of previouslyWritten) {
    if (!expected.has(file) && fs.existsSync(path.join(dir, file))) {
      fs.unlinkSync(path.join(dir, file));
    }
  }

  writeManifest(dir, expected);
}

// --- Unified entry list: personas + agents ---

function buildEntries() {
  const entries = [];

  for (const persona of registry.personas ?? []) {
    const personaCanEdit = persona.permissions?.edit === "allow";
    entries.push({
      ...persona,
      isPersona: true,
      prompt: loadPersonaPrompt(persona),
      codexSandbox: persona.codexSandbox ?? (personaCanEdit ? "workspace-write" : "read-only"),
      reasoningEffort: persona.reasoningEffort ?? "high",
    });
  }

  // Filter agents by the active profile's role set. RND lists every specialist
  // so behavior is unchanged for the default; non-RND profiles emit only the
  // specialists they declare. Profiles whose role list is empty (legacy/test)
  // fall through to no filter so callers don't get a silent empty registry.
  const activeProfile = resolveActiveProfile(process.cwd());
  const profileRoles = Array.isArray(activeProfile?.roles) && activeProfile.roles.length > 0
    ? new Set(activeProfile.roles)
    : null;

  for (const agent of registry.agents ?? []) {
    if (profileRoles && !profileRoles.has(agent.name)) continue;
    entries.push({
      ...agent,
      isPersona: false,
    });
  }

  return entries;
}

// --- Claude Code adapter ---

function claudeAgentMarkdown(entry, allEntries) {
  const name = adapterName(entry);
  const baseTools = entry.claudeTools ?? "Read,Grep,Glob,LS";
  // Merge base tools with standard construct tools, ensuring no duplicates
  const toolSet = new Set([
    ...baseTools.split(",").map((t) => t.trim()),
    ...standardConstructTools.split(","),
  ]);
  const tools = Array.from(toolSet).filter(Boolean).join(",");

  return `---
name: ${name}
description: ${entry.description}
tools: ${tools}
---

${generatedMarkdownNote}

${buildPrompt(entry, allEntries, "claude")}
`;
}

/**
 * Rewrite the home-mode hook command pattern
 *   node "$HOME/.construct/lib/hooks/<name>.mjs"
 * into the project-portable form
 *   node .construct/run.mjs hook <name>
 * so the resulting settings.json works on any clone where the project ships
 * the .construct/ launcher (committed by `npm install`'s postinstall or by
 * `construct init`). The launcher resolves Construct via node_modules → npx
 * → globally-installed CLI → cached binary → docker, in that order, so it
 * works for non-Node ecosystems too. Other commands (inline node -e
 * snippets, npx block-no-verify@…) are left untouched.
 */
function makeHooksPortable(hooksJson) {
  // Operate on the in-memory object so we don't fight JSON string escaping.
  const replaceCommand = (cmd) => {
    if (typeof cmd !== 'string') return cmd;
    const m = cmd.match(/^node\s+"?\$HOME\/\.construct\/lib\/hooks\/([a-z0-9-]+)\.mjs"?\s*(.*)$/);
    if (!m) return cmd;
    const [, name, rest] = m;
    return `node .construct/run.mjs hook ${name}${rest ? ' ' + rest.trim() : ''}`;
  };

  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = k === 'command' ? replaceCommand(v) : walk(v);
      }
      return out;
    }
    return node;
  };

  return JSON.stringify(walk(hooksJson));
}

/**
 * Materialise a project-local `.claude/settings.json` from the home template,
 * with hook commands rewritten to be path-relative to whatever Construct
 * install the project carries. Merges into an existing settings.json
 * if one is already in the project; otherwise creates a fresh one.
 */
function writeProjectClaudeSettings(targetDir) {
  const settingsPath = path.join(targetDir, ".claude", "settings.json");
  const templatePath = path.join(root, "platforms", "claude", "settings.template.json");
  if (!fs.existsSync(templatePath)) return;

  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));

  const existing = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};

  if (template.hooks) {
    existing.hooks = JSON.parse(makeHooksPortable(template.hooks));
  }
  if (template.permissions) {
    existing.permissions ??= template.permissions;
  }
  if (template.mcpServers) {
    existing.mcpServers ??= {};
    for (const [id, mcpDef] of Object.entries(template.mcpServers)) {
      if (existing.mcpServers[id]) continue;
      existing.mcpServers[id] = mcpDef;
    }
  }

  if (DRY_RUN) return;
  mkdirp(path.dirname(settingsPath));
  writeFile(settingsPath, JSON.stringify(existing, null, 2) + "\n");
}

function syncClaude(entries, targetDir = null) {
  const claudeAgentsDir = targetDir
    ? path.join(targetDir, ".claude", "agents")
    : path.join(home, ".claude", "agents");
  if (!DRY_RUN) mkdirp(claudeAgentsDir);

  for (const entry of entries) {
    const name = adapterName(entry);
    const md = claudeAgentMarkdown(entry, entries);
    writeFile(path.join(claudeAgentsDir, `${name}.md`), md);
  }
  removeStaleAdapters(claudeAgentsDir, ".md", entries);

  if (targetDir) {
    writeProjectClaudeSettings(targetDir);
    return;
  }

  if (!targetDir) {
    const claudeMdPath = path.join(home, ".claude", "CLAUDE.md");
    const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "# Claude Global Instructions\n";
    const personaList = entries.filter((e) => e.isPersona).map((e) => `- \`${adapterName(e)}\`: ${e.role} — ${e.description}`).join("\n");
    // Only surface non-internal agents in CLAUDE.md — internal agents are dispatched by Construct, not invoked by users
    const agentList = entries.filter((e) => !e.isPersona && !e.internal).map((e) => `- \`${adapterName(e)}\`: ${e.description}`).join("\n");
    const note = `## ${systemName.charAt(0).toUpperCase() + systemName.slice(1)} Personas

${personaList}

## Internal Specialists

${agentList || "(all specialists are internal — routed through Construct)"}`;
    writeFile(claudeMdPath, replaceManagedBlock(existing, note, mdManagedStart, mdManagedEnd));

    // Sync MCP servers into ~/.claude/settings.json if it exists
    const claudeSettingsPath = path.join(home, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
      const templatePath = path.join(root, "platforms", "claude", "settings.template.json");
      if (fs.existsSync(templatePath)) {
        const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
        if (template.hooks) {
          // Resolve $HOME/.construct to the real path so hook commands survive
          // symlink traversal inside Claude Code's hook runner environment.
          const constructReal = (() => {
            try { return fs.realpathSync(path.join(home, ".construct")); } catch { return path.join(home, ".construct"); }
          })();
          const hookStr = JSON.stringify(template.hooks)
            .replace(/\$HOME\/\.construct/g, constructReal.replace(/\\/g, "/"));
          settings.hooks = JSON.parse(hookStr);
        }
      }
      if (!settings.mcpServers) settings.mcpServers = {};
      const registryMcp = registry.mcpServers ?? {};
      for (const [id, mcpDef] of Object.entries(registryMcp)) {
        const existingEntry = settings.mcpServers[id];
        const existing = JSON.stringify(existingEntry ?? "");
        const hasPlaceholder = existing.includes("__");
        const registryWantsCommand = !mcpDef.type && Array.isArray(mcpDef.args);
        const existingIsRemote = existingEntry && (existingEntry.type === 'http' || existingEntry.type === 'remote');
        const transportMismatch = registryWantsCommand && existingIsRemote;
        if (existingEntry && !hasPlaceholder && !transportMismatch) continue;
        settings.mcpServers[id] = buildClaudeMcpEntry(id, mcpDef, process.env);
      }
      if (!DRY_RUN) fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
  }
}

// --- Codex adapter ---

function codexAgentToml(entry, allEntries) {
  const name = adapterName(entry);
  return `${generatedHeader}
name = ${tomlString(name)}
description = ${tomlString(entry.description)}
model = ${tomlString(resolveModel(entry))}
model_reasoning_effort = ${tomlString(entry.reasoningEffort ?? "medium")}
sandbox_mode = ${tomlString(entry.codexSandbox ?? "read-only")}

developer_instructions = ${tomlString(buildPrompt(entry, allEntries, "codex"))}
`;
}

function removeCodexAgentTables(text, names) {
  let next = text
    .replace(/\n?# BEGIN GLOBAL AI AGENTS\n[\s\S]*?# END GLOBAL AI AGENTS\n?/m, "\n")
    .replace(new RegExp(`\\n?${escapeRegExp(managedStart)}\\n[\\s\\S]*?${escapeRegExp(managedEnd)}\\n?`), "\n");
  for (const name of names) {
    const pattern = new RegExp(`\\n?\\[agents\\.${escapeRegExp(name)}\\]\\n[\\s\\S]*?(?=\\n\\[|\\n?${escapeRegExp(managedStart)}|(?![\\s\\S]))`);
    next = next.replace(pattern, "\n");
  }
  return next.replace(/\n{3,}/g, "\n\n");
}

function hasCodexMcpTable(text, id) {
  return new RegExp(`^\\[mcp_servers\\.(?:${escapeRegExp(id)}|${escapeRegExp(tomlString(id))})\\]`, "m").test(text);
}

function isCodexMcpSupported() {
  return true;
}

function syncCodex(entries) {
  const codexDir = path.join(home, ".codex");
  const codexAgentsDir = path.join(codexDir, "agents");
  if (!DRY_RUN) mkdirp(codexAgentsDir);

  for (const entry of entries) {
    writeFile(path.join(codexAgentsDir, `${adapterName(entry)}.toml`), codexAgentToml(entry, entries));
  }
  removeStaleAdapters(codexAgentsDir, ".toml", entries);

  const configPath = getCodexConfigPath(home);
  const existing = removeDanglingConstructMcpMarkers(removeDanglingConstructMcpTimeouts(readCodexConfig(configPath)));
  const entryNames = entries.map(adapterName);
  const registryMcp = registry.mcpServers ?? {};
  const existingMcpIds = Object.keys(registryMcp).filter((id) => hasCodexMcpTable(existing, id));
  const mcpIds = existingMcpIds.filter(isCodexMcpSupported);
  const withoutManagedTables = removeDanglingConstructMcpMarkers(removeTomlTables(
    removeCodexAgentTables(existing, entryNames),
    existingMcpIds.flatMap((id) => [`mcp_servers.${id}`, `mcp_servers.${tomlString(id)}`]),
  ));
  const hasAgentsRoot = /^\[agents\]\s*$/m.test(withoutManagedTables);
  const rootBlock = hasAgentsRoot ? "" : "[agents]\nmax_threads = 6\nmax_depth = 1\n\n";
  // Only expose non-internal agents in Codex config; internal agents are dispatched by Construct
  const blocks = entries.filter((e) => !e.internal).map((e) => `[agents.${adapterName(e)}]
description = ${tomlString(e.description)}
config_file = ${tomlString(`agents/${adapterName(e)}.toml`)}
`).join("\n");

  const mcpBlock = mcpIds
    .map((id) => serializeCodexMcpTable(id, buildCodexMcpEntry(id, registryMcp[id], process.env)))
    .join("\n\n");
  const withAgents = replaceManagedBlock(withoutManagedTables, `${rootBlock}${blocks}`);
  writeCodexConfig(replaceManagedBlock(
    withAgents,
    mcpBlock,
    `# BEGIN ${systemName.toUpperCase()} MCP SERVERS`,
    `# END ${systemName.toUpperCase()} MCP SERVERS`,
  ), configPath);
}

// --- Copilot adapter ---

function copilotPrompt(entry, allEntries) {
  const name = adapterName(entry);
  return `---
mode: agent
description: ${entry.description}
---

${generatedMarkdownNote}

# ${name}

${buildPrompt(entry, allEntries, "copilot")}

When using this prompt, stay within the role above and adapt to the current repository instructions.
`;
}

function syncCopilot(entries) {
  const promptsDir = path.join(home, ".github", "prompts");
  if (!DRY_RUN) mkdirp(promptsDir);
  for (const entry of entries) {
    writeFile(path.join(promptsDir, `${adapterName(entry)}.prompt.md`), copilotPrompt(entry, entries));
  }
  removeStaleAdapters(promptsDir, ".prompt.md", entries);

  const instructionsPath = path.join(home, ".github", "copilot-instructions.md");
  const existing = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, "utf8")
    : "# GitHub Copilot Instructions\n";
  const list = entries.filter((e) => !e.internal).map((e) => `- \`${adapterName(e)}\`: use \`~/.github/prompts/${adapterName(e)}.prompt.md\`.`).join("\n");
  const note = `## ${systemName.charAt(0).toUpperCase() + systemName.slice(1)} Agent Prompts

Copilot does not expose true spawnable subagents. Use these reusable prompt profiles for role-specific passes:

${list || "(all specialists are internal — use construct for all tasks)"}`;
  writeFile(instructionsPath, replaceManagedBlock(existing, note, mdManagedStart, mdManagedEnd));
}

// --- VS Code adapter ---

function getVSCodeSettingsPaths() {
  const platform = os.platform();
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "Code", "User", "settings.json"),
      path.join(home, "Library", "Application Support", "Code - Insiders", "User", "settings.json"),
    );
  } else if (platform === "linux") {
    candidates.push(
      path.join(home, ".config", "Code", "User", "settings.json"),
      path.join(home, ".config", "Code - Insiders", "User", "settings.json"),
    );
  } else if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    candidates.push(
      path.join(appData, "Code", "User", "settings.json"),
      path.join(appData, "Code - Insiders", "User", "settings.json"),
    );
  }
  return candidates.filter(fs.existsSync);
}

function syncVSCode() {
  const settingsPaths = getVSCodeSettingsPaths();
  if (settingsPaths.length === 0) return false;

  const registryMcp = registry.mcpServers ?? {};
  if (Object.keys(registryMcp).length === 0) return false;

  let synced = false;
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (!settings["github.copilot.mcpServers"]) settings["github.copilot.mcpServers"] = {};
      const mcpServers = settings["github.copilot.mcpServers"];
      for (const [id, mcpDef] of Object.entries(registryMcp)) {
        const existingEntry = mcpServers[id];
        const existing = JSON.stringify(existingEntry ?? "");
        const hasPlaceholder = existing.includes("__");
        const registryWantsCommand = !mcpDef.type && Array.isArray(mcpDef.args);
        const existingIsRemote = existingEntry && (existingEntry.type === 'http' || existingEntry.type === 'remote');
        const transportMismatch = registryWantsCommand && existingIsRemote;
        if (existingEntry && !hasPlaceholder && !transportMismatch) continue;
        mcpServers[id] = buildClaudeMcpEntry(id, mcpDef, process.env);
      }
      settings["github.copilot.mcpServers"] = mcpServers;
      if (!DRY_RUN) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      synced = true;
    } catch {
      // Skip unreadable settings files
    }
  }
  return synced;
}

// --- Cursor adapter ---

function syncCursor() {
  const cursorMcpPath = path.join(home, ".cursor", "mcp.json");
  if (!fs.existsSync(cursorMcpPath)) return false;

  const registryMcp = registry.mcpServers ?? {};
  if (Object.keys(registryMcp).length === 0) return false;

  try {
    const config = JSON.parse(fs.readFileSync(cursorMcpPath, "utf8"));
    if (!config.mcpServers) config.mcpServers = {};
    for (const [id, mcpDef] of Object.entries(registryMcp)) {
      const existingEntry = config.mcpServers[id];
      const existing = JSON.stringify(existingEntry ?? "");
      const hasPlaceholder = existing.includes("__");
      const registryWantsCommand = !mcpDef.type && Array.isArray(mcpDef.args);
      const existingIsRemote = existingEntry && (existingEntry.type === 'http' || existingEntry.type === 'remote');
      const transportMismatch = registryWantsCommand && existingIsRemote;
      if (existingEntry && !hasPlaceholder && !transportMismatch) continue;
      config.mcpServers[id] = buildClaudeMcpEntry(id, mcpDef, process.env);
    }
    if (!DRY_RUN) fs.writeFileSync(cursorMcpPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// --- OpenCode adapter ---

function opencodePermissions(entry) {
  if (entry.permissions) {
    return Object.fromEntries(
      Object.entries(entry.permissions).map(([k, v]) => [k, v])
    );
  }
  return { edit: "allow", bash: "allow" };
}

function opencodeTaskPermissions(entry) {
  if (entry.permissions?.task) return entry.permissions.task;
  return {
    "*": "allow",
  };
}

function syncOpencode(entries) {
  const configPath = findOpenCodeConfigPath();
  if (!fs.existsSync(configPath)) return false;
  const pluginsDir = path.join(home, ".config", "opencode", "plugins");
  const managedPluginPath = path.join(pluginsDir, "construct-fallback.js");
  const toolkitPluginPath = path.join(root, "platforms", "opencode", "plugins", "construct-fallback.js");

  const { config } = readOpenCodeConfig();
  if (!config.agent) config.agent = {};
  if (!Array.isArray(config.plugin)) config.plugin = [];
  config.plugin = config.plugin.filter((entry) => {
    if (typeof entry !== "string") return true;
    return entry !== managedPluginPath && entry !== toolkitPluginPath;
  });

  // Sync providers
  const registryProviders = registry.providers ?? {};
  if (Object.keys(registryProviders).length > 0) {
    if (!config.provider) config.provider = {};
    for (const [id, providerDef] of Object.entries(registryProviders)) {
      const existing = config.provider[id] ?? {};
      const existingAuth = existing.options?.headers?.Authorization;
      const existingModels = existing.models ?? {};
      config.provider[id] = {
        ...providerDef,
        options: {
          ...providerDef.options,
          headers: {
            ...providerDef.options?.headers,
            ...(existingAuth ? { Authorization: existingAuth } : {}),
          },
        },
        models: Object.fromEntries(
          Object.entries({ ...(providerDef.models ?? {}), ...existingModels })
            .sort((a, b) => (a[1].name ?? a[0]).localeCompare(b[1].name ?? b[0]))
        ),
      };
    }
  }

  // Derive anthropic models from registry tier definitions
  const tierModels = Object.values(registry.models ?? {}).flatMap((t) =>
    [t.primary, ...(t.fallback ?? [])].filter((m) => m?.startsWith('anthropic/'))
  );
  if (tierModels.length > 0) {
    if (!config.provider) config.provider = {};
    if (!config.provider.anthropic) config.provider.anthropic = {};
    const existing = config.provider.anthropic.models ?? {};
    const derived = {};
    for (const full of [...new Set(tierModels)]) {
      const id = full.replace(/^anthropic\//, '');
      if (!existing[id]) {
        const parts = id.replace(/^claude-/, '').split('-');
        const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        const version = parts.slice(1).filter((p) => !/^\d{8,}$/.test(p)).join('.');
        derived[id] = { name: `Claude ${family} ${version}`.trim() };
      }
    }
    config.provider.anthropic.models = Object.fromEntries(
      Object.entries({ ...derived, ...existing })
        .sort((a, b) => (a[1].name ?? a[0]).localeCompare(b[1].name ?? b[0]))
    );
  }

  // Sync MCP servers
  const registryMcp = registry.mcpServers ?? {};
  if (Object.keys(registryMcp).length > 0) {
    if (!config.mcp) config.mcp = {};
    for (const [id, mcpDef] of Object.entries(registryMcp)) {
      const openCodeId = getOpenCodeMcpId(id);
      if (openCodeId !== id) delete config.mcp[id];
      if (id === 'memory') delete config.mcp.cass;

      // Migrate the legacy cass-memory HTTP entry to the stdio bridge. cm v0.2.x
      // rejects the MCP handshake (OpenCode surfaces 405 on the SSE GET), so
      // any remote/http memory entry must be rewritten when the registry
      // defines a command-based bridge.
      const existingEntry = config.mcp[openCodeId];
      const registryWantsCommand = !mcpDef.type && Array.isArray(mcpDef.args);
      const existingIsRemote = existingEntry && (existingEntry.type === 'remote' || existingEntry.type === 'http');
      const transportMismatch = registryWantsCommand && existingIsRemote;

      const existing = JSON.stringify(existingEntry ?? "");
      const hasPlaceholder = existing.includes("__");
      const argsHaveTemplates = (mcpDef.args ?? []).some((a) => typeof a === 'string' && a.includes('__'));
      if (!existingEntry || hasPlaceholder || argsHaveTemplates || transportMismatch) {
        config.mcp[openCodeId] = buildOpenCodeMcpEntry(id, mcpDef, process.env).entry;
      }
    }
  }

  // Remove stale agents that Construct manages.
  const prefixes = [agentPrefix];
  for (const key of Object.keys(config.agent)) {
    const isManaged = prefixes.some((p) => key.startsWith(p));
    const isPersona = registry.personas.some((p) => p.name === key);
    if ((isManaged || isPersona) && !entries.find((e) => adapterName(e) === key)) {
      delete config.agent[key];
    }
  }

  // Write agents — no model/modelFallback set; agents inherit the global model
  for (const entry of entries) {
    const name = adapterName(entry);
    const perms = opencodePermissions(entry);
    config.agent[name] = {
      description: entry.isPersona
        ? `${entry.role} — ${entry.description}`
        : entry.description,
      mode: entry.isPersona ? "all" : "subagent",
      prompt: buildPrompt(entry, entries, "opencode"),
      permission: {
        ...perms,
        task: opencodeTaskPermissions(entry),
      },
    };
  }

  writeOpenCodeConfig(config, configPath);

  const sourcePluginsDir = path.join(root, "platforms", "opencode", "plugins");
  if (fs.existsSync(sourcePluginsDir) && !DRY_RUN) {
    mkdirp(pluginsDir);
    for (const file of fs.readdirSync(sourcePluginsDir)) {
      if (!file.endsWith(".js") && !file.endsWith(".ts")) continue;
      const source = path.join(sourcePluginsDir, file);
      const target = path.join(pluginsDir, file);
      const content = fs.readFileSync(source, "utf8").replaceAll("__CX_TOOLKIT_DIR__", root);
      fs.writeFileSync(target, content);
    }
  }

  config.plugin = [...config.plugin, managedPluginPath];
  if (!DRY_RUN) writeOpenCodeConfig(config, configPath);

  return true;
}

// --- Slash commands adapter ---

function syncCommands(targetDir = null) {
  const sourceCommandsDir = path.join(root, "commands");
  if (!fs.existsSync(sourceCommandsDir)) return 0;

  const claudeCommandsDir = targetDir
    ? path.join(targetDir, ".claude", "commands")
    : path.join(home, ".claude", "commands");

  let count = 0;
  for (const domain of fs.readdirSync(sourceCommandsDir, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const domainDir = path.join(sourceCommandsDir, domain.name);
    const targetDomainDir = path.join(claudeCommandsDir, domain.name);
    if (!DRY_RUN) mkdirp(targetDomainDir);

    for (const file of fs.readdirSync(domainDir)) {
      if (!file.endsWith(".md")) continue;
      count++;
      if (DRY_RUN) continue;
      const source = path.join(domainDir, file);
      const target = path.join(targetDomainDir, file);
      fs.copyFileSync(source, target);
    }
  }

  // Clean up stale command files not in source
  if (!DRY_RUN && fs.existsSync(claudeCommandsDir)) {
    for (const domain of fs.readdirSync(claudeCommandsDir, { withFileTypes: true })) {
      if (!domain.isDirectory()) continue;
      const sourceDomainDir = path.join(sourceCommandsDir, domain.name);
      if (!fs.existsSync(sourceDomainDir)) {
        fs.rmSync(path.join(claudeCommandsDir, domain.name), { recursive: true });
        continue;
      }
      const sourceFiles = new Set(fs.readdirSync(sourceDomainDir).filter((f) => f.endsWith(".md")));
      for (const file of fs.readdirSync(path.join(claudeCommandsDir, domain.name))) {
        if (file.endsWith(".md") && !sourceFiles.has(file)) {
          fs.unlinkSync(path.join(claudeCommandsDir, domain.name, file));
        }
      }
    }
  }

  return count;
}

// --- Main ---

const entries = buildEntries();

if (COMPRESS_PERSONAS) {
  // Run the engine's Compressor on every persona prompt so the runtime
  // adapter file is shorter than the source persona on disk. The source
  // file stays unchanged so authors keep editing the readable version.
  const { getEngine } = await import('./lib/engine/index.mjs');
  const engine = await getEngine({ rootDir: root });
  const compressor = engine.layers.compressor;
  let totalIn = 0;
  let totalOut = 0;
  for (const entry of entries) {
    if (!entry.isPersona || !entry.prompt) continue;
    const before = entry.prompt;
    try {
      const after = await compressor.compress(before, { ratio: 0.6 });
      if (typeof after === 'string' && after.length > 0) {
        entry.prompt = after;
        totalIn += before.length;
        totalOut += after.length;
      }
    } catch (err) {
      console.warn(`compress-personas: skipping ${entry.name}: ${err.message}`);
    }
  }
  if (totalIn > 0) {
    const ratio = ((totalOut / totalIn) * 100).toFixed(0);
    console.log(`compress-personas: ${totalIn} → ${totalOut} chars (${ratio}%) across ${entries.filter((e) => e.isPersona).length} personas`);
  }
}

acquireLock();
try {
  if (projectDir) {
    syncClaude(entries, projectDir);
    const cmdCount = syncCommands(projectDir);
    if (DRY_RUN) {
      printDryRunDiff();
    } else {
      commitStaging();
      console.log(`Synced ${entries.length} agents + ${cmdCount} commands to ${path.join(projectDir, ".claude/")} (project mode).`);
    }
  } else {
    const personaCount = entries.filter((e) => e.isPersona).length;
    const agentCount = entries.filter((e) => !e.isPersona).length;

    syncCodex(entries);
    syncClaude(entries);
    syncCopilot(entries);
    const opencodeOk = syncOpencode(entries);
    const vscodeOk = syncVSCode();
    const cursorOk = syncCursor();
    const cmdCount = syncCommands();

    if (DRY_RUN) {
      printDryRunDiff();
    } else {
      commitStaging();

      const targets = [
        "Codex",
        "Claude Code",
        "Copilot",
        opencodeOk && "OpenCode",
        vscodeOk && "VS Code",
        cursorOk && "Cursor",
      ].filter(Boolean).join(", ");
      console.log(`Synced ${personaCount} personas + ${agentCount} specialists + ${cmdCount} commands to ${targets}.`);

      // Regenerate shell completions so new commands are immediately tab-completable
      const completionsDir = generateCompletions();
      if (completionsDir) {
        console.log(`Completions updated → ${completionsDir}`);
      }
    }
  }
} finally {
  releaseLock();
}
