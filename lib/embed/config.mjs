/**
 * lib/embed/config.mjs — embed mode configuration schema and loader.
 *
 * Reads embed.yaml from the XDG config dir (or a supplied path) and validates
 * the file against the expected schema. Returns a parsed, normalized config object.
 *
 * Schema:
 *
 *   sources:
 *     - provider: github
 *       repo: owner/name           # single repo
 *       repos: [owner/a, owner/b]  # OR list of repos
 *       refs: [prs, issues, commits]
 *       branch: main               # for commits ref
 *       limit: 25
 *
 *     - provider: slack
 *       channel: C12345678         # single channel ID or name
 *       channels: [general, eng]   # OR list
 *       refs: [messages]
 *       oldest: 86400              # seconds of history (default 24h)
 *
 *     - provider: linear
 *       team: ENG                  # team key (optional)
 *       project: My Project        # project name filter (optional)
 *       refs: [issues, cycles]
 *       states: [Todo, In Progress]
 *
 *     - provider: jira
 *       project: PROJ              # project key
 *       projects: [PROJ, INFRA]    # OR list
 *       refs: [issues, sprints]
 *       jql: "project = PROJ AND sprint in openSprints()"  # override JQL
 *       filter:                    # ADR-0060 filter block (LMCP-B11)
 *         scope: { projects: [PROJ] }
 *         predicates: { statusCategory: [in-progress], updatedSince: P14D }
 *         nativeQuery: "sprint in openSprints()"   # optional passthrough
 *
 *   outputs:
 *     - type: markdown            # write snapshot to a file
 *       path: .cx/snapshot.md
 *     - type: slack               # post to a Slack channel
 *       provider: slack
 *       channel: C12345
 *
 *   approval:
 *     require:                    # action types that need approval before dispatch
 *       - issue.create
 *       - pr.merge
 *     timeout_ms: 3600000         # how long to wait before auto-expiring (default: 1h)
 *     fallback: reject            # reject | proceed (default: reject)
 *
 *   snapshot:
 *     intervalMs: 300000          # how often to regenerate full snapshot (default: 5m)
 *     maxItems: 100               # max items per source in snapshot
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, stateDir } from '../config/xdg.mjs';

const DEFAULTS = {
  snapshot: { intervalMs: 300_000, maxItems: 100 },
  approval: { require: [], timeout_ms: 3_600_000, fallback: 'reject' },
  roles: { primary: null, secondary: null },
};

/**
 * Target types for embed output routing.
 *
 * targets:
 *   - type: repo
 *     ref: github.com/org/project-x          # remote — interact via provider
 *   - type: repo
 *     path: /Users/user/Github/local-project  # local filesystem
 *   - type: repo
 *     ref: github.com/org/project-y
 *     path: /Users/user/Github/project-y      # both — prefer local, fall back to remote
 *   - type: workspace                         # always present as fallback
 *     path: <XDG_STATE_HOME>/construct/workspace
 *
 * roles:
 *   primary: product-manager    # shapes embed analysis lens
 *   secondary: architect        # persistent background concern
 */
export const DEFAULT_WORKSPACE_PATH = path.join(stateDir(), 'workspace');

export const WORKSPACE_DOCS_LANES = ['adrs', 'prds', 'memos', 'notes', 'intake'];

export const OPERATING_PROFILE_VERSION = 'embed-operating-profile/v1';

export const DEFAULT_OPERATING_PROFILE = {
  schemaVersion: OPERATING_PROFILE_VERSION,
  mode: 'embed',
  mission: 'Maintain situational awareness across connected project systems and turn weak signals into actionable plans, drafts, risks, and approval-queued work.',
  strategy: {
    defaultPosture: 'assistive',
    autonomy: 'read-first',
    writePolicy: 'approval-required-for-high-risk',
    dependencyPolicy: 'zero-deps',
    precedence: 'approval rules override operating profile preferences',
  },
  focalResources: [
    { type: 'plan', path: 'plan.md', purpose: 'active implementation plan' },
    { type: 'architecture', path: 'docs/guides/concepts/architecture.md', purpose: 'system architecture and operating model' },
    { type: 'knowledge', path: '.cx/knowledge', purpose: 'typed project knowledge and ingested evidence' },
    { type: 'runtime', path: '.cx/roadmap.md', purpose: 'generated roadmap output' },
  ],
  approach: [
    'read configured sources',
    'compare observed activity with mission and focal resources',
    'identify gaps, risks, stale decisions, and missing artifacts',
    'draft roadmaps, PRDs, RFCs, ADRs, memos, status updates, summaries, and wireframes',
    'route high-risk writes through the approval queue',
  ],
  authority: {
    read: 'autonomous',
    summarize: 'autonomous',
    draftArtifacts: 'autonomous',
    createIssues: 'approval-queued',
    updateIssues: 'approval-queued',
    publishDocs: 'approval-queued',
    externalPost: 'approval-queued',
    repoWrites: 'approval-queued',
  },
  responsibilities: {
    gapAnalysis: true,
    issueLifecycle: { create: 'approval-queued', update: 'approval-queued', dedupe: 'recommend' },
    artifacts: {
      roadmaps: 'generate',
      prds: 'draft',
      rfcs: 'draft',
      adrs: 'draft',
      memos: 'draft',
      statusUpdates: 'generate',
      summaries: 'generate',
      wireframes: 'draft',
      risks: 'generate',
    },
  },
  riskModel: {
    detect: ['blocked work', 'missing owner', 'stale cadence', 'source errors', 'missing focal resource', 'unapproved high-risk action'],
    riskStatus: { ok: 'no known gaps', attention: 'gaps or source errors exist', blocked: 'required focal resource or approval path missing' },
  },
};

