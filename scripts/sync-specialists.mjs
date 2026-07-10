#!/usr/bin/env node
/**
 * sync-specialists.mjs — regenerate agent adapters for all platforms from specialists/org.
 *
 * Two scopes, modelled on every host's own convention (global = personal default,
 * project = team-shared):
 *
 *   Global / user scope (`~/.claude/`, `~/.codex/`, `~/.github/`, …)
 *     - Only the `construct` front-door agent (the registry's top-level
 *       `orchestrator` entry). Specialists, slash commands, and skills do NOT
 *       land at global scope — they are project content.
 *     - Plus the hook installer in `~/.claude/settings.json`, which has to be
 *       global so hooks fire in every Claude Code session. MCP server
 *       definitions are a separate file: Claude Code reads user-scope MCP
 *       servers from the top-level `mcpServers` object in `~/.claude.json`,
 *       not from settings.json (construct-ranh).
 *
 *   Project scope (`<project>/.claude/`, `<project>/.codex/`, `<project>/.github/`, …)
 *     - `construct` front door only (Single Front Door), slash commands, skills, MCP
 *       wiring. Specialists dispatch internally via orchestration MCP tools.
 *       MCP server definitions land in `<project>/.mcp.json` (Claude Code's
 *       documented project scope), not `.claude/settings.json`.
 *
 * Flags:
 *   --dry-run             Print a diff of what would change without writing anything.
 *   --force               Bypass prompt word-cap hard stop (still warns).
 *   --project             Write only the project tier (cwd's `.claude/`, `.codex/`, etc.).
 *   --global              Write only the global tier (orchestrator + hooks at `~/`).
 *   (no scope flag)       Write the global tier. If cwd is inside a Construct
 *                         project, also write the project tier.
 *   --compress-personas   Run the engine's Compressor on every persona prompt
 *                         before writing platform adapters. The source persona
 *                         file is unchanged; only the runtime adapter is shorter.
 *                         Lossy by definition — opt-in only.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
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
import { findOpenCodeConfigPath, readOpenCodeConfig, writeOpenCodeConfig, ensureOpenRouterProviderAuth } from "../lib/opencode-config.mjs";
import { HEAVY_EXTERNAL_MCP_IDS, LOCAL_SURFACE_MODES, decideTrim, isLocalModel } from "../lib/mcp/tool-budget.mjs";
import { emitCursorRules } from "../lib/rules-delivery.mjs";
import { memoryPort } from "../lib/home-namespace.mjs";
import { resolvePromptContract, readPromptBody } from "../lib/prompt-composer.js";
import { renderPersonaForTier } from "../lib/persona-sections.mjs";
import { getModelVerdict } from "../lib/ollama/capability-store.mjs";
import {
  buildClaudeMcpEntry,
  buildOpenCodeMcpEntry,
  getOpenCodeMcpId,
} from "../lib/mcp-platform-config.mjs";
import { loadConstructEnv } from "../lib/env-config.mjs";
import { configDir } from "../lib/config/xdg.mjs";
import { inlineRoleAntiPatterns, PROMPT_WORD_CAP } from "../lib/role-preload.mjs";
import { inlineValidationContract } from "../lib/prompt-validation-contract.mjs";
import { loadManifest } from "../lib/roles/manifest.mjs";
import { resolveActiveScope } from "../lib/scopes/loader.mjs";
import { resolveTiersForPrimary, resolveCapabilityTier, selectLocalEditorModel } from "../lib/model-router.mjs";
import { stampFrontmatter } from "../lib/doc-stamp.mjs";
import { buildSkillFrontmatter, stripLeadingFrontmatter } from "../lib/sync/skill-frontmatter.mjs";
import { loadRegistry, clearCache } from "../lib/registry/loader.mjs";
import { loadPluginRegistry } from "../lib/plugin-registry.mjs";

const home = os.homedir();
const root = path.resolve(import.meta.dirname, "..");
const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

const mergedEnv = loadConstructEnv({ rootDir: root, homeDir: home, env: process.env });
for (const [key, value] of Object.entries(mergedEnv)) {
  if (!(key in process.env)) process.env[key] = value;
}
if (!process.env.CX_TOOLKIT_DIR) process.env.CX_TOOLKIT_DIR = root;

function unifiedToLegacyRegistry(unified) {
  const orchestrator = Object.values(unified.specialists || {}).find(s => s.role === 'orchestrator') || {};
  const specialists = Object.values(unified.specialists || {}).filter(s => s.role !== 'orchestrator');
  return {
    version: 1,
    system: 'construct',
    prefix: 'cx',
    orchestrator: {
      name: 'construct',
      displayName: orchestrator.displayName || orchestrator.description?.split('—')[0].trim() || 'Construct',
      description: orchestrator.description || '',
      promptFile: orchestrator.promptFile || 'specialists/prompts/cx-orchestrator.md',
      modelTier: orchestrator.modelTier || 'standard',
      skills: orchestrator.skills || [],
      injectAgentRoster: orchestrator.injectAgentRoster ?? false,
    },
    specialists: specialists.map(s => ({
      name: s.name,
      displayName: s.displayName || s.description?.split('—')[0].trim() || s.name,
      description: s.description || '',
      promptFile: s.promptFile,
      modelTier: s.modelTier || 'standard',
      claudeTools: s.claudeTools || 'Read,Grep,Glob,LS',
      internal: s.internal,
      wordCapOverride: s.wordCapOverride,
      skills: s.skills || [],
      team: s.team,
      role: s.role,
      docArtifacts: s.docArtifacts || [],
      subscriptions: s.events || [],
      watchConditions: s.watchConditions || [],
      fence: s.fence || {},
    })),
    sharedGuidance: unified.sharedGuidance || [],
    models: unified.models || { reasoning: { primary: null }, standard: { primary: null }, fast: { primary: null } },
    providers: unified.providers || {},
    mcpServers: unified.mcpServers || {},
  };
}

clearCache();
const unified = loadRegistry({ rootDir: root });
const registry = unifiedToLegacyRegistry(unified);

function validateRegistry(registry) {
  const errors = [];
  if (!registry.version) errors.push("Missing 'version' field");
  if (!registry.system) errors.push("Missing 'system' field");
  if (!registry.prefix) errors.push("Missing 'prefix' field");
  if (!registry.orchestrator) errors.push("Missing 'orchestrator' field");
  if (!Array.isArray(registry.specialists)) errors.push("Missing or invalid 'specialists' array");
  const validTiers = new Set(["reasoning", "standard", "fast"]);
  const names = new Set();

  if (registry.orchestrator) {
    const o = registry.orchestrator;
    if (!o.name) errors.push("Orchestrator missing 'name'");
    if (names.has(o.name)) errors.push(`Duplicate name: ${o.name}`);
    names.add(o.name);
    if (!o.description) errors.push("Orchestrator: missing 'description'");
    if (!o.promptFile) errors.push("Orchestrator: missing 'promptFile'");
    if (!o.displayName) errors.push("Orchestrator: missing 'displayName'");
  }

  for (const specialist of registry.specialists ?? []) {
    if (!specialist.name) { errors.push("Specialist missing 'name'"); continue; }
    if (names.has(specialist.name)) errors.push(`Duplicate name: ${specialist.name}`);
    names.add(specialist.name);
    if (!specialist.prompt && !specialist.promptFile) errors.push(`${specialist.name}: missing 'prompt' or 'promptFile'`);
    if (!specialist.description) errors.push(`${specialist.name}: missing 'description'`);
    if (!specialist.model && !specialist.modelTier) errors.push(`${specialist.name}: needs 'model' or 'modelTier'`);
    if (specialist.modelTier && !validTiers.has(specialist.modelTier)) errors.push(`${specialist.name}: invalid modelTier '${specialist.modelTier}'`);
    if (!specialist.claudeTools) errors.push(`${specialist.name}: missing 'claudeTools'`);
    if (specialist.modelGuidance && typeof specialist.modelGuidance !== "object") {
      errors.push(`${specialist.name}: modelGuidance must be an object`);
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

{
  const { validatePromptFiles } = await import("../lib/specialists/prompt-schema.mjs");
  const promptResult = validatePromptFiles({ rootDir: root, registry });
  if (promptResult.errors.length > 0) {
    console.error("Specialist prompt validation failed:");
    for (const err of promptResult.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
}

// --- Dry-run + lockfile + two-phase write infrastructure ---

const DRY_RUN = process.argv.includes("--dry-run");
const COMPRESS_PERSONAS = process.argv.includes("--compress-personas");
const PROJECT_FLAG = process.argv.includes("--project");
const GLOBAL_FLAG = process.argv.includes("--global");

// --local-surface=on|off|auto controls whether the heavy external MCP servers are
// disabled to fit a small local-model window. `auto` (default) trims only when the
// config's own default model is local — so a cloud session keeps context7/github
// even on a machine that also has Ollama. `on` forces the trim (the lever for users
// who pick a local model at runtime, leaving the config default unset); `off` keeps
// every server. CONSTRUCT_LOCAL_SURFACE is the env equivalent.

const LOCAL_SURFACE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--local-surface="));
  const raw = (arg ? arg.slice("--local-surface=".length) : process.env.CONSTRUCT_LOCAL_SURFACE || "auto").trim().toLowerCase();
  return LOCAL_SURFACE_MODES.includes(raw) ? raw : "auto";
})();

// --quiet suppresses only the closing one-line summary, not the work or any
// warning. `construct install` runs the global tier twice (plain `sync` then
// `sync --global`); in a non-project cwd both land in the same global branch and
// print the identical "Synced … to global scope" + "Completions updated" lines.
// Passing --quiet to the first call lets the canonical summary print exactly once
// from `sync --global`, with no change to what either call writes.

const QUIET = process.argv.includes("--quiet") || process.argv.includes("-q");
const summary = (msg) => { if (!QUIET) console.log(msg); };

// Project-tier host selection. `--hosts=claude,codex,…` (or CONSTRUCT_SYNC_HOSTS)
// restricts which adapter sets the project tier writes, so `construct init` can
// scaffold only the hosts the user actually has (construct-4xy6 / ADR-0027 §1).
// Absent → null → write every host, preserving `construct sync` back-compat.

import { detectHostCapabilities } from "../lib/host-capabilities.mjs";
import {
  HOST_KEYS,
  displayNameToKey,
  hasNativeSubagents as hostHasNativeSubagents,
  globalHookAllowlist,
  globalMcpAllowlist,
} from "../lib/platforms/capabilities.mjs";

function parseHostSelection() {
  const arg = process.argv.find((a) => a.startsWith("--hosts="));
  const raw = arg ? arg.slice("--hosts=".length) : process.env.CONSTRUCT_SYNC_HOSTS;
  if (!raw) {
    // Default to detected hosts if none are explicitly requested.
    const detected = new Set();
    const nameToKey = displayNameToKey();
    try {
      for (const cap of detectHostCapabilities()) {
        if (cap.availability === "installed" && nameToKey[cap.host]) {
          detected.add(nameToKey[cap.host]);
        }
      }
    } catch { /* detection is advisory */ }

    // Config file present means the user has (or had) OpenCode — include it
    // so the sync writes to the existing config rather than pruning it.
    // Binary-based detection misses non-PATH installs and CI-runner setups.
    if (!detected.has("opencode")) {
      try {
        if (fs.existsSync(findOpenCodeConfigPath())) detected.add("opencode");
      } catch { /* advisory */ }
    }

    // Always include Claude as the baseline if nothing else is detected.
    if (detected.size === 0) detected.add("claude");
    return detected;
  }
  const wanted = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return new Set(HOST_KEYS.filter((k) => wanted.has(k)));
}

