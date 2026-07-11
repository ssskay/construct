/**
 * lib/audit-trail.mjs — owns the append-only audit log written by
 * lib/hooks/audit-trail.mjs and rendered for `construct audit trail`.
 *
 * The log is JSONL at ~/.cx/audit-trail.jsonl. Each line carries a
 * prev_line_hash pointing at the SHA-256 of the previous line — tampering
 * (reorder, delete, edit) breaks the chain and is surfaced by --verify.
 *
 * A serial hash chain cannot survive concurrent appends: a read-prev-hash +
 * append done outside a critical section lets two processes (hook, daemon,
 * parallel tool calls in one session) both chain off the same predecessor, so
 * the second link points at a stale tail. appendAuditRecord
 * closes that window by computing prev_line_hash and appending inside a single
 * cross-process file lock, making every writer effectively serialized.
 *
 * Corrupted links cannot be re-derived, so a `chain_reset` boundary line seals
 * the damaged prefix as immutable legacy and re-bases the live chain;
 * verifyChain validates only from the last boundary forward. See
 * docs/guides/concepts/observability.md.
 *
 * Every record passes through redactRecord before the chain hash is computed
 * (redact-then-sign), so prev_line_hash always chains off the redacted form —
 * a secret can never enter the signed chain even transiently. Redaction
 * covers: (a) values resolved by lib/providers/secret-resolver.mjs, consulted
 * read-only via its resolved-cache snapshot; (b) common token shapes (Bearer,
 * ghp_, xoxb/xoxp/xoxa, sk-, op://); (c) custom patterns registered with
 * configureRedactionPatterns. Matches are replaced with `<redacted:kind>`;
 * the pass itself is audited as a count, never the matched text.
 *
 * LMCP-H5: checkAuditSinkAvailable performs a real write-probe against the
 * audit directory (mkdir + append + unlink a sidecar file) so a caller can
 * distinguish "sink healthy" from "sink down" (read-only filesystem, missing
 * mount, permissions) before deciding whether to proceed. Enterprise mode's
 * mandatory-audit gate (lib/policy/audit-gate.mjs) fails closed on this
 * check; solo/team never call it.
 */
