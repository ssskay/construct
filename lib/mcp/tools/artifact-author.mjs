/**
 * lib/mcp/tools/artifact-author.mjs — MCP `author_artifact` tool.
 *
 * OpenCode-reachable author pass: the calling agent is the model and supplies
 * the drafted typed-artifact markdown,
 * which gets materialized to its canonical path and run through the release gate.
 * Returns the path and a structured verdict so the agent can fix and re-call.
 *
 * Type resolution respects the manifest gate. A registered class (builtin,
 * user/project overlay, or the sanctioned `adhoc`) proceeds; an unknown
 * non-adhoc class returns a classification/registration result instead of
 * silently becoming a PRD. `adhoc` needs an explicit title + instructions and
 * is not a bypass for a known class — naming a registered type through adhoc
 * is redirected. allowScaffold stays off for a real author pass (a real draft
 * is required); `dry_run` flips it on to preview the resolved template or the
 * adhoc scaffold through the same gate without a live model.
 */
import { runConstructArtifactLoop } from '../../artifact-loop-core.mjs';
import { resolveArtifactType } from '../../artifact-manifest.mjs';
import { ADHOC_TYPE } from '../../artifact-manifest-overlay.mjs';
import { loadProjectConfig } from '../../config/project-config.mjs';
import { resolveContextBindings } from '../../orchestration/context-bindings.mjs';
import { synthesize } from '../../knowledge/synthesis.mjs';

// context_targets binds an author pass to registered source projects (B3): the
// ids are validated the same way orchestration runs validate theirs (unknown id
// → hard error before any authoring), and the multi-project synthesis context is
// assembled deterministically (dry-run map) and woven into the authoring input so
// the artifact draws on — and cites — every named project.
async function resolveContextBlock(args, cwd) {
  const contextTargets = args.context_targets;
  if (contextTargets == null || (Array.isArray(contextTargets) && contextTargets.length === 0)) {
    return { ok: true, block: '', bindings: [] };
  }
  const { config } = loadProjectConfig(cwd);
  let bindings;
  try {
    bindings = resolveContextBindings(contextTargets, { config, cwd });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const ask = String(args.subject || args.text || args.instructions || args.title || 'synthesize across the bound projects').trim();
  const projects = bindings.map((b) => b.id).join(',');
  const synth = await synthesize({ projects, ask, cwd, dryRun: true });
  const block = synth.ok ? `\n\n## Cross-project context (cite as project:path)\n\n${synth.context}` : '';
  return { ok: true, block, bindings };
}

function toResult(result) {
  return {
    ok: Boolean(result.ok),
    artifact_type: result.artifactType,
    path: result.relPath,
    written: !result.draftMissing,
    gate: result.validation?.ok ? 'PASS' : 'FAIL',
    errors: result.validation?.errors || [],
    warnings: result.validation?.warnings || [],
    workflow_plan: (result.invokePlan?.selectedRoles || []).map((r) => `cx-${r}`),
    summary: result.summary,
    provenance: result.provenance || null,
  };
}

async function authorAdhoc(args, { ROOT_DIR, cwd, dryRun, contextBlock = '' }) {
  const title = String(args.title || '').trim();
  const instructions = String(args.instructions || '').trim();
  if (!title || !instructions) {
    return {
      ok: false,
      artifact_type: ADHOC_TYPE,
      status: 'invalid-request',
      errors: ['adhoc requires an explicit title and instructions'],
      guidance: 'Call author_artifact with {type:"adhoc", title, instructions}. For a registered class, pass its type instead.',
    };
  }

  // Guard R3: adhoc is for genuinely unstructured one-offs. When the caller
  // names a registered class (via `for_type` or an exact-match title), redirect
  // to that class so adhoc never becomes a bypass for a gated type.
  const namedType = String(args.for_type || '').trim().toLowerCase() || title.toLowerCase();
  const named = resolveArtifactType(namedType, { rootDir: ROOT_DIR, cwd });
  if (named.status === 'registered' && named.type !== ADHOC_TYPE) {
    return {
      ok: false,
      artifact_type: ADHOC_TYPE,
      status: 'redirect',
      redirect_to: named.type,
      warnings: [`'${named.type}' is a registered class; author it directly instead of via adhoc.`],
      guidance: `Call author_artifact with {type:"${named.type}", ...} to use its template and release gate.`,
    };
  }

  const draftMarkdown = args.draft_markdown || args.draft || '';
  const result = await runConstructArtifactLoop({
    draftMarkdown,
    artifactType: ADHOC_TYPE,
    titleOverride: title,
    instructions,
    text: `${args.subject || args.text || instructions}${contextBlock}`,
    cwd,
    rootDir: ROOT_DIR,
    explicit: true,
    allowScaffold: dryRun || !draftMarkdown,
  });
  return toResult(result);
}

export async function authorArtifact(args = {}, { ROOT_DIR } = {}) {
  const cwd = args.cwd || process.cwd();
  const dryRun = args.dry_run === true || args.scaffold === true;
  const requestedType = String(args.artifact_type || '').trim().toLowerCase();

  const ctx = await resolveContextBlock(args, cwd);
  if (!ctx.ok) {
    return { ok: false, artifact_type: requestedType || null, status: 'invalid-context-target', errors: [ctx.error] };
  }

  if (requestedType === ADHOC_TYPE || requestedType === 'ad-hoc' || requestedType === 'free-form' || requestedType === 'freeform') {
    return authorAdhoc(args, { ROOT_DIR, cwd, dryRun, contextBlock: ctx.block });
  }

  // Gate intact (R4): an explicitly requested class that resolves to nothing
  // registered gets the classification/registration answer, not a PRD.
  if (requestedType) {
    const resolved = resolveArtifactType(requestedType, { rootDir: ROOT_DIR, cwd });
    if (resolved.status !== 'registered') {
      return {
        ok: false,
        artifact_type: requestedType,
        status: 'unrecognized',
        classification_required: true,
        errors: [`Document class '${requestedType}' is not registered.`],
        guidance: `${resolved.guidance} Register it with \`construct templates register ${requestedType}\`, or author a one-off with {type:"adhoc", title, instructions}.`,
      };
    }
  }

  const draftMarkdown = args.draft_markdown || args.draft || '';
  const result = await runConstructArtifactLoop({
    draftMarkdown,
    artifactType: args.artifact_type,
    text: `${args.subject || args.text || ''}${ctx.block}`,
    cwd,
    rootDir: ROOT_DIR,
    explicit: true,
    allowScaffold: dryRun,
  });

  return toResult(result);
}