const HOST_SELECTION = parseHostSelection();
const wantsHost = (key) => HOST_SELECTION.has(key);

/**
 * A Construct project carries `.construct/` (the launcher staged by
 * `stage-project.mjs`) or `.cx/` (state). When `construct sync` runs inside
 * one without an explicit scope flag, default to project mode so specialists
 * land with the repo rather than leaking into the user's home directory.
 * `--global` overrides this for the front-door refresh path.
 */
function detectConstructProject(cwd) {
  if (fs.existsSync(path.join(cwd, ".construct")) || fs.existsSync(path.join(cwd, ".cx"))) {
    return cwd;
  }
  return null;
}

const detectedProject = (!PROJECT_FLAG && !GLOBAL_FLAG) ? detectConstructProject(process.cwd()) : null;
const projectDir = PROJECT_FLAG ? process.cwd() : detectedProject;

// Lock and staging are scoped to the tier we actually mutate: a project dir for
// project-tier writes, the user's HOME for global-tier writes (which land in
// ~/.claude, ~/.codex, …). Keying the global tier to HOME — not the repo root —
// means two --global syncs against different HOMEs (e.g. parallel test files in
// isolated sandboxes) never collide on a shared repo-root lock, and staging
// renames stay on the same filesystem as their destinations.

const stateBase = projectDir || home;
const lockPath = path.join(stateBase, ".cx", "sync.lock");
const stagingDir = path.join(stateBase, ".cx", "sync-staging");

// Project-tier writes carry every registry entry. Global-tier writes carry only
// the `construct` front-door agent — specialists live with the project, not the
// user's home directory, per each host's documented best-practice scope.

function globalEntries(allEntries) {
  return allEntries.filter((e) => e.isOrchestrator);
}

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

function writeFile(file, content, { stamp = true } = {}) {
  mkdirp(path.dirname(file));
  // Doc-stamp wraps content with cx_doc_id + body_hash YAML frontmatter for
  // tamper detection. That's right for content artifacts (research findings,
  // knowledge files), wrong for host-platform adapter files that have their
  // own frontmatter contract (Claude Code agents, Copilot prompts, Anthropic
  // Agent Skills) or are user-managed (CLAUDE.md, copilot-instructions.md).
  // Stamping those produces double-frontmatter that breaks the host loader.
  // Callers writing those files pass { stamp: false }.

  const shouldStamp = stamp && file.endsWith('.md');
  const stamped = shouldStamp ? stampFrontmatter(content, { generator: 'construct/sync-specialists' }) : content;

  if (DRY_RUN) {
    // Stage in memory only — compare against current on-disk content.
    let current = "";
    try { current = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
    if (current !== stamped) _stagedPairs.push({ real: file, staging: null, content: stamped, current });
    return;
  }

  // Two-phase: write to staging, commit later.
  const rel = path.relative(stateBase, file);
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

const generatedHeader = `# Generated by ${systemName}/sync-specialists.mjs. Edit specialists/org instead.`;
const generatedMarkdownNote = [
  '<!--',
  `Generated by construct sync from specialists/org.`,
  'Do not edit this file directly — changes will be overwritten on next sync.',
  'Regenerate: construct sync',
  '-->',
  '',
  '> Generated from `specialists/org`. Edit the registry, then run `construct sync`.',
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

// The orchestrator's atomic contract is classify-then-dispatch: orchestration_policy
// then orchestration_run. On allowlist hosts (Claude) these must be named in the
// agent's tools list or the call is blocked, leaving the orchestrator unable to route.
// Single source of truth so every host's orchestrator grant stays in parity.

const ORCHESTRATOR_DISPATCH_TOOLS = ["orchestration_policy", "orchestration_run", "orchestration_delegation_next"];
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

// A secret-suffixed placeholder (TOKEN/SECRET/API_KEY/PUBLIC_KEY/PRIVATE_KEY) always
// resolves to OpenCode's `{env:NAME}` reference form, even when the named var is set
// in process.env, so a live credential never lands in a generated config file. This
// guard runs before the general env lookup below, mirroring the buildLocalEnvironment
// value->ref flip in lib/mcp-platform-config.mjs. GITHUB_TOKEN is an intentional alias
// that still materializes GITHUB_PERSONAL_ACCESS_TOKEN's value: that branch stays ahead
// of the suffix guard since it targets a different source var, not GITHUB_TOKEN itself.

export function resolveTemplateStrings(value) {
  if (typeof value === "string") {
    return value.replace(/__([A-Z0-9_]+)__/g, (_, name) => {
      if (name === "CX_TOOLKIT_DIR") return root;
      if (name === "MEMORY_PORT") return process.env.MEMORY_PORT || "8765";
      if (name === "CONSTRUCT_MEMORY_BRIDGE_URL") {
        return process.env.CONSTRUCT_MEMORY_BRIDGE_URL || "http://127.0.0.1:8765/";
      }
      if (name === "GITHUB_TOKEN" && process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
        return process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      }
      if (/(?:TOKEN|SECRET|API_KEY|PUBLIC_KEY|PRIVATE_KEY)$/.test(name)) {
        return `{env:${name}}`;
      }
      if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name];
      return `__${name}__`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplateStrings(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplateStrings(item)]));
  }
  return value;
}

function constructMcpDefinition() {
  return {
    id: "construct-mcp",
    name: "Construct MCP",
    category: "core",
    description: "Construct stdio MCP server for orchestration, skills, templates, and project context.",
    command: "node",
    args: ["__CX_TOOLKIT_DIR__/lib/mcp/server.mjs"],
    env: {
      CONSTRUCT_TRACE_BACKEND: "__CONSTRUCT_TRACE_BACKEND__",
      CONSTRUCT_TELEMETRY_URL: "__CONSTRUCT_TELEMETRY_URL__",
      CONSTRUCT_TELEMETRY_PUBLIC_KEY: "__CONSTRUCT_TELEMETRY_PUBLIC_KEY__",
      CONSTRUCT_TELEMETRY_SECRET_KEY: "__CONSTRUCT_TELEMETRY_SECRET_KEY__",
    },
    requiredEnv: [],
    setupModes: ["auto"],
    hostSupport: {
      claude: { mode: "managed" },
      opencode: { mode: "managed" },
      codex: { mode: "managed" },
    },
    usedBy: ["construct"],
  };
}

function managedMcpDefs() {
  const pluginRegistry = loadPluginRegistry({ cwd: root, homeDir: home, rootDir: root, env: process.env });
  const defs = Object.fromEntries(
    (pluginRegistry.mcps ?? []).map((mcp) => [mcp.id, {
      type: mcp.type,
      url: mcp.url,
      command: mcp.command,
      args: mcp.args,
      env: mcp.env,
      headers: mcp.headers,
      hostSupport: mcp.hostSupport,
      category: mcp.category,
    }]),
  );
  defs["construct-mcp"] = constructMcpDefinition();
  return { ...defs, ...(registry.mcpServers ?? {}) };
}

function scopedManagedMcpDefs({ projectScope = false } = {}) {
  const defs = managedMcpDefs();
  if (!projectScope) return defs;
  return Object.fromEntries(
    Object.entries(defs).filter(([id]) => PROJECT_DEFAULT_MCP_IDS.has(id)),
  );
}

function mergeMissingObjectDefaults(current, defaults) {
  if (Array.isArray(defaults)) {
    return current === undefined ? [...defaults] : current;
  }
  if (!defaults || typeof defaults !== "object") {
    return current === undefined ? defaults : current;
  }
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(defaults)) {
    next[key] = mergeMissingObjectDefaults(next[key], value);
  }
  return next;
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
    const cfg = readOpenCodeConfig().config ?? {};
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
  return entry.isOrchestrator ? entry.name : `${agentPrefix}${entry.name}`;
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
  if (entry.isOrchestrator !== true && entry.canEdit === false) {
    lines.push("Do not implement code or edit source files.");
  }
  if (entry.returnsStructured !== false) {
    lines.push("Return exactly one terminal state per task: DONE (with evidence) | BLOCKED (with concrete blocker) | NEEDS_MAIN_INPUT (with question + safe default).");
  }
  if (lines.length === 0) return "";
  return `\n\n${lines.join("\n")}`;
}

// Fence + handoff data is the source of truth in specialists/org
// (events, fence.allowedPaths, fence.allowedBdLabels, fence.approvalRequired,
// handoffCandidates, outputs.docTypes). Restating that JSON inside each
// specialist prompt would invite drift across 28 files; the renderer below
// emits the section from the manifest entry so the JSON is the only authority.
//
// Returns the empty string for an unonboarded persona (no manifest entry, or
// an empty fence block). buildPrompt appends the result verbatim, so the
// returned string carries its own leading separator.

export function renderRoleFrameworkSection(entry) {
  const personaName = String(entry?.name || "").replace(/^cx-/, "");
  if (!personaName) return "";
  const manifest = loadManifest(personaName);
  if (!manifest) return "";

  const events = Array.isArray(manifest.events) ? manifest.events : [];
  const fence = manifest.fence || {};
  const allowedPaths = Array.isArray(fence.allowedPaths) ? fence.allowedPaths : [];
  const allowedBdLabels = Array.isArray(fence.allowedBdLabels) ? fence.allowedBdLabels : [];
  const approvalRequired = Array.isArray(fence.approvalRequired) ? fence.approvalRequired : [];
  const handoffCandidates = Array.isArray(manifest.handoffCandidates) ? manifest.handoffCandidates : [];
  const docTypes = Array.isArray(manifest.outputs?.docTypes) ? manifest.outputs.docTypes : [];

  // Empty fence + empty events means the persona is reserved but not wired —
  // no section to render rather than emit a misleading stub.

  if (!events.length && !allowedPaths.length) return "";

  const fmt = (xs) => xs.map((x) => `\`${x}\``).join(", ");
  const eventList = events.length ? fmt(events) : "_handoff events_";
  const pathList = allowedPaths.length ? fmt(allowedPaths) : "_none declared_";
  const labelList = allowedBdLabels.length ? fmt(allowedBdLabels) : "_none declared_";
  const approvalList = approvalRequired.length ? fmt(approvalRequired) : "_no approval gate declared_";
  const docTypeList = docTypes.length ? fmt(docTypes) : "role-specific artifacts";
  const handoffList = handoffCandidates.length
    ? handoffCandidates.map((c) => `\`next:cx-${c}\``).join(", ")
    : "";

  const lines = [
    "",
    "## When invoked via the role framework",
    "",
    `Construct may dispatch you in response to ${eventList} events. A bd issue with the event payload exists when dispatched: read it first via \`bd show <id>\`.`,
    "",
    `**Fence** (source of truth: \`specialists/org\` → \`${personaName}\`):`,
    `- Allowed paths: ${pathList}`,
    `- Allowed bd labels: ${labelList}`,
    `- Approval required: ${approvalList}`,
    "",
    `You may freely create, edit, and verify within the fence (allowed paths and labels above). You produce ${docTypeList}. You **must not** commit, push, or operate outside the fence without explicit user approval per \`rules/common/commit-approval.md\`.`,
  ];
  if (handoffList) {
    lines.push("", `**Handoff syntax**: append a bd label of the form \`next:cx-<role>\`. Candidates from this role: ${handoffList}.`);
  }
  return `\n\n${lines.join("\n")}`;
}

// The native-subagent orchestration micro-prompt. A worked tool-call example lifts
// small local models' tool-use reliability sharply (bead construct-c16l). Shared by the
// full path and the capability-tiered local path so both stay in sync.

function orchestrationToolName(platform, toolName) {
  if (platform === "opencode") return `construct-mcp_${toolName}`;
  return toolName;
}

function orchestrationMicroPrompt(platform) {
  const policyTool = orchestrationToolName(platform, "orchestration_policy");
  const runTool = orchestrationToolName(platform, "orchestration_run");
  return (
    `You are the primary orchestrator. Before any non-trivial answer, call \`${policyTool}\` with the user's \`request\`. Do not guess agent names or workflow types.\n\n` +
    `Example — the user says "add rate limiting to the API". Your first action is a tool call, not prose:\n` +
    `  call ${policyTool} { "request": "add rate limiting to the API" }\n` +
    `If the route is focused/orchestrated specialist work, call \`${runTool}\` with the same request. If the route suggests a workflow such as \`research-synthesis\`, pass it as \`workflow_type\`. Do not narrate completed research unless \`${runTool}\` or evidence tools actually ran.\n\n` +
    `If a request needs a capability you lack — live web/network access, external data, code execution — route it via \`${runTool}\` to the specialist that holds it (the researcher performs live web retrieval when a web path is available). Do not tell the user to run it themselves. But if \`${runTool}\` reports the capability was unavailable (degraded with \`capability-unavailable\`, or a prepare-only result), say plainly it could not be reached and return an insufficient-evidence result — never fabricate URLs, dates, quotes, or citations. Ask one clarifying question when the target is ambiguous.`
  );
}

// Directive for the local editor agent (construct-local). It executes bounded work on
// the cheap local model and hands planning/reasoning back to the construct architect —
// a cheap-editor/capable-architect split. Kept short: a small model must actually obey it.

const LOCAL_EDITOR_DIRECTIVE =
  `You are a focused execution agent running on a local model, dispatched by construct to do one bounded job. Do well-scoped edits for the current task and verify them; make the smallest correct change, never a broad rewrite.\n` +
  `You do NOT plan, classify, orchestrate, or spawn other agents. For anything needing multi-file design, architecture or security judgment, dependency or contract changes, or research, STOP and return control to construct — report what needs deeper work and why, rather than attempting it yourself.`;

// Warn-and-emit capability advisory. Sizing already consumes the probe verdict
// (COLLAPSED → floor tier via resolveCapabilityTier); this only nudges the user toward a
// measured verdict and never suppresses emission. Notice-only, so it auto-suppresses in
// CI / test / non-TTY per the repo's wrong-context rule — no skip env var.

const localAdvisorySeen = new Set();
function adviseLocalModelCapability(model) {
  if (!model || !isLocalModel(model)) return;
  if (process.env.CI === "true" || process.env.NODE_ENV === "test" || !process.stderr.isTTY) return;
  if (localAdvisorySeen.has(model)) return;
  localAdvisorySeen.add(model);
  const verdict = getModelVerdict(model)?.verdict ?? null;
  if (verdict === "COLLAPSED") {
    console.warn(`[sync] ${model} probed COLLAPSED — emitting at the floor tier with escalation to construct. Re-probe after a Modelfile change: construct doctor --probe-local`);
  } else if (!verdict) {
    console.warn(`[sync] ${model} is local with no coherence verdict — tier inferred from parameter count. For a measured tier: construct doctor --probe-local`);
  }
}

function enforcePromptWordCap(prompt, entry) {
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
        `   - set "wordCapOverride": <N> on this entry in specialists/org with a written reason\n` +
        `   - re-run with --force or CONSTRUCT_SYNC_FORCE=1 as a temporary escape hatch\n` +
        `Prompt budget is a hard contract because every over-cap agent degrades every session that dispatches it.`,
      );
      process.exit(1);
    }
  }
  return prompt;
}

