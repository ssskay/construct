#!/usr/bin/env node
/**
 * lib/hooks/agent-tracker.mjs — Task tool lifecycle hook: records dispatch +
 * outcome and enqueues `next:cx-<role>` handoffs.
 *
 * Runs as PostToolUse after Task. Writes the agent-log to the project-scoped
 * .construct/agent-log.jsonl, captures success/failure observations under
 * .construct/observations/, and enqueues handoffs into ~/.cx/role-pending.jsonl
 * (kept user-scope because a handoff may legitimately span projects; each
 * entry carries a projectId tag for attribution).
 *
 * Handoffs also emit a `handoff.received` lifecycle event via the role
 * event-bus for observability. The direct role-pending write stays the
 * source of truth until the gateway becomes an event-bus consumer; the
 * emit is the bridge that makes the dispatch observable through the same
 * surface as every other lifecycle event.
 *
 * @p95ms 15
 * @maxBlockingScope none (PostToolUse, non-blocking)
 *
 * @lifecycle PostToolUse
 * @matcher  Task
 * @exits 0 = pass
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendBounded } from '../logging/rotate.mjs';
import { resolveProjectScopedPath } from '../project-root.mjs';
import { emit as emitRoleEvent } from '../roles/event-bus.mjs';
import { doctorRoot } from '../config/xdg.mjs';
import { logHookFailure } from './_lib/log.mjs';

// How long a refreshed .construct/outcomes/_summary.json is trusted before the A3 block below
// rebuilds it — declared ahead of the main flow since this is a top-level-await script and a
// const referenced before its own declaration line executes throws (temporal dead zone), even
// though the function that closes over it is hoisted. Short by design: aggregateOutcomes always
// rebuilds every role from the full JSONL source of truth (measured ~85ms at the 20-role/10k-line
// rotation ceiling, sub-millisecond at realistic scale), so this window only needs to debounce
// truly-adjacent duplicate fires, not smooth over a heavy recompute. recordOutcome itself is never
// debounced — every dispatch is durably recorded regardless of whether this refresh runs.

const OUTCOME_SUMMARY_STALE_MS = 2_000;

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

const toolName = input?.tool_name || '';
if (toolName !== 'Task') process.exit(0);

const toolInput = input?.tool_input || {};
const toolResult = input?.tool_result || {};

// Extract agent identity from the Task tool input.
// Claude Code passes subagent_type or description in tool_input.
const agentType = toolInput?.subagent_type || toolInput?.agent || null;
const description = toolInput?.description || toolInput?.prompt || '';

// Prefer subagent_type (e.g. "cx-engineer"), fall back to first cx-* token in description.
let agentName = agentType;
if (!agentName) {
  const descMatch = /^(cx-[a-z-]+|construct)/i.exec(description.trim());
  agentName = descMatch ? descMatch[1].toLowerCase() : 'subagent';
}

// Extract success/failure indicators from result
const resultText = toolResult?.result || '';
const successIndicators = ['success', 'completed', 'finished', 'done', '✅', '✔'];
const errorIndicators = ['error', 'failed', 'failure', '❌', '✗', 'exception', 'timed out'];
const warningIndicators = ['warning', 'warn', '⚠', 'note:', 'attention'];

let outcome = 'unknown';
let success = null;

const lowerResult = resultText.toLowerCase();
if (errorIndicators.some(ind => lowerResult.includes(ind))) {
  outcome = 'error';
  success = false;
} else if (warningIndicators.some(ind => lowerResult.includes(ind))) {
  outcome = 'warning';
  success = null;
} else if (successIndicators.some(ind => lowerResult.includes(ind))) {
  outcome = 'success';
  success = true;
}

// Record agent invocation
try {
  const cxDir = doctorRoot();
  mkdirSync(cxDir, { recursive: true });
  
  // Update last-agent files for coordination (shared + per-agent). agentId is
  // best-effort (null on hosts that don't populate it on this event) — it lets
  // guard-bash's role-fence check prove that a LATER command's own agent_id
  // is the same subagent this dispatch was for, rather than fencing anyone
  // riding a fresh timestamp (construct-7164).
  const agentEntry = { agent: agentName, agentId: input?.agent_id ?? null, coordination: 'tracker-plus-plan', ts: new Date().toISOString(), outcome, description: description.slice(0, 200) };
  writeFileSync(join(cxDir, 'last-agent.json'), JSON.stringify(agentEntry));
  // Per-agent file prevents one agent dispatch from resetting another's fence
  // window. Keyed by persona id with the cx- prefix stripped, matching
  // guard-bash's CONSTRUCT_AGENT_ID lookup (construct-diq1).
  const safeName = agentName.replace(/^cx-/, '').replace(/[^a-z0-9._-]/gi, '_');
  writeFileSync(join(cxDir, `last-agent-${safeName}.json`), JSON.stringify(agentEntry));
  
  // Per-project agent log (was ~/.cx/agent-log.jsonl which mixed every
  // project's dispatches into one stream). Falls back to ~/.cx/ when the
  // hook fires outside a Construct project.

  const agentLogFile = resolveProjectScopedPath('agent-log.jsonl', { ensureDir: false });
  const logEntry = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    outcome,
    success,
    description: description.slice(0, 500),
    resultLength: resultText.length,
    toolInputKeys: Object.keys(toolInput).filter(k => !k.includes('secret') && !k.includes('password') && !k.includes('token'))
  };
  
  appendBounded('agent-log', agentLogFile, JSON.stringify(logEntry) + '\n');
  
  // Record observation for pattern learning (only if we have meaningful outcome)
  if (outcome !== 'unknown' && description.length > 10) {
    const observationsDir = join(cxDir, 'observations', 'agent-outcomes');
    mkdirSync(observationsDir, { recursive: true });
    
    const observationFile = join(observationsDir, `${Date.now()}-${agentName}.json`);
    
    // Categorize as pattern or anti-pattern based on outcome
    const category = success === true ? 'pattern' : 
                    success === false ? 'anti-pattern' : 'observation';
    
    const summary = success === true 
      ? `${agentName} successfully completed: ${description.slice(0, 100)}`
      : success === false
      ? `${agentName} failed: ${description.slice(0, 100)}`
      : `${agentName} executed with warnings: ${description.slice(0, 100)}`;
    
    const observation = {
      role: 'agent-tracker',
      category,
      summary,
      content: `${agentName} was invoked with description: "${description.slice(0, 500)}"\n\nOutcome: ${outcome}\nResult length: ${resultText.length} chars`,
      tags: ['agent-invocation', agentName, outcome],
      confidence: 0.8,
      timestamp: new Date().toISOString()
    };
    
    writeFileSync(observationFile, JSON.stringify(observation, null, 2) + '\n');
    
    // Also record in vector-ready format for learning system
    if (success !== null) {
      const learningDir = join(cxDir, 'learning', agentName);
      mkdirSync(learningDir, { recursive: true });

      const learningFile = join(learningDir, `${Date.now()}-${success ? 'success' : 'failure'}.json`);
      const learningEntry = {
        agent: agentName,
        success,
        description,
        outcome,
        timestamp: new Date().toISOString(),
        keywords: extractKeywords(description),
        taskType: classifyTaskType(description)
      };

      writeFileSync(learningFile, JSON.stringify(learningEntry, null, 2) + '\n');
    }

    // A3 outcome capture: record the per-project outcome JSONL that feeds
    // .construct/outcomes/_summary.json and the recruiter's tiebreaker (ADR-0076).
    // Best-effort; any failure leaves the existing telemetry paths above untouched.
    if (success !== null) {
      try {
        const { recordOutcome } = await import('../outcomes/record.mjs');
        const { resolveActiveScope } = await import('../scopes/loader.mjs');
        const roleId = agentName.replace(/^cx-/, '');
        const projectCwd = input?.cwd || process.cwd();
        const activeProfile = resolveActiveScope(projectCwd);
        recordOutcome(projectCwd, {
          role: roleId,
          success,
          notes: outcome,
          source: 'agent-tracker',
          profile: activeProfile?.id ?? null,
          sessionId: input?.session_id ?? input?.sessionId ?? null,
        });
        await refreshOutcomeSummaryIfStale(projectCwd, roleId);
      } catch { /* best effort */ }
    }
  }
  
} catch (err) {
  logHookFailure({ hook: 'agent-tracker', err, phase: 'main' });
}