export const EMPTY_CONFIG = {
  sources: [],
  outputs: [],
  targets: [{ type: 'workspace', path: DEFAULT_WORKSPACE_PATH }],
  roles: { ...DEFAULTS.roles },
  snapshot: { ...DEFAULTS.snapshot },
  approval: { ...DEFAULTS.approval },
  operatingProfile: DEFAULT_OPERATING_PROFILE,
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) merged[key] = value;
    else if (value && typeof value === 'object' && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      merged[key] = deepMerge(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function loadEmbedConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Embed config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  // Minimal YAML subset parser: handles the flat-ish schema we use.
  // Full YAML parsing requires a dep; we use a hand-rolled parser for zero-dep core.
  const parsed = parseEmbedYaml(raw);
  return normalize(parsed);
}

export function normalize(raw) {
  const config = {
    sources: [],
    outputs: [],
    targets: [],
    roles: { ...DEFAULTS.roles, ...(raw.roles ?? {}) },
    snapshot: { ...DEFAULTS.snapshot, ...(raw.snapshot ?? {}) },
    approval: { ...DEFAULTS.approval, ...(raw.approval ?? {}) },
    operatingProfile: deepMerge(DEFAULT_OPERATING_PROFILE, raw.operatingProfile ?? {}),
  };

  for (const src of raw.sources ?? []) {
    if (!src.provider) throw new Error('Each source must have a "provider" field');
    config.sources.push({
      ...src,
      provider: src.provider,
      refs: Array.isArray(src.refs) ? src.refs : [src.refs ?? 'status'],
      intervalMs: src.intervalMs ?? 60_000,
    });
  }

  for (const out of raw.outputs ?? []) {
    if (!out.type) throw new Error('Each output must have a "type" field');
    config.outputs.push({ ...out });
  }

  // Targets: explicit list, always has workspace fallback
  for (const t of raw.targets ?? []) {
    if (!t.type) throw new Error('Each target must have a "type" field');
    config.targets.push({ ...t });
  }
  // Ensure workspace fallback is always present
  if (!config.targets.some((t) => t.type === 'workspace')) {
    config.targets.push({ type: 'workspace', path: DEFAULT_WORKSPACE_PATH });
  }

  return config;
}

/**
 * Hand-rolled parser for the embed YAML schema.
 * Supports: top-level keys, nested objects, lists of objects, scalar values.
 * Not a general YAML parser — only handles what embed.yaml uses.
 */
export function parseEmbedYaml(text) {
  const lines = text.split('\n');
  const root = {};
  let i = 0;

  function peek() { return lines[i]; }
  function advance() { return lines[i++]; }
  function indent(line) { return line.match(/^(\s*)/)[1].length; }
  function isComment(line) { return line.trimStart().startsWith('#'); }
  function isEmpty(line) { return line.trim() === ''; }

  function parseValue(val) {
    const v = val.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~' || v === '') return null;
    if (v === '[]') return [];
    if (v === '{}') return {};
    // Inline flow list: [a, b, c]
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map((s) => parseValue(s.trim()));
    }
    const n = Number(v);
    if (!Number.isNaN(n) && v !== '') return n;
    // Strip quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parseBlock(baseIndent) {
    const obj = {};
    while (i < lines.length) {
      const line = peek();
      if (isEmpty(line) || isComment(line)) { advance(); continue; }
      const lineIndent = indent(line);
      if (lineIndent < baseIndent) break;
      if (lineIndent > baseIndent) { advance(); continue; } // skip malformed

      advance();
      const trimmed = line.trim();

      // List item
      if (trimmed.startsWith('- ')) {
        // Not expected at block level — handled by parseList
        break;
      }

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1);

      if (rest.trim() === '') {
        // Next lines are either a list or nested object
        const nextLine = lines[i];
        if (!nextLine) { obj[key] = null; continue; }
        const nextTrimmed = nextLine.trimStart();
        if (nextTrimmed.startsWith('- ')) {
          obj[key] = parseList(lineIndent + 2);
        } else {
          obj[key] = parseBlock(lineIndent + 2);
        }
      } else {
        obj[key] = parseValue(rest);
      }
    }
    return obj;
  }

  function parseList(baseIndent) {
    const arr = [];
    while (i < lines.length) {
      const line = peek();
      if (isEmpty(line) || isComment(line)) { advance(); continue; }
      const lineIndent = indent(line);
      if (lineIndent < baseIndent) break;

      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) break;
      advance();

      const rest = trimmed.slice(2).trim();
      if (rest === '') {
        // Multi-line list item object
        arr.push(parseBlock(lineIndent + 2));
      } else if (rest.includes(':')) {
        // Inline object in list: "- provider: github"
        const item = {};
        const colonIdx = rest.indexOf(':');
        const key = rest.slice(0, colonIdx).trim();
        const val = rest.slice(colonIdx + 1).trim();
        item[key] = val === '' ? parseBlock(lineIndent + 2) : parseValue(val);
        // Consume continuation keys at same level
        while (i < lines.length) {
          const next = lines[i];
          if (isEmpty(next) || isComment(next)) { i++; continue; }
          if (indent(next) <= lineIndent) break;
          i++;
          const nt = next.trim();
          const ci = nt.indexOf(':');
          if (ci === -1) continue;
          const nk = nt.slice(0, ci).trim();
          const nv = nt.slice(ci + 1).trim();
          if (nv === '') {
            const nextNext = lines[i];
            if (nextNext && nextNext.trimStart().startsWith('- ')) {
              item[nk] = parseList(indent(next) + 2);
            } else {
              item[nk] = parseBlock(indent(next) + 2);
            }
          } else {
            item[nk] = parseValue(nv);
          }
        }
        arr.push(item);
      } else {
        arr.push(parseValue(rest));
      }
    }
    return arr;
  }

  return parseBlock(0);
}