function buildPrompt(entry, allEntries, platform, { capabilityTier = 'full' } = {}) {
  const capabilities = { hasNativeSubagents: HOST_KEYS.includes(platform) ? hostHasNativeSubagents(platform) : false };

  // Capability-tiered local path. A small local model follows a long multi-instruction
  // persona poorly (instruction-following degrades before the window fills), so emit
  // only the persona sections at/below its tier plus the orchestration micro-prompt, and
  // skip the role footer, role-framework, operating-guidance, and model-family blocks —
  // those add instruction load the model cannot track. Cloud models resolve to 'full'
  // and take the unchanged path below, so cloud configs are never slimmed.

  if (capabilityTier && capabilityTier !== 'full' && entry.promptFile) {
    let slim = renderPersonaForTier(readPromptBody(entry.promptFile, root), capabilityTier);
    if (entry.injectAgentRoster) {
      slim = `${orchestrationMicroPrompt(platform)}\n\n${slim}`;
    }
    return enforcePromptWordCap(slim, entry);
  }

  let prompt = resolvePromptContract(entry, {
    rootDir: root,
    registry,
    fallback: entry.prompt || '',
  }).prompt;

  prompt = inlineRoleAntiPatterns(prompt, root, entry.name, console.warn, { preload: entry.preloadRoleGuidance === true });
  prompt = inlineValidationContract(prompt, root, entry.name);

  // Platform-Native Orchestration Alignment (ADR-0002). All hosts receive the
  // tool-bound micro-prompt when injectAgentRoster is set; the static 29-line
  // roster was removed (construct-ymp5). Specialists resolve at runtime via
  // orchestration_policy, which returns a lazy specialistCatalog.

  // Single Front Door: all hosts resolve specialists at runtime via
  // orchestration_policy / orchestration_run — never inject the static roster.

  if (entry.injectAgentRoster) {
    prompt = `${orchestrationMicroPrompt(platform)}\n\n${prompt}`;
  }

  prompt += buildRoleFooter(entry);

  prompt += renderRoleFrameworkSection(entry);

  const platformItems = platformGuidance[platform] ?? [];
  const allGuidance = [...sharedGuidance, ...platformItems];
  if (allGuidance.length > 0) {
    const guidance = allGuidance.map((item) => `- ${item}`).join("\n");
    prompt = `${prompt}\n\nOperating guidance:\n${guidance}`;
  }

  prompt += buildModelGuidanceBlock(entry);

  return enforcePromptWordCap(prompt, entry);
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

/**
 * Sweep registry-managed `${prefix}-<specialist>${ext}` files in a global-scope
 * adapter directory. Global scope only ever emits the `construct` front-door
 * agent, so any file whose name matches a registered specialist is out of
 * contract for global scope and gets removed. User-authored files that happen
 * to share the `${prefix}-` prefix but a name outside the registry (e.g. a
 * personal `cx-mytool.md`) are preserved. Idempotent: a second call finds
 * nothing to delete. Anything in `expectedNames` is preserved so an in-mode
 * write isn't undone.
 */
function sweepLegacyPrefixedFiles(dir, ext, expectedNames) {
  if (!fs.existsSync(dir)) return;
  const keep = new Set(expectedNames);
  const managed = new Set((registry.specialists ?? []).map((s) => `${agentPrefix}${s.name}${ext}`));
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(ext)) continue;
    if (!managed.has(file)) continue;
    if (keep.has(file)) continue;
    try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
  }
}

// --- Unified entry list: personas + agents ---