import { readFileSync, existsSync, statSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

import { appendBounded, readLastLineAcrossSegments } from './logging/rotate.mjs';
import { withFileLockSync } from './storage/file-lock.mjs';
import { doctorRoot } from './config/xdg.mjs';
import { __resolvedSecretValues } from './providers/secret-resolver.mjs';

// Resolved per call, never at import: a test that pins CONSTRUCT_DOCTOR_ROOT
// (or XDG_STATE_HOME/HOME) after this module loads must still have every
// default-path write land under its fixture root, not the real state dir.

function auditFile() {
  return join(doctorRoot(), 'audit-trail.jsonl');
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export class AuditSinkUnavailableError extends Error {
  constructor(message, { file, reason } = {}) {
    super(message);
    this.name = 'AuditSinkUnavailableError';
    this.file = file ?? null;
    this.reason = reason ?? null;
  }
}

// A real write-probe, not a stat/existsSync check: a directory can exist and
// still refuse writes (read-only remount, quota, permission drop after
// mkdir). Writing and removing a sidecar file physically exercises the same
// path appendAuditRecord will take next, so "available" here means the next
// real append is actually expected to succeed.

export function checkAuditSinkAvailable({ file = auditFile() } = {}) {
  const dir = dirname(file);
  const probePath = join(dir, `.audit-sink-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(probePath, 'probe\n', 'utf8');
    unlinkSync(probePath);
    return { available: true, reason: null };
  } catch (err) {
    return { available: false, reason: err?.code || err?.message || 'unknown-error' };
  }
}

// Built-in token shapes seen in the wild across providers: generic Bearer
// headers, GitHub PATs (ghp_), Slack bot/user/app tokens (xoxb/xoxp/xoxa),
// OpenAI-style secret keys (sk-), and 1Password references (op://...). Each
// pattern is tagged with a `kind` so the replacement reads `<redacted:kind>`
// rather than a single opaque marker, which keeps audit records diagnosable.

const BUILTIN_PATTERNS = [
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { kind: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[bpa]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { kind: 'op-reference', re: /\bop:\/\/[^\s'"]+/g },
];

// Custom patterns a caller wires in at startup (e.g. an org-specific token
// shape). Kept process-local and additive over BUILTIN_PATTERNS; never
// persisted, so a test or embedder can register/reset freely.

let customPatterns = [];

/**
 * Register additional redaction patterns beyond the built-in token shapes.
 * Each entry is `{ kind, re }` where `re` is a global RegExp. Replaces the
 * full custom set on every call so a caller can reconfigure cleanly.
 *
 * @param {{kind:string, re:RegExp}[]} patterns
 */
export function configureRedactionPatterns(patterns = []) {
  customPatterns = Array.isArray(patterns) ? patterns.filter((p) => p && p.re instanceof RegExp && typeof p.kind === 'string') : [];
}

export function __resetRedactionPatterns() {
  customPatterns = [];
}

// Secret values below this length are excluded from the known-value pass:
// short resolved values (flags, single-char tokens) produce false-positive
// redactions in ordinary prose.

const MIN_KNOWN_SECRET_LENGTH = 8;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A resolved secret is redacted by exact substring match, not by first
// hashing the haystack — a hash comparison can only ever confirm equality of
// two already-known values, never locate an unknown-length substring inside
// arbitrary free text. Instead, the "hashed comparison" the caller performs
// (recorded in the audit count, see below) is against sha256(value) so the
// count event that leaves the process never carries a byte of the plaintext,
// even though the in-process match itself must touch the plaintext to redact
// it — the same value already lives in secret-resolver's own cache in-process.

function knownSecretPatterns() {
  const values = __resolvedSecretValues().filter(
    (v) => typeof v === 'string' && v.length >= MIN_KNOWN_SECRET_LENGTH,
  );
  return values.map((value) => ({
    kind: 'known-secret',
    re: new RegExp(escapeRegExp(value), 'g'),
    hash: sha256(value),
  }));
}

// lib/providers/secret-audit-wiring.mjs already records the op:// reference
// itself (never the resolved value) under these exact key names as its
// value-free diagnostic contract — a bare op://vault/item/field pointer is
// not a secret, so the op-reference pattern must not clobber it there. Any
// other field carrying an op:// string (a tool result body, a raw env dump)
// is still redacted.

const OP_REF_EXEMPT_KEYS = new Set(['ref']);

// Walk every string reachable in `value`, applying every pattern in turn and
// replacing matches with `<redacted:kind>`. Returns the redacted clone plus a
// count-only tally (kind → number of matches) so the caller can audit that
// redaction occurred without ever recording the matched text.

function redactString(str, patterns, tally) {
  let out = str;
  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    const matches = out.match(re);
    if (matches && matches.length) {
      tally[kind] = (tally[kind] || 0) + matches.length;
      out = out.replace(re, `<redacted:${kind}>`);
    }
  }
  return out;
}

function redactValue(value, patterns, tally, key = null) {
  if (typeof value === 'string') {
    if (key && OP_REF_EXEMPT_KEYS.has(key)) {
      const rest = patterns.filter((p) => p.kind !== 'op-reference');
      return redactString(value, rest, tally);
    }
    return redactString(value, patterns, tally);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, patterns, tally));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Schema-marked redacted:true fields are already elided upstream by the
      // caller's own schema; this pass is a second, pattern-based net over
      // whatever free-text fields (detail, args, result, payload) remain.
      out[k] = redactValue(v, patterns, tally, k);
    }
    return out;
  }
  return value;
}

/**
 * Redact known secret values and token-shaped strings from an audit record.
 * Runs BEFORE the chain hash is computed so the signature always covers the
 * redacted form (redact-then-sign). Returns `{ record, tally }` where tally
 * is a count-only map of kind → matches (never the matched text).
 *
 * @param {object} partial
 * @returns {{record: object, tally: Record<string, number>}}
 */
export function redactRecord(partial) {
  const patterns = [...BUILTIN_PATTERNS, ...customPatterns, ...knownSecretPatterns()];
  const tally = {};
  const record = redactValue(partial, patterns, tally);
  return { record, tally };
}

// prev_line_hash and the append must be one atomic step or concurrent writers
// race; the file lock serializes them across processes.

export function appendAuditRecord(partial, { file = auditFile() } = {}) {
  const { record: redacted, tally } = redactRecord(partial);

  // Redaction is itself audited as a count only — never the secret — folded
  // into the record's own field before it is hashed and written, so the
  // signed line and the returned record always agree.

  if (Object.keys(tally).length) redacted.redaction_counts = tally;

  return withFileLockSync(file, () => {
    let prev = null;
    try {
      const last = readLastLineAcrossSegments(file);
      if (last !== null) prev = sha256(last);
    } catch { /* first record, or unreadable tail */ }
    const record = { ...redacted, prev_line_hash: prev };
    mkdirSync(dirname(file), { recursive: true });
    appendBounded('audit-trail', file, JSON.stringify(record) + '\n');
    return record;
  });
}

// A reset boundary seals the records it follows as legacy excluded from
// verification and re-bases the live chain from this line.

export function writeChainReset({ file = auditFile(), reason = 'manual reset' } = {}) {
  return appendAuditRecord({
    ts: new Date().toISOString(),
    chain_reset: true,
    reason,
    agent: 'construct',
    tool: null,
    target: null,
  }, { file });
}

export function readAuditTrail({ limit = 50, since = null, agent = null, tool = null } = {}) {
  if (!existsSync(auditFile())) return [];
  const lines = readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  const sinceMs = since ? new Date(since).getTime() : 0;
  const filtered = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (sinceMs && new Date(row.ts).getTime() < sinceMs) continue;
      if (agent && row.agent !== agent) continue;
      if (tool && row.tool !== tool) continue;
      filtered.push(row);
    } catch { /* skip malformed */ }
  }
  return filtered.slice(-limit);
}

export function verifyChain(file = auditFile()) {
  if (!existsSync(file)) return { ok: true, verified: 0, broken: [], legacy: 0 };
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

  // Validation starts at the last reset boundary; the prefix it seals is legacy
  // and exempt, so concurrency damage predating the migration can't fail the chain.

  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    try { if (JSON.parse(lines[i]).chain_reset) start = i; } catch { /* legacy malformed */ }
  }

  const broken = [];
  let prevHash = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    let row;
    try { row = JSON.parse(line); } catch {
      broken.push({ line: i + 1, reason: 'malformed JSON' });
      prevHash = sha256(line);
      continue;
    }
    if (i > start && !row.chain_reset && row.prev_line_hash !== prevHash) {
      broken.push({
        line: i + 1,
        expected: prevHash,
        actual: row.prev_line_hash,
        reason: 'prev_line_hash mismatch — chain break',
      });
    }
    prevHash = sha256(line);
  }
  return { ok: broken.length === 0, verified: lines.length - start, broken, legacy: start };
}

function formatRow(row) {
  const ts = row.ts?.replace('T', ' ').replace('Z', '') || '?';
  const agent = (row.agent || '?').padEnd(22);
  const tool = (row.tool || '?').padEnd(12);
  const task = row.task?.key ? `task=${row.task.key}` : '';
  const target = row.target || '';
  return `${ts}  ${agent}  ${tool}  ${task}${task && target ? '  ' : ''}${target}`;
}

export async function runAuditTrailCli(args = []) {
  const flags = new Set();
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--verify') flags.add('verify');
    else if (arg === '--reset') flags.add('reset');
    else if (arg.startsWith('--reason=')) options.reason = arg.slice(9);
    else if (arg === '--reason') options.reason = args[++i];
    else if (arg === '--json') flags.add('json');
    else if (arg === '--all') flags.add('all');
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg === '--limit') options.limit = Number(args[++i]);
    else if (arg.startsWith('--since=')) options.since = arg.slice(8);
    else if (arg === '--since') options.since = args[++i];
    else if (arg.startsWith('--agent=')) options.agent = arg.slice(8);
    else if (arg === '--agent') options.agent = args[++i];
    else if (arg.startsWith('--tool=')) options.tool = arg.slice(7);
    else if (arg === '--tool') options.tool = args[++i];
    else if (arg === '--help' || arg === '-h') flags.add('help');
  }

  if (flags.has('help')) {
    console.log(`Usage: construct audit trail [options]

Options:
  --limit N         Show only the last N records (default: 50, --all for everything)
  --all             Show all records
  --since <iso>     Filter to records on or after an ISO timestamp
  --agent <name>    Filter to a specific agent (e.g. cx-engineer)
  --tool <name>     Filter to a specific tool (Edit, Write, MultiEdit, NotebookEdit, Bash)
  --verify          Verify the tamper-evidence chain and exit
  --reset           Seal the current chain as legacy and re-base a fresh chain
  --reason <text>   Reason recorded on the --reset boundary
  --json            Emit raw JSONL lines instead of formatted output
  -h, --help        Show this message

Log location: ${auditFile()}
`);
    return;
  }

  if (flags.has('reset')) {
    writeChainReset({ reason: options.reason || 'manual reset' });
    console.log(`Audit chain re-based at ${auditFile()}. Prior records sealed as legacy; verification resumes from the new boundary.`);
    return;
  }

  if (flags.has('verify')) {
    const result = verifyChain();
    if (result.ok) {
      console.log(`Audit chain OK — ${result.verified} records verified.`);
      return;
    }
    console.error(`Audit chain BROKEN — ${result.broken.length} issue${result.broken.length === 1 ? '' : 's'} across ${result.verified} records:`);
    for (const b of result.broken) {
      console.error(`  line ${b.line}: ${b.reason}`);
    }
    process.exit(1);
  }

  if (!existsSync(auditFile())) {
    console.log(`No audit trail yet. Log will appear at ${auditFile()} once mutations occur.`);
    return;
  }

  const rows = readAuditTrail({
    limit: flags.has('all') ? Infinity : (options.limit || 50),
    since: options.since,
    agent: options.agent,
    tool: options.tool,
  });

  if (rows.length === 0) {
    console.log('No audit records match the current filter.');
    return;
  }

  if (flags.has('json')) {
    for (const r of rows) console.log(JSON.stringify(r));
    return;
  }

  const size = statSync(auditFile()).size;
  console.log(`Audit trail — ${rows.length} record${rows.length === 1 ? '' : 's'} (log ${Math.round(size / 1024)} KB at ${auditFile()})`);
  console.log('─'.repeat(100));
  for (const r of rows) console.log(formatRow(r));
  console.log('');
  console.log('Use --json for full records, --verify to check the tamper-evidence chain.');
}