export function defaultEmbedConfigPath() {
  return path.join(configDir(), 'embed.yaml');
}

// ---------------------------------------------------------------------------
// Serializer — writes the flat-ish subset parseEmbedYaml() understands
// (scalars, inline string/number lists, nested objects, lists of objects).
// Zero-dep counterpart to the hand-rolled parser above; not a general YAML
// emitter.
// ---------------------------------------------------------------------------

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s === '' || /[:#\n]|^[[{]/.test(s) || s !== s.trim()) return JSON.stringify(s);
  return s;
}

function yamlInlineList(arr) {
  return `[${arr.map((v) => yamlScalar(v)).join(', ')}]`;
}

function serializeListItem(item, indent) {
  const pad = '  '.repeat(indent);
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return `${pad}- ${yamlScalar(item)}\n`;
  }
  let out = '';
  let first = true;
  for (const [key, value] of Object.entries(item)) {
    const prefix = first ? `${pad}- ` : `${pad}  `;
    first = false;
    if (value === null || value === undefined) {
      out += `${prefix}${key}: null\n`;
    } else if (Array.isArray(value)) {
      out += `${prefix}${key}: ${value.length ? yamlInlineList(value) : '[]'}\n`;
    } else if (typeof value === 'object') {
      out += `${prefix}${key}:\n${serializeEmbedYaml(value, indent + 2)}`;
    } else {
      out += `${prefix}${key}: ${yamlScalar(value)}\n`;
    }
  }
  return out;
}

/**
 * Serialize a plain object into the embed.yaml subset parseEmbedYaml() can
 * read back. Exported for round-tripping the config in `writeEmbedYaml` and
 * for callers (e.g. `construct monitor`) that assemble the raw object
 * themselves before writing.
 */
export function serializeEmbedYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  let out = '';
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (value === null || value === undefined) {
      out += `${pad}${key}: null\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        out += `${pad}${key}: []\n`;
      } else if (value.every((v) => v === null || typeof v !== 'object')) {
        out += `${pad}${key}: ${yamlInlineList(value)}\n`;
      } else {
        out += `${pad}${key}:\n`;
        for (const item of value) out += serializeListItem(item, indent + 1);
      }
    } else if (typeof value === 'object') {
      if (Object.keys(value).length === 0) {
        out += `${pad}${key}: {}\n`;
      } else {
        out += `${pad}${key}:\n${serializeEmbedYaml(value, indent + 1)}`;
      }
    } else {
      out += `${pad}${key}: ${yamlScalar(value)}\n`;
    }
  }
  return out;
}

/**
 * Write a raw (pre-normalize) embed config object to disk as embed.yaml.
 * Callers that need to preserve unrelated existing content should parse the
 * current file with `parseEmbedYaml`, mutate the returned object in place,
 * and pass it back here rather than starting from `EMPTY_CONFIG`/`normalize`
 * output — normalize() fills in defaults (including the full
 * `operatingProfile`) that would otherwise get baked into the file verbatim.
 */
export function writeEmbedYaml(configPath, raw) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, serializeEmbedYaml(raw));
  return configPath;
}