// Auto-enqueue handoff when a completing persona's result references
// `next:cx-<role>` and the target persona is onboarded in the role framework.
// The next session-start will pick up the queued entry and dispatch via Task.

try {
  if (process.env.CONSTRUCT_ROLES !== 'off' && agentName && /^cx-/.test(agentName)) {
    const matches = [...resultText.matchAll(/\bnext:cx-([a-z][a-z-]+)\b/g)].map((m) => m[1]);
    const unique = [...new Set(matches)];
    if (unique.length > 0) {
      const { isOnboarded, loadManifest } = await import('../roles/manifest.mjs');
      // role-pending stays at user scope (a handoff might span projects),
      // but each entry gets a projectId tag so a reader can attribute it.

      const pendingPath = join(doctorRoot(), 'role-pending.jsonl');
      const { resolveProjectScope } = await import('../project-root.mjs');
      const scope = resolveProjectScope();
      const bdMatch = /\b(construct-[a-z0-9]+)\b/i.exec(resultText) || [];
      const bdIssueId = bdMatch[1] || null;
      for (const targetId of unique) {
        if (!isOnboarded(targetId)) continue;
        const manifest = loadManifest(targetId);
        const summary = `Handoff from ${agentName}${bdIssueId ? ` (re ${bdIssueId})` : ''}`;
        const entry = {
          ts: Date.now(),
          personaId: targetId,
          cxId: `cx-${targetId}`,
          bdIssueId,
          fingerprint: `handoff-${agentName}-${targetId}-${Date.now().toString(36)}`,
          eventType: 'handoff.received',
          summary,
          killSwitchEnv: manifest?.killSwitchEnv || '',
          handoffFrom: agentName,
          ...(scope?.projectId ? { projectId: scope.projectId } : {}),
        };
        appendBounded('role-pending', pendingPath, JSON.stringify(entry) + '\n');

        // Mirror the handoff to the event bus so the dispatch is observable
        // alongside every other lifecycle event. Best-effort: a bus failure
        // does not affect the role-pending source of truth above.
        try {
          emitRoleEvent('handoff.received', {
            project: scope?.projectId || '',
            summary,
            context: {
              targetCxId: `cx-${targetId}`,
              handoffFrom: agentName,
              bdIssueId,
            },
          });
        } catch { /* swallow */ }
      }
    }
  }
} catch (err) {
  logHookFailure({ hook: 'agent-tracker', err, phase: 'handoff' });
}