function buildEntries() {
  const entries = [];

  // Orchestrator entry
  if (registry.orchestrator) {
    const orchestratorCanEdit = registry.orchestrator.permissions?.edit === "allow";
    entries.push({
      ...registry.orchestrator,
      isOrchestrator: true,
      prompt: loadPersonaPrompt(registry.orchestrator),
      codexSandbox: registry.orchestrator.codexSandbox ?? (orchestratorCanEdit ? "workspace-write" : "read-only"),
      reasoningEffort: registry.orchestrator.reasoningEffort ?? "high",
    });
  }

  // Filter specialists by the active profile's role set. RND lists every specialist
  // so behavior is unchanged for the default; non-RND profiles emit only the
  // specialists they declare. Profiles whose role list is empty (legacy/test)
  // fall through to no filter so callers don't get a silent empty registry.
  const activeProfile = resolveActiveScope(process.cwd());
  const profileRoles = Array.isArray(activeProfile?.roles) && activeProfile.roles.length > 0
    ? new Set(activeProfile.roles)
    : null;

  for (const specialist of registry.specialists ?? []) {
    if (profileRoles && !profileRoles.has(specialist.name)) continue;
    entries.push({
      ...specialist,
      isSpecialist: true,
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

  // Claude's tools list is a hard allowlist; the orchestrator can only route if its
  // dispatch tools are named here.

  if (entry.isOrchestrator) {
    for (const tool of ORCHESTRATOR_DISPATCH_TOOLS) toolSet.add(tool);
  }
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
 *   node "$HOME/.config/construct/lib/hooks/<name>.mjs"
 * into the project-portable form
 *   node "${CLAUDE_PROJECT_DIR:-<absRoot>}/.construct/run.mjs" hook <name>
 * so the resulting settings.json works on any clone where the project ships
 * the .construct/ launcher (committed by `npm install`'s postinstall or by
 * `construct init`). The launcher resolves Construct via node_modules → npx
 * → globally-installed CLI → cached binary → docker, in that order, so it
 * works for non-Node ecosystems too. Other commands (inline node -e
 * snippets, npx block-no-verify@…) are left untouched.
 *
 * The `${CLAUDE_PROJECT_DIR:-<absRoot>}` anchor matters: hosts invoke hooks with
 * a working directory that is not guaranteed to be the project root (observed:
 * $HOME, a `cd`-ed scratch dir), and a bare relative `.construct/run.mjs` then
 * fails with MODULE_NOT_FOUND at node:internal/modules/cjs/loader — before any
 * code in run.mjs can execute, so the shim cannot self-correct. CLAUDE_PROJECT_DIR
 * is the project root Claude Code exports to every hook (same var lib/hooks/*.mjs
 * already read) and stays correct if the checkout moves; the fallback is the
 * absolute project root baked at sync time, so tools that do not export
 * CLAUDE_PROJECT_DIR (or any host with a drifted cwd) still resolve the launcher.
 * `.claude/settings.json` is gitignored and regenerated per machine by
 * `construct sync`, so an absolute fallback is machine-correct without leaking a
 * shared path. The prior `:-.` fallback was cwd-relative and broke on any drift.
 */
function makeHooksPortable(hooksJson, projectRoot) {
  const anchor = `\${CLAUDE_PROJECT_DIR:-${path.resolve(projectRoot)}}`;

  // Operate on the in-memory object so we don't fight JSON string escaping.
  const replaceCommand = (cmd) => {
    if (typeof cmd !== 'string') return cmd;
    const m = cmd.match(/^node\s+"?\$HOME\/\.config\/construct\/lib\/hooks\/([a-z0-9-]+)\.mjs"?\s*(.*)$/);
    if (!m) return cmd;
    const [, name, rest] = m;
    return `node "${anchor}/.construct/run.mjs" hook ${name}${rest ? ' ' + rest.trim() : ''}`;
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

const GLOBAL_CLAUDE_HOOK_IDS = globalHookAllowlist('claude');

const GLOBAL_CLAUDE_MCP_IDS = globalMcpAllowlist('claude');

// Project scope writes only core-category MCP servers (plus construct-mcp, the
// orchestration server the specialist loop needs). optional/integration servers
// (memory, github, sequential-thinking, playwright, …) are opt-in via
// `construct mcp add` so a project does not silently inherit heavy servers it was
// never asked for (ADR-0031 §Consequences follow-up). A server already present in
// the project settings is preserved, so a manual opt-in sticks.

const PROJECT_DEFAULT_MCP_IDS = (() => {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, "lib", "mcp-catalog.json"), "utf8"));
    const arr = catalog.mcps || catalog.servers || [];
    return new Set([...arr.filter((m) => m.category === "core").map((m) => m.id), "construct-mcp"]);
  } catch {
    return new Set(["context7", "construct-mcp"]);
  }
})();

function filterGlobalClaudeHooks(hooksJson) {
  const filtered = {};
  for (const [event, groups] of Object.entries(hooksJson ?? {})) {
    const kept = groups.filter((group) => GLOBAL_CLAUDE_HOOK_IDS.has(group.id));
    if (kept.length > 0) filtered[event] = kept;
  }
  return filtered;
}

function syncGlobalClaudeMcpServers(settings, registryMcp) {
  settings.mcpServers ??= {};
  for (const [id, mcpDef] of Object.entries(registryMcp)) {
    if (!GLOBAL_CLAUDE_MCP_IDS.has(id)) continue;
    const existingEntry = settings.mcpServers[id];
    const desiredEntry = buildClaudeMcpEntry(id, mcpDef, process.env);
    if (!needsRefresh(existingEntry, desiredEntry, { root })) continue;
    settings.mcpServers[id] = desiredEntry;
  }
}

/**
 * Materialise a project-local `.claude/settings.json` from the home template,
 * with hook commands rewritten to be path-relative to whatever Construct
 * install the project carries. Merges into an existing settings.json
 * if one is already in the project; otherwise creates a fresh one.
 *
 * Carries hooks and permissions only — Claude Code does not read MCP server
 * definitions from settings.json at any scope (confirmed against
 * code.claude.com/docs/en/mcp's installation-scopes table and live `claude
 * mcp list` repro, construct-ranh). Project-scope MCP wiring is
 * writeProjectMcpJson's job, targeting `.mcp.json`.
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
    existing.hooks = JSON.parse(makeHooksPortable(template.hooks, targetDir));
  }
  if (template.permissions) {
    existing.permissions ??= template.permissions;
  }

  if (DRY_RUN) return;
  mkdirp(path.dirname(settingsPath));
  writeFile(settingsPath, JSON.stringify(existing, null, 2) + "\n");
}

/**
 * Materialise project-scope MCP wiring at `.mcp.json` in the project root —
 * the scope Claude Code documents for team-shared, version-controlled MCP
 * server definitions (settings.json only carries policy keys and hooks).
 * Merges into an existing `.mcp.json` if the project already has one;
 * existing entries win so manual edits or a prior `claude mcp add --scope
 * project` stick.
 */
function writeProjectMcpJson(targetDir) {
  const mcpJsonPath = path.join(targetDir, ".mcp.json");
  const templatePath = path.join(root, "platforms", "claude", "settings.template.json");

  const existing = fs.existsSync(mcpJsonPath)
    ? JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"))
    : {};
  existing.mcpServers ??= {};

  if (fs.existsSync(templatePath)) {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    if (template.mcpServers) {
      for (const [id, mcpDef] of Object.entries(template.mcpServers)) {
        if (existing.mcpServers[id]) continue;
        if (!PROJECT_DEFAULT_MCP_IDS.has(id)) continue;
        existing.mcpServers[id] = mcpDef;
      }
    }
  }

  // The registry is the single source of truth for MCP servers; VS Code, Codex,
  // and OpenCode all wire it. Project Claude must match — above all `construct-mcp`,
  // the server exposing project_context/get_skill/get_template/orchestration_policy
  // that the specialist loop depends on. The curated template omits it, which left
  // Claude Code as the only selected tool without the construct config. Merge the
  // registry on top of the template seed via needsRefresh(): an existing entry
  // wins as long as it still matches the registry (env keys, pinned version,
  // transport, toolkit path), so a manual opt-in sticks but drift — a missing
  // registry env key, a stale pinned version — gets corrected.
  const registryMcp = scopedManagedMcpDefs({ projectScope: true });
  for (const [id, mcpDef] of Object.entries(registryMcp)) {
    if (!PROJECT_DEFAULT_MCP_IDS.has(id)) continue;
    const existingEntry = existing.mcpServers[id];
    const desiredEntry = buildClaudeMcpEntry(id, mcpDef, process.env);
    if (!needsRefresh(existingEntry, desiredEntry, { root })) continue;
    existing.mcpServers[id] = desiredEntry;
  }
  reconcileStaleManagedEntries(existing.mcpServers, { registryMcp, rebuildEntry: (id, def) => buildClaudeMcpEntry(id, def, process.env) });

  if (DRY_RUN) return;
  mkdirp(path.dirname(mcpJsonPath));
  writeFile(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n");
}

function syncClaude(entries, targetDir = null, wants = true) {
  const claudeAgentsDir = targetDir
    ? path.join(targetDir, ".claude", "agents")
    : path.join(home, ".claude", "agents");
  if (!DRY_RUN && wants) mkdirp(claudeAgentsDir);

  // Claude Code and VS Code both read the user-scope `~/.claude/agents/`, so a
  // global front-door agent duplicates the project orchestrator in any editor
  // that reads both scopes (the construct ×2 in the VS Code picker). Global
  // scope therefore writes NO agent file — the project's own
  // `.claude/agents/construct.md` is the front door; global hooks (settings.json)
  // and CLAUDE.md still install. An empty write set sweeps any global agent.
  // Both global and project scope now emit only the front door (Single Front Door).

  const writeEntries = (targetDir && wants) ? globalEntries(entries) : [];

  for (const entry of writeEntries) {
    const name = adapterName(entry);
    const md = claudeAgentMarkdown(entry, entries);
    writeFile(path.join(claudeAgentsDir, `${name}.md`), md, { stamp: false });
  }
  removeStaleAdapters(claudeAgentsDir, ".md", writeEntries);
  if (!targetDir) {
    sweepLegacyPrefixedFiles(claudeAgentsDir, ".md", []);
  }

  if (targetDir) {
    writeProjectClaudeSettings(targetDir);
    writeProjectMcpJson(targetDir);
    return;
  }

  if (!targetDir) {
    const claudeMdPath = path.join(home, ".claude", "CLAUDE.md");
    const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "# Claude Global Instructions\n";
    const personaList = entries.filter((e) => e.isOrchestrator).map((e) => `- \`${adapterName(e)}\`: ${e.role} — ${e.description}`).join("\n");
    const note = `## ${systemName.charAt(0).toUpperCase() + systemName.slice(1)} Personas

${personaList}

## Internal Specialists

(all specialists are internal — routed through Construct, available inside a Construct-initialized project)`;
    // User-managed file with our managed-block carved out — never doc-stamp.
    writeFile(claudeMdPath, replaceManagedBlock(existing, note, mdManagedStart, mdManagedEnd), { stamp: false });

    // Sync hooks into ~/.claude/settings.json if it exists
    const claudeSettingsPath = path.join(home, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
      const templatePath = path.join(root, "platforms", "claude", "settings.template.json");
      if (fs.existsSync(templatePath)) {
        const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
        if (template.hooks) {
          // Resolve the $HOME/.config/construct token to the real config dir so
          // hook commands survive symlink traversal inside Claude Code's hook
          // runner environment, and honor a custom XDG_CONFIG_HOME at sync time.
          const configReal = (() => {
            const dir = configDir(home);
            try { return fs.realpathSync(dir); } catch { return dir; }
          })();
          const hookStr = JSON.stringify(filterGlobalClaudeHooks(template.hooks))
            .replace(/\$HOME\/\.config\/construct/g, configReal.replace(/\\/g, "/"));
          settings.hooks = JSON.parse(hookStr);
        }
      }
      if (!DRY_RUN) fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n");
    }

    // Sync user-scope MCP servers into ~/.claude.json's top-level `mcpServers`
    // — Claude Code does not read MCP server definitions from settings.json at
    // any scope (confirmed against code.claude.com/docs/en/mcp and live `claude
    // mcp list` repro, construct-ranh). Gated on the file already existing, same
    // as the hooks sync above: only write into Claude Code's own state file for
    // a user who has actually run the CLI at least once.
    const claudeUserConfigPath = path.join(home, ".claude.json");
    if (fs.existsSync(claudeUserConfigPath)) {
      const claudeUserConfig = JSON.parse(fs.readFileSync(claudeUserConfigPath, "utf8"));
      const registryMcp = scopedManagedMcpDefs({ projectScope: false });
      syncGlobalClaudeMcpServers(claudeUserConfig, registryMcp);
      if (!DRY_RUN) fs.writeFileSync(claudeUserConfigPath, JSON.stringify(claudeUserConfig, null, 2) + "\n");
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

// Codex aborts at startup when an MCP server's bearer_token_env_var names an env
// var that is unset ("Environment variable GITHUB_TOKEN for MCP server github is
// not set"). Unlike OpenCode — which keeps the `{env:VAR}` ref and resolves it at
// runtime — Codex must have the credential at sync time, so an entry whose token
// env var is unresolved is omitted from the Codex config (construct-n6h7).
// Entries with no credential requirement always pass.

function codexMcpEnvResolves(id, def, env = process.env) {
  const entry = buildCodexMcpEntry(id, def, env);
  const tokenVar = entry?.bearer_token_env_var;
  if (!tokenVar) return true;
  const val = env[tokenVar];
  return val !== undefined && val !== "";
}

function syncCodex(entries, targetDir = null, wants = true) {
  const codexDir = targetDir
    ? path.join(targetDir, ".codex")
    : path.join(home, ".codex");
  const codexAgentsDir = path.join(codexDir, "agents");
  if (!DRY_RUN && wants) mkdirp(codexAgentsDir);

  const writeEntries = wants ? globalEntries(entries) : [];

  for (const entry of writeEntries) {
    writeFile(path.join(codexAgentsDir, `${adapterName(entry)}.toml`), codexAgentToml(entry, entries));
  }
  removeStaleAdapters(codexAgentsDir, ".toml", writeEntries);
  if (!targetDir) {
    sweepLegacyPrefixedFiles(codexAgentsDir, ".toml", writeEntries.map((e) => `${adapterName(e)}.toml`));
  }

  const configPath = targetDir
    ? path.join(codexDir, "config.toml")
    : getCodexConfigPath(home);
  const existing = removeDanglingConstructMcpMarkers(removeDanglingConstructMcpTimeouts(readCodexConfig(configPath)));
  const entryNames = writeEntries.map(adapterName);
  const registryMcp = scopedManagedMcpDefs({ projectScope: Boolean(targetDir) });
  // Seed every supported MCP server (parity with Claude/OpenCode/VS Code/Cursor),
  // not just tables already present — otherwise Codex never receives `construct-mcp`
  // and the orchestration tool is unreachable there. existingMcpIds still drives
  // cleanup of any pre-existing standalone tables so the managed block stays canonical.
  const mcpIds = Object.keys(registryMcp).filter((id) => isCodexMcpSupported() && codexMcpEnvResolves(id, registryMcp[id], process.env));
  const existingMcpIds = Object.keys(registryMcp).filter((id) => hasCodexMcpTable(existing, id));
  const withoutManagedTables = removeDanglingConstructMcpMarkers(removeTomlTables(
    removeCodexAgentTables(existing, entryNames),
    existingMcpIds.flatMap((id) => [`mcp_servers.${id}`, `mcp_servers.${tomlString(id)}`]),
  ));
  const hasAgentsRoot = /^\[agents\]\s*$/m.test(withoutManagedTables);
  const rootBlock = hasAgentsRoot ? "" : "[agents]\nmax_threads = 6\nmax_depth = 1\n\n";

  // Workspace-write agents (the orchestrator + canEdit specialists) need network
  // access for WebFetch/context7 — Codex's workspace-write sandbox blocks the
  // network unless this is set. Skip when the user already manages the table so
  // their own sandbox settings (e.g. writable_roots) are not clobbered.

  const hasSandboxConfig = /^\[sandbox_workspace_write\]/m.test(withoutManagedTables);
  const sandboxBlock = hasSandboxConfig ? "" : "[sandbox_workspace_write]\nnetwork_access = true\n\n";

  // In project scope every entry is reachable from the user (Construct dispatches
  // internal specialists itself, but project teammates may want to address them).
  // In global scope only the `construct` front-door agent is registered.

  const exposed = targetDir ? writeEntries : writeEntries.filter((e) => !e.internal);
  const blocks = exposed.map((e) => `[agents.${adapterName(e)}]
description = ${tomlString(e.description)}
config_file = ${tomlString(`agents/${adapterName(e)}.toml`)}
`).join("\n");

  const mcpBlock = mcpIds
    .map((id) => serializeCodexMcpTable(id, buildCodexMcpEntry(id, registryMcp[id], process.env)))
    .join("\n\n");
  const withAgents = replaceManagedBlock(withoutManagedTables, `${sandboxBlock}${rootBlock}${blocks}`);
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

// VS Code reads custom agents (the renamed successor to chat modes) from
// .github/agents/<name>.agent.md, and tool grants must use its namespaced ids:
// <server>/* for an MCP server's tools, web/fetch for outbound web, search/read
// for repo awareness. The Claude-format tools in .claude/agents/*.md are not
// recognized here, so the orchestrator needs its own VS Code agent or it lists
// in the picker with no usable tools.

export const COPILOT_AGENT_TOOLS = [
  "construct-mcp/orchestration_policy",
  "construct-mcp/orchestration_run",
  "construct-mcp/orchestration_readiness",
  "search/codebase",
  "search/usages",
  "search/fileSearch",
  "read/problems",
];

function copilotAgentFile(entry, allEntries) {
  const name = adapterName(entry);
  return `---
description: ${entry.description}
name: ${name}
tools: ${JSON.stringify(COPILOT_AGENT_TOOLS)}
---

${generatedMarkdownNote}

# ${name}

${buildPrompt(entry, allEntries, "copilot")}
`;
}

function syncCopilot(entries, targetDir = null, wants = true) {
  // Deselected host: leave prior Copilot outputs untouched. Adapter pruning is
  // explicit-consent-only and `.github` is out of adapter-prune's scope
  // (lib/reconcile/adapter-prune.mjs), so a sync that did not select copilot
  // must never delete or degrade another run's files — the old empty-writeEntries
  // fall-through pruned .github/prompts and .github/agents and blanked the
  // instructions block on every copilot-less sync (construct-lqp4c).

  if (!wants) return;

  const promptsDir = targetDir
    ? path.join(targetDir, ".github", "prompts")
    : path.join(home, ".github", "prompts");
  if (!DRY_RUN) mkdirp(promptsDir);

  const writeEntries = globalEntries(entries);

  for (const entry of writeEntries) {
    writeFile(path.join(promptsDir, `${adapterName(entry)}.prompt.md`), copilotPrompt(entry, entries), { stamp: false });
  }
  removeStaleAdapters(promptsDir, ".prompt.md", writeEntries);
  if (!targetDir) {
    sweepLegacyPrefixedFiles(promptsDir, ".prompt.md", writeEntries.map((e) => `${adapterName(e)}.prompt.md`));
  }

  // VS Code reads custom agents from `.github/agents/*.agent.md`. The Claude
  // tool names in `.claude/agents/*.md` are not recognized there, so the front
  // door ships as a VS Code agent with namespaced tool grants (construct-mcp/*,
  // web/fetch, search/read) — selecting it in the dropdown then scopes those
  // tools in. The Claude-format set stays for Claude Code.

  const agentsDir = targetDir
    ? path.join(targetDir, ".github", "agents")
    : path.join(home, ".github", "agents");
  if (!DRY_RUN) mkdirp(agentsDir);
  for (const entry of writeEntries) {
    writeFile(path.join(agentsDir, `${adapterName(entry)}.agent.md`), copilotAgentFile(entry, entries), { stamp: false });
  }
  if (fs.existsSync(agentsDir)) removeStaleAdapters(agentsDir, ".agent.md", writeEntries);

  const instructionsPath = targetDir
    ? path.join(targetDir, ".github", "copilot-instructions.md")
    : path.join(home, ".github", "copilot-instructions.md");
  const existing = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, "utf8")
    : "# GitHub Copilot Instructions\n";

  // Project-scope instructions list every entry; global instructions list only
  // `construct` so user-scope Copilot exposes a single front door.

  const listEntries = targetDir ? entries.filter((e) => !e.internal) : writeEntries;
  const promptPathPrefix = targetDir ? ".github/prompts" : "~/.github/prompts";
  const list = listEntries.map((e) => `- \`${adapterName(e)}\`: use \`${promptPathPrefix}/${adapterName(e)}.prompt.md\`.`).join("\n");
  const note = `## ${systemName.charAt(0).toUpperCase() + systemName.slice(1)} Agent Prompts

Select \`${systemName}\` from the chat mode dropdown to enter the orchestrator: describe an outcome and it classifies the request and dispatches the right specialists through the \`construct-mcp\` tools (\`orchestration_policy\` then \`orchestration_run\`). You ask for outcomes, not specialists — it routes internally. Requires the \`construct-mcp\` server (wired in \`.vscode/mcp.json\`); if its tools are unavailable, the mode cannot route and will say so rather than guess.

${list || "(no front-door prompts to surface)"}`;

  // User-managed file with the managed block carved out — never doc-stamp.

  writeFile(instructionsPath, replaceManagedBlock(existing, note, mdManagedStart, mdManagedEnd), { stamp: false });
}

// --- VS Code adapter ---

function getVSCodeUserDirs() {
  const platform = os.platform();
  const dirs = [];
  if (platform === "darwin") {
    dirs.push(
      path.join(home, "Library", "Application Support", "Code", "User"),
      path.join(home, "Library", "Application Support", "Code - Insiders", "User"),
    );
  } else if (platform === "linux") {
    dirs.push(
      path.join(home, ".config", "Code", "User"),
      path.join(home, ".config", "Code - Insiders", "User"),
    );
  } else if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    dirs.push(
      path.join(appData, "Code", "User"),
      path.join(appData, "Code - Insiders", "User"),
    );
  }
  return dirs;
}

function getVSCodeUserMcpPaths() {
  // VS Code's "MCP: Open User Configuration" edits `<User>/mcp.json` (top-level
  // `servers`). Global sync returns only files that already exist — per-window
  // MCP config is never seeded, mirroring the non-polluting Cursor/OpenCode
  // global behavior.

  return getVSCodeUserDirs()
    .map((dir) => path.join(dir, "mcp.json"))
    .filter((file) => fs.existsSync(file));
}

// One comparator every host dialect (global Claude, project Claude, VS Code,
// Cursor, OpenCode) calls instead of a bespoke preserve/refresh predicate per
// surface — so the construct-mcp telemetry env passthrough and a pinned package
// version converge identically everywhere rather than drifting per host.
// needsRefresh() is the one question every dialect asks: does this host's
// existing entry still match what the registry wants, across placeholder
// resolution, transport, registry-declared env keys, pinned package versions,
// and toolkit path. Callers
// build the desired entry with their own host-specific builder (buildClaudeMcpEntry
// / buildOpenCodeMcpEntry) first — both a Claude-shape entry (`args`/`env`) and an
// OpenCode-shape entry (`command` array with the binary as element 0 / `environment`)
// are normalized here so one comparator serves both shapes.

function entryArgs(entry) {
  if (Array.isArray(entry?.args)) return entry.args;
  if (Array.isArray(entry?.command)) return entry.command;
  return [];
}

function entryEnv(entry) {
  return entry?.env ?? entry?.environment ?? {};
}

function entryIsRemote(entry) {
  return entry?.type === "http" || entry?.type === "remote";
}

// A registry env block that declares a key (e.g. the construct-mcp telemetry
// passthrough) must be present on the host entry by name; the host-resolved
// value differs per host (a literal, a `${VAR}`, a `{env:VAR}`) so only key
// presence is compared. Absence — including "no env block at all" — means stale.

function envKeysMissing(existingEnv, desiredEnv) {
  const desiredKeys = Object.keys(desiredEnv ?? {});
  if (desiredKeys.length === 0) return false;
  const existingKeys = new Set(Object.keys(existingEnv ?? {}));
  return desiredKeys.some((key) => !existingKeys.has(key));
}

// A version-pinned package arg (`@scope/name@version`, including the `@latest`
// anti-pin) is compared as an exact string: if the registry's desired pin string
// is not present verbatim anywhere in the existing args/command, the host is
// carrying a different (or floating) version and must be refreshed. Unversioned
// packages are not compared — pinning is opt-in per package via the catalog.

function argsVersionDiffers(existingArgs, desiredArgs) {
  const isPinned = (arg) => typeof arg === "string" && /^@[^/]+\/[^@]+@[\w.-]+$/.test(arg);
  const desiredPins = (desiredArgs ?? []).filter(isPinned);
  if (desiredPins.length === 0) return false;
  const existingPins = new Set((existingArgs ?? []).filter(isPinned));
  return desiredPins.some((pin) => !existingPins.has(pin));
}

export function needsRefresh(existingEntry, desiredEntry, { root } = {}) {
  if (!existingEntry) return true;
  if (JSON.stringify(existingEntry).includes("__")) return true;
  if (!entryIsRemote(desiredEntry) && entryIsRemote(existingEntry)) return true;
  if (envKeysMissing(entryEnv(existingEntry), entryEnv(desiredEntry))) return true;
  if (argsVersionDiffers(entryArgs(existingEntry), entryArgs(desiredEntry))) return true;
  if (root && mcpEntryPointsOutsideToolkit({ args: entryArgs(existingEntry) }, root)) return true;
  if (desiredEntry?.cwd !== undefined && existingEntry.cwd !== desiredEntry.cwd) return true;
  return false;
}

// VS Code's orchestration tools default their working directory to the SERVER
// process's cwd, which is host-launch-dependent (construct-6y6w.9) — the same
// tool call can read/write a different project depending on which host
// launched the server and from where. VS Code resolves `${workspaceFolder}`
// against the workspace that owns the `.vscode/mcp.json` the entry lives in,
// so pinning it there removes the ambiguity for exactly the host that has a
// single fixed workspace folder per config file. A remote/http entry has no
// process cwd to pin and is left untouched.

const VSCODE_WORKSPACE_CWD = "${workspaceFolder}";

function withVscodeWorkspaceCwd(entry) {
  if (!entry || entry.type === "http" || entry.type === "remote") return entry;
  return { ...entry, cwd: VSCODE_WORKSPACE_CWD };
}

// A merged mcp.json preserves existing entries so user customizations survive a
// re-sync. A construct-owned server path is a fully-resolved, non-placeholder
// path, so the preserve rule keeps it even when it points at a different toolkit
// root than the current one — and VS Code then launches a server that may not
// exist. Treat a construct toolkit path outside the current root as stale so the
// sync refreshes it; user-owned servers carry no lib/mcp toolkit path and stay.

// Claude/VS Code/Cursor entries carry the script path in `args`; OpenCode's local
// entry shape (buildOpenCodeMcpEntry) instead carries `command: [bin, ...args]`.
// Falling back to `command` when `args` is absent lets this one predicate serve
// both shapes without OpenCode's caller having to reshape the entry first.

export function mcpEntryPointsOutsideToolkit(entry, root) {
  const args = Array.isArray(entry?.args) ? entry.args : (Array.isArray(entry?.command) ? entry.command : []);
  return args.some((arg) => {
    if (typeof arg !== "string") return false;
    const normalArg = arg.replace(/\\/g, "/");
    const normalRoot = root.replace(/\\/g, "/");
    return /\/lib\/mcp\/[a-z0-9-]+\.mjs$/i.test(normalArg)
      && !normalArg.startsWith(`${normalRoot}/`);
  });
}

// The desired-set loop only visits registryMcp ids, so a construct-managed entry
// present in the host config but OUTSIDE the current sync set (an optional server
// like `memory` the user opted into) is never revisited — a stale toolkit path in it
// becomes immortal. This second pass rewrites those in place: the double guard (id is
// construct-managed AND its path points outside the toolkit) never touches an
// unmanaged/user entry, and rewriting to a path under root makes it idempotent (a
// second run finds nothing stale). Rewrite, never delete, never seed — opt-in sticks.

// A memory entry can be stale without pointing outside the toolkit: pinned to the dead
// legacy port, to a port other than the one currently allocated, or to a bridge script
// path that does not exist (an old checkout). Any of these means the entry cannot reach
// the running memory server — the split-brain — so it must be rewritten to the current
// port and path.

function memoryEntryIsStale(entry) {
  if (!entry) return false;
  const want = String(memoryPort(process.env));
  const portOf = (s) => String(s || "").match(/:(\d+)\/?$/)?.[1];
  const bridgeUrlEnv = entry.env?.CONSTRUCT_MEMORY_BRIDGE_URL ?? entry.environment?.CONSTRUCT_MEMORY_BRIDGE_URL;
  const ports = [portOf(entry.url), portOf(bridgeUrlEnv)];
  const portStale = ports.some((p) => p && p !== want);
  const commandArgs = Array.isArray(entry.args) ? entry.args : (Array.isArray(entry.command) ? entry.command : []);
  const scriptArg = commandArgs.find((a) => typeof a === "string" && a.endsWith("memory-bridge.mjs"));
  const pathMissing = scriptArg ? !fs.existsSync(scriptArg) : false;
  return portStale || pathMissing;
}

// OpenCode keys config.mcp by getOpenCodeMcpId(id), not the catalog id (identity
// today, but the indirection exists for a future per-host rename) — so the host
// config key this loop sees is not always the id `registryMcp`/`managedMcpDefs()`
// know. `mapId` translates the host key back to the catalog id for the ownership
// and sync-set checks; the write-back stays keyed on the original host key so no
// entry is renamed, only rewritten in place.

export function reconcileStaleManagedEntries(configMap, { registryMcp, rebuildEntry, mapId = (key) => key }) {
  if (!configMap) return false;
  const managed = managedMcpDefs();
  let changed = false;
  for (const [key, entry] of Object.entries(configMap)) {
    const catalogId = mapId(key);
    if (catalogId in registryMcp) continue;
    const mcpDef = managed[catalogId];
    if (!mcpDef) continue;
    const stale = mcpEntryPointsOutsideToolkit(entry, root) || (catalogId === "memory" && memoryEntryIsStale(entry));
    if (!stale) continue;
    configMap[key] = rebuildEntry(catalogId, mcpDef);
    changed = true;
  }
  return changed;
}

// Workspace defaults Construct manages for VS Code chat. `chat.agentFilesLocations`
// pins the agent scan to `.github/agents` so the orchestrator does not list twice
// (VS Code also scans `.claude/agents`, whose Claude tool names it ignores); its
// power over that built-in compatibility scan is version-dependent, so it is a
// best-effort hint. `chat.mcp.autostart` (VS Code ≥1.105, string enum) set to
// `always` eager-starts MCP servers so `construct-mcp` is live without a manual
// Start each session — the orchestrator's first move is an MCP call, so a dormant
// server otherwise reads as "enable the MCP server". Neither removes the one-time
// per-developer MCP trust grant, which VS Code stores locally, not in committed
// config. Each key is applied only when unset, and a settings.json that is not
// strict JSON (commented/JSONC or user-customized) is left untouched.

const VSCODE_MANAGED_SETTINGS = {
  "chat.agentFilesLocations": { ".github/agents": true, ".claude/agents": false },
  "chat.mcp.autoStart": "always",
};

// Strip full-line JSONC comments (`// …`) and trailing commas before JSON.parse.
// Handles the common VS Code settings.json patterns (line comments, trailing commas);
// does not attempt to handle inline comments after values.

function parseJsoncContent(text) {
  const stripped = text
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith('//') ? '' : line;
    })
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

export function pinVscodeChatSettings(targetDir) {
  if (DRY_RUN) return;
  const settingsPath = path.join(targetDir, ".vscode", "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = parseJsoncContent(fs.readFileSync(settingsPath, "utf8")) || {}; }
    catch { return; }
  }
  let changed = false;
  for (const [key, value] of Object.entries(VSCODE_MANAGED_SETTINGS)) {
    if (settings[key] === undefined) { settings[key] = value; changed = true; }
  }
  if (!changed) return;
  mkdirp(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function syncVSCode(targetDir = null, wants = true) {
  const registryMcp = scopedManagedMcpDefs({ projectScope: Boolean(targetDir) });
  if (Object.keys(registryMcp).length === 0) return false;

  // Project scope writes a dedicated `.vscode/mcp.json` (VS Code's documented
  // workspace MCP config, top-level `servers`). Global scope merges into the
  // user-profile `mcp.json` (the file "MCP: Open User Configuration" edits), and
  // only when it already exists — global sync never seeds per-window MCP config.

  if (targetDir) {
    const mcpPath = path.join(targetDir, ".vscode", "mcp.json");

    if (!wants) {
      if (!DRY_RUN && fs.existsSync(mcpPath)) {
        // Only delete if it matches our managed block pattern or is a simple
        // Construct-only file. For now, simple removal of the file if it
        // matches our expected content.
        try {
          const config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
          const keys = Object.keys(config?.servers ?? {});
          const allManaged = keys.every(id => id in registryMcp);
          if (allManaged) {
          fs.rmSync(mcpPath, { force: true });
          try {
            const vscodeDir = path.dirname(mcpPath);
            if (fs.existsSync(vscodeDir) && fs.readdirSync(vscodeDir).length === 0) {
              fs.rmdirSync(vscodeDir);
            }
          } catch { /* ignore non-empty */ }
        }
        } catch { /* skip cleanup of unreadable file */ }
      }
      return false;
    }

    let config = { servers: {} };
    if (fs.existsSync(mcpPath)) {
      try { config = JSON.parse(fs.readFileSync(mcpPath, "utf8")) || { servers: {} }; }
      catch { config = { servers: {} }; }
    }
    if (!config.servers) config.servers = {};
    for (const [id, mcpDef] of Object.entries(registryMcp)) {
      const existingEntry = config.servers[id];
      const desiredEntry = withVscodeWorkspaceCwd(buildClaudeMcpEntry(id, mcpDef, process.env, { host: "vscode" }));
      if (!needsRefresh(existingEntry, desiredEntry, { root })) continue;
      config.servers[id] = desiredEntry;
    }
    reconcileStaleManagedEntries(config.servers, { registryMcp, rebuildEntry: (id, def) => withVscodeWorkspaceCwd(buildClaudeMcpEntry(id, def, process.env, { host: "vscode" })) });
    if (!DRY_RUN) {
      mkdirp(path.dirname(mcpPath));
      fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    }
    pinVscodeChatSettings(targetDir);
    return true;
  }

  const mcpPaths = getVSCodeUserMcpPaths();
  if (mcpPaths.length === 0) return false;
  let synced = false;
  for (const mcpPath of mcpPaths) {
    try {
      const config = JSON.parse(fs.readFileSync(mcpPath, "utf8")) || {};
      if (!config.servers) config.servers = {};
      for (const [id, mcpDef] of Object.entries(registryMcp)) {
        const existingEntry = config.servers[id];
        const desiredEntry = buildClaudeMcpEntry(id, mcpDef, process.env, { host: "vscode" });
        if (!needsRefresh(existingEntry, desiredEntry, { root })) continue;
        config.servers[id] = desiredEntry;
      }
      if (!DRY_RUN) fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
      synced = true;
    } catch { /* unreadable mcp.json */ }
  }
  return synced;
}

// --- Cursor adapter ---

function syncCursor(targetDir = null, wants = true) {
  const registryMcp = scopedManagedMcpDefs({ projectScope: Boolean(targetDir) });
  if (Object.keys(registryMcp).length === 0) return false;

  const cursorDir = targetDir
    ? path.join(targetDir, ".cursor")
    : path.join(home, ".cursor");
  const cursorMcpPath = path.join(cursorDir, "mcp.json");

  // Global scope only updates Cursor's MCP config when the user has already
  // initialized `~/.cursor/mcp.json`; we don't conjure user-scope config out
  // of thin air. Project scope always writes — `.cursor/mcp.json` is the
  // documented per-project mechanism and travels with the repo.

  if (!targetDir && !fs.existsSync(cursorMcpPath)) return false;

  if (!wants) {
    if (!DRY_RUN && fs.existsSync(cursorMcpPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(cursorMcpPath, "utf8"));
        const keys = Object.keys(config?.mcpServers ?? {});
        const allManaged = keys.every(id => id in registryMcp);
        if (allManaged) {
          fs.rmSync(cursorMcpPath, { force: true });
          // Also clean up rules if this was a project sync
          if (targetDir) {
            const rulesPath = path.join(cursorDir, "rules", "construct.mdc");
            if (fs.existsSync(rulesPath)) fs.rmSync(rulesPath, { force: true });
            // Remove .cursor if empty
            try {
              const rulesDir = path.join(cursorDir, "rules");
              if (fs.existsSync(rulesDir) && fs.readdirSync(rulesDir).length === 0) {
                fs.rmdirSync(rulesDir);
              }
              if (fs.existsSync(cursorDir) && fs.readdirSync(cursorDir).length === 0) {
                fs.rmdirSync(cursorDir);
              }
            } catch { /* ignore non-empty or access errors */ }
          }
        }
      } catch { /* skip cleanup of unreadable file */ }
    }
    return false;
  }

  let config = { mcpServers: {} };
  if (fs.existsSync(cursorMcpPath)) {
    try { config = JSON.parse(fs.readFileSync(cursorMcpPath, "utf8")) || { mcpServers: {} }; }
    catch { return false; }
  }
  if (!config.mcpServers) config.mcpServers = {};
  for (const [id, mcpDef] of Object.entries(registryMcp)) {
    const existingEntry = config.mcpServers[id];
    const desiredEntry = buildClaudeMcpEntry(id, mcpDef, process.env, { host: "vscode" });
    if (!needsRefresh(existingEntry, desiredEntry, { root })) continue;
    config.mcpServers[id] = desiredEntry;
  }
  reconcileStaleManagedEntries(config.mcpServers, { registryMcp, rebuildEntry: (id, def) => buildClaudeMcpEntry(id, def, process.env, { host: "vscode" }) });
  if (!DRY_RUN) {
    mkdirp(path.dirname(cursorMcpPath));
    fs.writeFileSync(cursorMcpPath, JSON.stringify(config, null, 2) + "\n");
  }

  // Project scope also emits a minimal `.cursor/rules/construct.mdc` so Cursor
  // surfaces a rules entry describing Construct without polluting global rules
  // (Cursor rules are always per-project by design).

  if (targetDir) {
    const rulesPath = path.join(targetDir, ".cursor", "rules", "construct.mdc");
    const body = `---\ndescription: Construct front-door — invoke \`construct\` for orchestration\nalwaysApply: false\n---\n\n<!-- Generated by construct sync — do not edit; re-run \`construct sync\` -->\n\nThis project uses Construct (\`@geraldmaron/construct\`) as the single agent\nentry point. Route work through the \`construct\` persona; specialists are\ninternal and dispatched via MCP \`orchestration_run\` (start \`construct dashboard\`).\n\nSkills load via MCP \`get_skill\`; see \`.claude/skills/\` for synced playbooks.\n`;
    if (!DRY_RUN) {
      mkdirp(path.dirname(rulesPath));
      fs.writeFileSync(rulesPath, body);
    }

    // Glob-scoped language rules land as managed per-rule .mdc files only when
    // the project's own files match their globs — Cursor's native auto-attach
    // convention. See docs/guides/concepts/rules-delivery.md.
    try {
      emitCursorRules({ rulesDir: path.join(root, "rules"), targetDir, dryRun: DRY_RUN });
    } catch (err) {
      console.warn(`[sync] cursor rules delivery skipped: ${err.message}`);
    }
  }
  return true;
}

// --- OpenCode adapter ---

function opencodePermissions(entry) {
  // Review-only specialists (canEdit:false) must not modify files — honor the
  // registry's canEdit contract here as Claude does, rather than defaulting every
  // specialist to edit:allow.

  const perms = entry.permissions
    ? Object.fromEntries(Object.entries(entry.permissions).map(([k, v]) => [k, v]))
    : { edit: entry.canEdit === false ? "deny" : "allow", bash: "allow" };

  // Agentic Scope Reduction (ADR-0002). Serializing 100+ MCP tool schemas into a
  // small local model's prompt overruns its context window and dilutes attention,
  // collapsing output. OpenCode's per-agent permission map prunes the surface: the
  // orchestrator keeps only orchestration + core tools and hands execution to
  // subagents; subagents keep execution tools but not orchestration.

  if (entry.isOrchestrator) {
    if (perms.bash === "allow") {
      perms.bash = {
        "*": "allow",
        "rm -rf *": "deny",
        "git push *": "ask",
        "git push --force*": "ask",
        "git reset --hard *": "ask",
      };
    }
    // Heavy execution and external-knowledge tools are denied to the orchestrator so
    // its serialized tool schema stays small; orchestration_policy drives the handoff.

    perms["mcp__construct-mcp__extract_document_text"] = "deny";
    perms["mcp__construct-mcp__ingest_document"] = "deny";
    perms["mcp__construct-mcp__scan_file"] = "deny";
    perms["mcp__github__*"] = "deny";
    perms["mcp__context7__*"] = "deny";
    perms["mcp__sequential-thinking__*"] = "deny";
    perms["mcp__memory__*"] = "deny";
  } else {
    // Subagents shouldn't be orchestrating
    perms["mcp__construct-mcp__orchestration_policy"] = "deny";
    perms["mcp__construct-mcp__agent_contract"] = "deny";
    perms["mcp__construct-mcp__broker_check"] = "deny";
  }

  return perms;
}

function opencodeTaskPermissions(entry) {
  if (entry.permissions?.task) return entry.permissions.task;
  return {
    "*": "allow",
  };
}

function syncOpencode(entries, targetDir = null, wants = true) {
  // OpenCode's resolver reads `<project>/opencode.json`, `opencode.jsonc`, or
  // `<project>/.opencode/opencode.json` — never `.opencode/config.json`. Write the
  // namespaced `.opencode/opencode.json` so project agents + MCP actually load; a
  // prior `.opencode/config.json` was silently ignored by the host. Global scope
  // writes the user-level config and only when it already exists.

  const configPath = targetDir
    ? path.join(targetDir, ".opencode", "opencode.json")
    : findOpenCodeConfigPath();

  if (!targetDir && !fs.existsSync(configPath)) return false;

  if (!wants) {
    if (!DRY_RUN && fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const agentKeys = Object.keys(config?.agent ?? {});
        const allManaged = agentKeys.every(id => id === 'construct' || (registry.specialists || []).some(s => s.name === id.replace(/^cx-/, '')));
        if (allManaged) {
          fs.rmSync(configPath, { force: true });
          if (targetDir) {
            const pluginsDir = path.join(targetDir, ".opencode", "plugins");
            if (fs.existsSync(pluginsDir)) fs.rmSync(pluginsDir, { recursive: true, force: true });
            try {
              if (fs.readdirSync(path.join(targetDir, ".opencode")).length === 0) {
                fs.rmdirSync(path.join(targetDir, ".opencode"));
              }
            } catch { /* ignore non-empty */ }
          }
        }
      } catch { /* skip cleanup */ }
    }
    return false;
  }

  if (targetDir) {
    mkdirp(path.dirname(configPath));
    // Converge a stale `.opencode/config.json` (a path OpenCode never read) onto
    // the canonical name — rename to preserve content, or drop it if both exist.
    const legacyPath = path.join(targetDir, ".opencode", "config.json");
    if (!DRY_RUN && fs.existsSync(legacyPath)) {
      if (!fs.existsSync(configPath)) fs.renameSync(legacyPath, configPath);
      else fs.rmSync(legacyPath);
    }
  }

  const pluginsDir = targetDir
    ? path.join(targetDir, ".opencode", "plugins")
    : path.join(home, ".config", "opencode", "plugins");
  const managedPluginPath = path.join(pluginsDir, "construct-fallback.js");
  const toolkitPluginPath = path.join(root, "platforms", "opencode", "plugins", "construct-fallback.js");

  const writeEntries = globalEntries(entries);

  const hadExistingConfig = fs.existsSync(configPath);
  const { config } = targetDir
    ? { config: hadExistingConfig ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {} }
    : readOpenCodeConfig();
  const opencodeTemplatePath = path.join(root, "platforms", "opencode", "config.template.json");
  const opencodeTemplate = fs.existsSync(opencodeTemplatePath)
    ? JSON.parse(fs.readFileSync(opencodeTemplatePath, "utf8"))
    : {};
  if (!config.agent) config.agent = {};
  if (!config.mcp) config.mcp = {};
  if (!Array.isArray(config.plugin)) config.plugin = [];
  config.plugin = config.plugin.filter((entry) => {
    if (typeof entry !== "string") return true;
    return entry !== managedPluginPath && entry !== toolkitPluginPath;
  });

  if (opencodeTemplate.$schema && !config.$schema) config.$schema = opencodeTemplate.$schema;
  if (opencodeTemplate.model && !config.model && !config.defaultModel && !hadExistingConfig) {
    config.model = opencodeTemplate.model;
  }
  if (Array.isArray(opencodeTemplate.enabled_providers) && !Array.isArray(config.enabled_providers)) {
    config.enabled_providers = [...opencodeTemplate.enabled_providers];
  }
  if (opencodeTemplate.provider && typeof opencodeTemplate.provider === "object") {
    config.provider ??= {};
    for (const [id, providerDef] of Object.entries(opencodeTemplate.provider)) {
      config.provider[id] = mergeMissingObjectDefaults(config.provider[id], resolveTemplateStrings(providerDef));
    }
  }
  if (config.provider?.ollama?.options?.headers?.Authorization === "Bearer ollama") {
    delete config.provider.ollama.options.headers.Authorization;
    if (Object.keys(config.provider.ollama.options.headers).length === 0) {
      delete config.provider.ollama.options.headers;
    }
  }

  const templateMcp = opencodeTemplate.mcp && typeof opencodeTemplate.mcp === "object"
    ? resolveTemplateStrings(opencodeTemplate.mcp)
    : {};
  for (const [id, entry] of Object.entries(templateMcp)) {
    if (!PROJECT_DEFAULT_MCP_IDS.has(id)) continue;
    if (!config.mcp[id]) config.mcp[id] = entry;
  }
  if (config.mcp["construct-mcp"]) {
    config.mcp["construct-mcp"] = templateMcp["construct-mcp"] ?? config.mcp["construct-mcp"];
  }

  const memoryBridgeEntry = buildOpenCodeMcpEntry("memory", {
    command: "node",
    args: ["__CX_TOOLKIT_DIR__/lib/mcp/memory-bridge.mjs"],
    env: { CONSTRUCT_MEMORY_BRIDGE_URL: "__CONSTRUCT_MEMORY_BRIDGE_URL__" },
  }, {
    ...process.env,
    CONSTRUCT_MEMORY_BRIDGE_URL:
      config.mcp.memory?.url
      || config.mcp.cass?.url
      || process.env.CONSTRUCT_MEMORY_BRIDGE_URL
      || "http://127.0.0.1:8765/",
  }).entry;
  const staleMemoryRemote = config.mcp.memory && (config.mcp.memory.type === "remote" || config.mcp.memory.type === "http");
  const staleCassRemote = config.mcp.cass && (config.mcp.cass.type === "remote" || config.mcp.cass.type === "http");
  if (staleMemoryRemote || staleCassRemote) {
    config.mcp.memory = memoryBridgeEntry;
    delete config.mcp.cass;
  }

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
          ...existing.options,
          headers: {
            ...providerDef.options?.headers,
            ...existing.options?.headers,
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

  ensureOpenRouterProviderAuth(config);

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
  const registryMcp = scopedManagedMcpDefs({ projectScope: Boolean(targetDir) });
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
      const desiredEntry = buildOpenCodeMcpEntry(id, mcpDef, process.env).entry;

      // The registry's own args can carry an unresolved `__NAME__` template (a
      // secret var not yet set in this environment); needsRefresh only inspects
      // built entries, so a still-templated registry def is checked separately
      // and always wins a refresh once the var resolves.
      const argsHaveTemplates = (mcpDef.args ?? []).some((a) => typeof a === 'string' && a.includes('__'));
      if (argsHaveTemplates || needsRefresh(existingEntry, desiredEntry, { root })) {
        config.mcp[openCodeId] = desiredEntry;
      }
    }

    // The sync-set loop above only visits `registryMcp` ids, so a managed-but-optional
    // entry (e.g. `memory` in project scope) with a stale toolkit path is never
    // revisited here either — the same immortal-entry gap fixed for VS Code/Cursor/
    // Claude project (construct-6y6w.1). `getOpenCodeMcpId` keys config.mcp by the
    // host id rather than the catalog id, so map it back before checking ownership.
    const catalogIdForOpenCodeKey = new Map(
      Object.keys(managedMcpDefs()).map((catalogId) => [getOpenCodeMcpId(catalogId), catalogId]),
    );
    reconcileStaleManagedEntries(config.mcp, {
      registryMcp,
      mapId: (key) => catalogIdForOpenCodeKey.get(key) ?? key,
      rebuildEntry: (catalogId, def) => buildOpenCodeMcpEntry(catalogId, def, process.env).entry,
    });

    // Heavy external MCP servers serialize a measured ~37k tokens of tool schema
    // into EVERY agent's request — github ~30k alone (fixtures 2026-06-22) —
    // agent's request — including the built-in Build/Plan agents the per-agent
    // permission prune cannot reach. OpenCode 1.15.4 has no per-session tool
    // filter (OpenCode chat.params carries no tool list), so disabling the whole server in
    // opencode.json is the only lever. The decision is INTENT-driven: trim only
    // when this config's own default model is local (or a local Ollama provider is
    // registered in it), so a cloud session on a machine that merely also has
    // Ollama keeps context7/github. decideTrim centralizes the policy; a manual
    // enabled:true is preserved so a user can re-enable a server they need.

    // A set default model is explicit intent and wins (local → trim, cloud → keep).
    // Only when no default is chosen does a registered Ollama provider stand in as
    // soft local intent — so a cloud-default config is never trimmed for merely
    // listing local models alongside.
    const configDefaultModel = config.model || config.defaultModel || "";
    const registersOllamaProvider = Object.keys(config.provider?.ollama?.models || {}).length > 0;
    const intentModel = configDefaultModel || (registersOllamaProvider ? "ollama" : "");
    const trimHeavyServers = decideTrim({ surface: LOCAL_SURFACE, defaultModel: intentModel });
    for (const id of HEAVY_EXTERNAL_MCP_IDS) {
      const ocId = getOpenCodeMcpId(id);
      if (!config.mcp[ocId]) continue;
      if (trimHeavyServers) {
        if (config.mcp[ocId].enabled !== true) config.mcp[ocId].enabled = false;
      } else {
        delete config.mcp[ocId].enabled;
      }
    }
  }

  // Sweep cx-* / orchestrator agents that fall outside the current write set.
  // In global scope this also removes any `cx-*` left over from prior syncs.

  const prefixes = [agentPrefix];
  for (const key of Object.keys(config.agent)) {
    const isManaged = prefixes.some((p) => key.startsWith(p));
    const isOrchestrator = registry.orchestrator?.name === key;
    const isStaleOrchestratorAlias = key === 'orchestrator' && registry.orchestrator?.name === 'construct';
    if ((isManaged || isOrchestrator || isStaleOrchestratorAlias) && !writeEntries.find((e) => adapterName(e) === key)) {
      delete config.agent[key];
    }
  }

  // Write agents — no model/modelFallback set; agents inherit the global model.
  //
  // Capability tier for the orchestrator prompt. Keyed ONLY to an EXPLICIT local default
  // model — that is a clear intent signal we can size against at sync time. With no
  // explicit default (the orchestrator runs whatever model the user picks at runtime) or
  // a cloud default, resolveCapabilityTier returns 'full', so cloud configs and unknown
  // selections are never slimmed. Per-model slimming of a known pinned model lands on the
  // construct-local editor agent.

  const orchestratorDefaultModel = config.model || config.defaultModel || "";
  adviseLocalModelCapability(orchestratorDefaultModel);
  const orchestratorTier = resolveCapabilityTier({
    model: orchestratorDefaultModel,
    verdict: orchestratorDefaultModel ? (getModelVerdict(orchestratorDefaultModel)?.verdict ?? null) : null,
  });

  for (const entry of writeEntries) {
    const name = adapterName(entry);
    const perms = opencodePermissions(entry);
    config.agent[name] = {
      description: entry.isOrchestrator
        ? `${entry.role} — ${entry.description}`
        : entry.description,
      mode: entry.isOrchestrator ? "all" : "subagent",
      prompt: buildPrompt(entry, entries, "opencode", {
        capabilityTier: entry.isOrchestrator ? orchestratorTier : "full",
      }),
      permission: {
        ...perms,
        task: opencodeTaskPermissions(entry),
      },
    };
  }

  // Hybrid split (cheap local editor, capable architect). When the fast tier is a LOCAL model, emit a
  // narrow `construct-local` editor: it does bounded edits on a cheap local model and hands
  // planning/reasoning back to `construct` (the architect, which stays on the user's chosen
  // model — we never pin it). The editor's model is NOT the generic fast-tier default
  // (which for an Ollama family resolves to a non-code generalist); it is the best-installed
  // CODE model from this config's DECLARED local inventory (OpenCode only uses declared
  // models), excluding probe-COLLAPSED ones, with the fast tier as a last resort. Its prompt
  // is sized to the chosen model's capability tier. Deterministic name, so manage it
  // explicitly: emit when fast is local, delete otherwise, so switching to cloud cleans up.

  const orchestratorEntry = writeEntries.find((e) => e.isOrchestrator) || registry.orchestrator;
  const orchestratorName = orchestratorEntry ? adapterName(orchestratorEntry) : "construct";
  const localEditorName = `${orchestratorName}-local`;
  if (orchestratorEntry?.promptFile && isLocalModel(resolvedModels.fast)) {
    const declaredLocal = Object.entries(config.provider || {})
      .flatMap(([pid, pv]) => Object.keys(pv?.models || {}).map((mk) => `${pid}/${mk}`))
      .filter((id) => isLocalModel(id) && getModelVerdict(id)?.verdict !== "COLLAPSED");
    const editorModel = selectLocalEditorModel(declaredLocal) || resolvedModels.fast;
    adviseLocalModelCapability(editorModel);
    const editorVerdict = getModelVerdict(editorModel)?.verdict ?? null;
    const editorTier = resolveCapabilityTier({ model: editorModel, verdict: editorVerdict });
    const editorBody = renderPersonaForTier(readPromptBody(orchestratorEntry.promptFile, root), editorTier);
    config.agent[localEditorName] = {
      description: "Local execution agent — bounded edits on the local model; escalates planning and reasoning to construct.",
      mode: "subagent",
      model: editorModel,
      prompt: `${LOCAL_EDITOR_DIRECTIVE}\n\n${editorBody}`,
      permission: {
        edit: "allow",
        bash: { "*": "allow", "rm -rf *": "deny", "git push *": "ask", "git push --force*": "ask", "git reset --hard *": "ask" },
        "mcp__construct-mcp__orchestration_policy": "deny",
        "mcp__construct-mcp__agent_contract": "deny",
        "mcp__construct-mcp__broker_check": "deny",
        "mcp__github__*": "deny",
        "mcp__context7__*": "deny",
        "mcp__sequential-thinking__*": "deny",
        "mcp__memory__*": "deny",
        // OpenCode 1.15.4 disables the `task` tool entirely for any restrictive task map
        // (verified in a sterile run). For an editor that is exactly right: it spawns no
        // subagents and escalates by RETURNING to the construct agent that dispatched it,
        // not by dispatching. Deny-all states that intent directly.
        task: { "*": "deny" },
      },
    };
  } else {
    delete config.agent[localEditorName];
  }

  // Pass current Construct model tiers to OpenCode config for native routing.
  config.construct = config.construct || {};
  config.construct.models = { ...resolvedModels };

  // OpenCode's primary `model` is user-owned. Remove the legacy Construct seed
  // when we find it so the app can fall back to its own remembered selection
  // instead of a stale pin. New syncs never write this key back.
  const legacyPinnedModels = new Set([
    opencodeTemplate.model,
    hardDefaults.standard,
  ].filter(Boolean));
  if (!targetDir && legacyPinnedModels.has(config.model)) {
    delete config.model;
  }

  // OpenCode's built-in helper agents (session naming, summaries, compaction)
  // must follow the host's live routing — an absolute model pin here made
  // compaction call a provider the user had no key/credits for, failing hard
  // even though a working model was selected for the session. Keep the entries
  // present (hosts and tests rely on them existing) but strip any model pin a
  // previous sync wrote, whether the old weak coder default or a strong tier
  // pin, so OpenCode falls back to its own session-model/small_model routing.
  for (const key of ["title", "summary", "compaction"]) {
    const existing = config.agent[key] && typeof config.agent[key] === "object" ? config.agent[key] : {};
    delete existing.model;
    config.agent[key] = existing;
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
  // Slash commands describe project-shaped workflows (release, init, sync …)
  // and belong with the repo so teammates pick them up via git. Project scope
  // only — global scope is a no-op.

  if (!targetDir) return 0;

  const sourceCommandsDir = path.join(root, "commands");
  if (!fs.existsSync(sourceCommandsDir)) return 0;

  const claudeCommandsDir = path.join(targetDir, ".claude", "commands");

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

// --- Skills sync ---

/**
 * Walk skills/ recursively and collect every .md file (flat) and every
 * <name>/SKILL.md directory entry. Returns [{ name, content }] where name
 * is the slash-relative path without extension, e.g. "strategy/narrative-arc".
 */
function collectSkills() {
  const skillsDir = path.join(root, "skills");
  const results = [];

  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Check if this is a SKILL.md directory form: <name>/SKILL.md
        const skillMdPath = path.join(full, "SKILL.md");
        if (fs.existsSync(skillMdPath)) {
          // Avoid double-walking; record this skill and do not descend further.
          const name = rel;
          results.push({ name, content: fs.readFileSync(skillMdPath, "utf8") });
        } else {
          walk(full, rel);
        }
      } else if (entry.name.endsWith(".md") && entry.name !== "routing.md" && entry.name !== "SKILL.md") {
        const name = rel.replace(/\.md$/, "");
        results.push({ name, content: fs.readFileSync(full, "utf8") });
      }
    }
  }

  walk(skillsDir, "");
  return results;
}

/**
 * Write collected skills to both .claude/skills/ and .agents/skills/ in
 * SKILL.md directory format. Each file gets Anthropic Agent Skills frontmatter
 * (name + description) so the loader can index it. Doc-stamping is opted out
 * — a doc-stamp YAML block before the real frontmatter produces double-
 * frontmatter the loader can't parse.
 */
function syncSkills(targetDir = null) {
  // Skills are project content — they describe domain knowledge a team shares,
  // not a user's personal default. Global scope writes nothing; project scope
  // writes to `<project>/.claude/skills/` (the documented Anthropic Agent
  // Skills path).

  if (!targetDir) return 0;

  const skills = collectSkills();
  if (skills.length === 0) return 0;

  const claudeSkillsDir = path.join(targetDir, ".claude", "skills");

  for (const { name, content } of skills) {
    const frontmatter = buildSkillFrontmatter(name, content);

    // Strip any existing frontmatter from the source body so we don't emit two
    // blocks if a hand-authored skill already carries one.

    const body = stripLeadingFrontmatter(content);
    const generated = `${frontmatter}\n${body}`;
    writeFile(path.join(claudeSkillsDir, name, "SKILL.md"), generated, { stamp: false });
  }

  return skills.length;
}

// --- Main ---

if (isMain) {
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
    if (!entry.isOrchestrator || !entry.prompt) continue;
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
    console.log(`compress-personas: ${totalIn} → ${totalOut} chars (${ratio}%) across ${entries.filter((e) => e.isOrchestrator).length} personas`);
  }
}

acquireLock();
try {
  if (projectDir) {
    syncClaude(entries, projectDir, wantsHost("claude"));
    syncCodex(entries, projectDir, wantsHost("codex"));
    syncCopilot(entries, projectDir, wantsHost("copilot"));
    const opencodeOk = syncOpencode(entries, projectDir, wantsHost("opencode"));
    const vscodeOk = syncVSCode(projectDir, wantsHost("vscode"));
    const cursorOk = syncCursor(projectDir, wantsHost("cursor"));
    const cmdCount = wantsHost("claude") ? syncCommands(projectDir) : 0;
    const skillCount = wantsHost("claude") ? syncSkills(projectDir) : 0;

    if (DRY_RUN) {
      printDryRunDiff();
    } else {
      commitStaging();
      const targets = [
        wantsHost("claude") && "Claude Code",
        wantsHost("codex") && "Codex",
        wantsHost("copilot") && "Copilot",
        opencodeOk && "OpenCode",
        vscodeOk && "VS Code",
        cursorOk && "Cursor",
      ].filter(Boolean).join(", ");
      summary(`Synced ${entries.length} agents + ${cmdCount} commands + ${skillCount} skills to ${path.relative(process.cwd(), projectDir) || "."} (project mode → ${targets}).`);
    }
  } else {
    const personaCount = entries.filter((e) => e.isOrchestrator).length;

    syncCodex(entries, null, wantsHost("codex"));
    syncClaude(entries, null, wantsHost("claude"));
    syncCopilot(entries, null, wantsHost("copilot"));
    const opencodeOk = syncOpencode(entries, null, wantsHost("opencode"));
    const vscodeOk = syncVSCode(null, wantsHost("vscode"));
    const cursorOk = syncCursor(null, wantsHost("cursor"));
    syncCommands();
    syncSkills();

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
      summary(`Synced ${personaCount} front-door agent to global scope (${targets}). Specialists, commands, and skills are project-only — run \`construct init\` inside a project to scaffold them.`);

      const completionsDir = generateCompletions();
      if (completionsDir) {
        summary(`Completions updated → ${completionsDir}`);
      }
    }
  }
} finally {
  releaseLock();
}
}