// A3 summary freshness: keeps .construct/outcomes/_summary.json current for the recruiter's
// outcomeBoost tiebreaker without a full rebuild on every single dispatch. The skip check is keyed
// on THIS dispatch's role, not just the file's mtime — several distinct roles dispatching within
// the same debounce window must each still get their first rebuild, or every role but the first to
// ever fire stays permanently absent from the summary.

async function refreshOutcomeSummaryIfStale(cwd, roleId) {
  const { configPath } = await import('../config-dir.mjs');
  const { readSummary } = await import('../outcomes/aggregate.mjs');
  const summaryPath = configPath(cwd, 'outcomes', '_summary.json');
  try {
    const { mtimeMs } = statSync(summaryPath);
    const fresh = Date.now() - mtimeMs < OUTCOME_SUMMARY_STALE_MS;
    if (fresh && readSummary(cwd)?.roles?.[roleId]) return;
  } catch { /* missing summary — build it below */ }
  const { aggregateOutcomes } = await import('../outcomes/aggregate.mjs');
  aggregateOutcomes(cwd);
}

// Helper functions for learning system
function extractKeywords(text) {
  const commonStop = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
  const words = text.toLowerCase().split(/[\s\.,;!?]+/).filter(word => 
    word.length > 2 && !commonStop.includes(word) && /^[a-z]+$/.test(word)
  );
  
  // Count frequency
  const freq = {};
  words.forEach(word => freq[word] = (freq[word] || 0) + 1);
  
  // Return top 5 keywords
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

function classifyTaskType(description) {
  const lower = description.toLowerCase();
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) return 'bug-fix';
  if (lower.includes('implement') || lower.includes('create') || lower.includes('add')) return 'implementation';
  if (lower.includes('refactor') || lower.includes('improve') || lower.includes('optimize')) return 'refactoring';
  if (lower.includes('review') || lower.includes('audit') || lower.includes('check')) return 'review';
  if (lower.includes('test') || lower.includes('verify') || lower.includes('validate')) return 'testing';
  if (lower.includes('document') || lower.includes('write') || lower.includes('readme')) return 'documentation';
  if (lower.includes('research') || lower.includes('analyze') || lower.includes('investigate')) return 'research';
  return 'other';
}

process.exit(0);
