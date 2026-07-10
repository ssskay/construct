/**
 * lib/orchestration/flow-selection.mjs — specialist/flow selection for
 * orchestration routing policy: which specialists run, in what order,
 * parallel checks, proactive triggers, and the top-level routeRequest/
 * routeRequestVerified/buildConstructToOrchestratorPacket entry points.
 *
 * Extracted from lib/orchestration-policy.mjs (construct-rf26.10). This is
 * the module that composes classification.mjs (what kind of request) and
 * gates.mjs (what must be true first) into a concrete dispatch plan.
 * orchestration-policy.mjs re-exports these unchanged for existing callers.
 */
import { resolveContractChain } from '../specialist-contracts.mjs';
import { verifyRoute } from '../intent-classifier.mjs';
import { evaluateWatchConditions } from './routing-tables.mjs';
import { resolveArtifactWorkflowContract } from '../artifact-manifest.mjs';
import { buildResearchExecutionPolicy } from '../research-execution-policy.mjs';
import { EXECUTION_TRACKS, INTENT_CLASSES, WORK_CATEGORIES } from './policy-constants.mjs';
import {
  classifyEngineerFlavor, isExplorerRequest, isProductIntelligenceRequest,
  isDataAnalysisRequest, isDataEngineeringRequest, detectDocAuthoringIntent,
  isLegalComplianceRequest, isBusinessStrategyRequest, isOperationsPlanningRequest,
  isRdLeadRequest, containsAny, detectRiskFlags, classifyWorkCategory,
  classifyIntent, classifyRoleFlavors, classifyProductManagerFlavor,
  isVisualDeliverableRequest, determineExecutionTrack,
} from './classification.mjs';
import {
  requiresExternalResearch, requiresFramingChallenge,
  resolveArtifactReviewRequirements, teamRoutingForSpecialists,
} from './gates.mjs';
import { loadSignalDimensions } from './signal-dimensions.mjs';

const SPECIALIST_MAP = {
  implementation: ['cx-engineer'],
  investigation: ['cx-debugger', 'cx-engineer'],
  evaluation: ['cx-reviewer'],
  fix: ['cx-debugger', 'cx-engineer'],
  research: ['cx-researcher'],
};

const WORKFLOW_SKILL_TO_TYPE = {
  'docs/prd-workflow': 'prd-draft',
  'docs/adr-workflow': 'architecture-review',
  'docs/research-workflow': 'research-synthesis',
  'docs/evidence-ingest-workflow': 'evidence-ingest',
};

// AI/platform/data engineering are skill bundles on the single cx-engineer
// specialist, not separate dispatch targets, so specialist selection never
// substitutes a flavor-specific id here. The engineer flavor is still
// detected via classifyEngineerFlavor()/classifyRoleFlavors() and drives
// which skills/roles/*.md overlay loads onto cx-engineer — see
// lib/roles/flavor-bindings.mjs for that binding.
function refineEngineeringSpecialists(specialists) {
  return specialists;
}

function suggestWorkflowType({ intent, request = '', docAuthoring } = {}) {
  const text = String(request).toLowerCase();
  const localWalkthrough = isExplorerRequest(request)
    || /\b(?:explain|understand|what does|what is)\b[\s\S]{0,60}\b(?:how\b|do\b|does\b|works?\b|flow\b|path\b|layer\b|module\b|implementation\b|code\b|function\b)/i.test(text)
    || /\bhow\b[\s\S]{0,40}\bworks?\b/i.test(text);
  if (intent === INTENT_CLASSES.research && !localWalkthrough) {
    return 'research-synthesis';
  }
  if (docAuthoring?.docType) {
    const contract = resolveArtifactWorkflowContract(docAuthoring.docType);
    const workflowType = WORKFLOW_SKILL_TO_TYPE[contract?.workflowSkill];
    if (workflowType) return workflowType;
  }
  return null;
}

export function selectSpecialists({ request = '', intent, track, riskFlags = detectRiskFlags(request), workCategory = classifyWorkCategory(request, riskFlags) } = {}) {
  const text = String(request).toLowerCase();
  const productRequest = isProductIntelligenceRequest(text);
  const dataAnalysisRequest = isDataAnalysisRequest(text);
  const dataEngineeringRequest = isDataEngineeringRequest(text);
  if (track === EXECUTION_TRACKS.immediate) return [];
  if (track === EXECUTION_TRACKS.focused) {
    if (workCategory === WORK_CATEGORIES.visual || riskFlags.ui) return ['cx-designer'];
    if (productRequest) return ['cx-product-manager'];
    const docAuthoring = detectDocAuthoringIntent(text);
    if (docAuthoring?.owner) return [docAuthoring.owner];
    if (dataEngineeringRequest) return ['cx-engineer'];
    if (dataAnalysisRequest) return ['cx-data-analyst'];
    if (isLegalComplianceRequest(text)) return ['cx-security'];
    if (isBusinessStrategyRequest(text)) return ['cx-product-manager'];
    if (isOperationsPlanningRequest(text)) return ['cx-operations'];
    if (isRdLeadRequest(text)) return ['cx-architect'];
    if (isExplorerRequest(text)) return ['cx-researcher'];
    if (riskFlags.docs) return ['cx-operations'];
    if (riskFlags.security && intent === INTENT_CLASSES.evaluation) return refineEngineeringSpecialists(['cx-security'], request);
    return refineEngineeringSpecialists(SPECIALIST_MAP[intent] || ['cx-engineer'], request);
  }

  const specialists = ['cx-architect'];
  if (intent === INTENT_CLASSES.fix || intent === INTENT_CLASSES.investigation) specialists.push('cx-debugger');
  if (intent === INTENT_CLASSES.research) specialists.push('cx-researcher');
  const docAuthoring = detectDocAuthoringIntent(text);
  if (docAuthoring?.owner) specialists.push(docAuthoring.owner);
  if (workCategory === WORK_CATEGORIES.visual || riskFlags.ui) specialists.push('cx-designer');
  if (productRequest) specialists.push('cx-product-manager');
  if (dataAnalysisRequest) specialists.push('cx-data-analyst');
  if (dataEngineeringRequest) specialists.push('cx-engineer');
  else if (riskFlags.docs) specialists.push('cx-operations');
  specialists.push('cx-engineer', 'cx-reviewer', 'cx-qa');
  if (riskFlags.security || riskFlags.dataIntegrity) specialists.push('cx-security');
  return refineEngineeringSpecialists(Array.from(new Set(specialists)), request);
}

export function augmentSpecialists(
  specialists = [],
  {
    request = '',
    docAuthoring = null,
    externalResearch = null,
    framingChallenge = null,
    artifactReview = null,
    triggers = [],
  } = {},
) {
  let list = [...specialists];
  if (docAuthoring?.owner && !list.includes(docAuthoring.owner)) {
    list = [docAuthoring.owner, ...list];
  }
  if (externalResearch?.required && !list.includes('cx-researcher')) {
    list = ['cx-researcher', ...list];
  }
  if (framingChallenge?.required && !list.includes('cx-reviewer')) {
    list = ['cx-reviewer', ...list];
  }
  for (const reviewer of artifactReview?.requiredReviewers || []) {
    if (!list.includes(reviewer)) list = [...list, reviewer];
  }
  if (isLegalComplianceRequest(request) && !list.includes('cx-security')) {
    list = ['cx-security', ...list];
  }
  if (isRdLeadRequest(request) && !list.includes('cx-architect')) {
    list = ['cx-architect', ...list];
  }
  if (isBusinessStrategyRequest(request) && !list.includes('cx-product-manager')) {
    list = ['cx-product-manager', ...list];
  }
  for (const { specialist } of triggers) {
    if (!list.includes(specialist)) list = [specialist, ...list];
  }
  return Array.from(new Set(list));
}

function enrichPolicyForProjectQuestion(request, policySpecialists = []) {
  if (!/\b(what is this (project|repo|codebase)|what('s| is) this (project|repo|codebase)|describe this (project|repo|codebase))\b/i.test(String(request))) {
    return policySpecialists;
  }
  const list = [...policySpecialists];
  if (!list.includes('cx-researcher')) list.unshift('cx-researcher');
  return Array.from(new Set(list));
}

/**
 * Identify specialists that can run in parallel with implementation.
 * Returns an array of specialist names that should execute concurrently
 * rather than sequentially. This reduces latency for independent checks.
 * 
 * Parallel execution is safe when:
 * - The specialist only reads/analyzes (doesn't mutate)
 * - Their output doesn't depend on implementation completing first
 * - They provide early feedback that can shape implementation
 */
export function identifyParallelChecks({ request = '', riskFlags = detectRiskFlags(request), workCategory = classifyWorkCategory(request, riskFlags) } = {}) {
  const parallelChecks = [];
  const text = String(request).toLowerCase();
  
  // Security review can run parallel to implementation for early threat detection
  if (riskFlags.security || containsAny(text, ['auth', 'permission', 'secret', 'payment', 'pii'])) {
    parallelChecks.push('cx-security');
  }
  
  // Accessibility review can run parallel for UI work
  if (workCategory === WORK_CATEGORIES.visual || riskFlags.ui || containsAny(text, ['ui', 'ux', 'interface', 'component'])) {
    parallelChecks.push('cx-designer');
  }

  // Performance review for data-intensive operations
  if (containsAny(text, ['performance', 'latency', 'throughput', 'scale', 'optimization'])) {
    parallelChecks.push('cx-operations');
  }

  // Legal compliance for regulated domains — same specialist as the security
  // check above (legal-compliance folded into cx-security), so dedupe.
  if (isLegalComplianceRequest(request) && !parallelChecks.includes('cx-security')) {
    parallelChecks.push('cx-security');
  }


  return parallelChecks;
}

// Structured request signals computed once and fed to both selectSpecialists
// and the proactive-trigger pass. Centralises every cheap signal so specialists
// don't each re-derive them from raw text. Returned shape is stable — additive
// only.

export function requestSignals(request = '', context = {}) {
  const text = String(request).toLowerCase();
  const riskFlags = detectRiskFlags(request);
  const intent = classifyIntent(request);
  const workCategory = classifyWorkCategory(request, riskFlags);

  const ambiguityIndicators = [
    'maybe', 'something like', 'figure out', 'somehow', 'sort of', 'kind of', 'idea', 'rough', 'tbd',
    'we should probably', 'not sure', 'thinking about',
  ];
  const namedConstraintIndicators = [
    'must not', 'cannot exceed', 'has to', 'deadline', 'budget', 'within', 'no later than',
    'maximum', 'minimum', 'sla', 'p95', 'p99',
  ];
  const blastRadiusWide = [
    'all users', 'every user', 'global', 'org-wide', 'company-wide', 'breaking change',
    'migration', 'mass update', 'backfill', 'destructive',
  ];
  const blastRadiusMedium = [
    'feature flag', 'beta cohort', 'experiment', 'rollout', 'shadow',
  ];

  const ambiguityHits = ambiguityIndicators.filter((kw) => text.includes(kw)).length;
  const ambiguityScore = Math.min(1, ambiguityHits / 3);

  let blastRadius = 'narrow';
  if (containsAny(text, blastRadiusWide)) blastRadius = 'wide';
  else if (containsAny(text, blastRadiusMedium)) blastRadius = 'medium';

  // Registry-declared signal dimensions (lib/orchestration/signal-dimensions.mjs)
  // computed generically so adding a dimension needs no edit here.
  const dimensionSignals = {};
  for (const { key, keywords } of loadSignalDimensions()) {
    dimensionSignals[key] = containsAny(text, keywords);
  }

  return {
    intent,
    workCategory,
    riskFlags,
    ambiguityScore,
    hasSuccessMetric: containsAny(text, ['success metric', 'kpi', 'target metric', 'goal metric', 'acceptance criteria']),
    hasNamedConstraints: containsAny(text, namedConstraintIndicators),
    blastRadius,
    authOrPayments: containsAny(text, ['auth', 'authentication', 'authorization', 'payment', 'pii', 'personal data', 'compliance']),
    visualDeliverable: isVisualDeliverableRequest(text),
    namedUsers: context?.namedUsers || [],
    ...dimensionSignals,
  };
}

// Signal-driven proactive triggers. Returns a list of { specialist, reason }
// pairs for specialists that should engage PRE-DISPATCH based on signals —
// separate from the keyword-only paths in selectSpecialists. The watch
// predicates and their specialist owners are declared in
// specialists/org (watchConditions) and evaluated by
// orchestration/routing-tables.mjs.

export function proactiveTriggers(signals) {
  return evaluateWatchConditions(signals).map(({ specialist, reason }) => ({ specialist, reason }));
}

// Format active flavor overlays into a one-line trace, e.g.
//   "Overlays: architect=platform (matched kubernetes, infra), engineer=ai (matched llm, agent)"

export function formatOverlayTrace(roleFlavors = {}, request = '') {
  const text = String(request).toLowerCase();
  const active = Object.entries(roleFlavors).filter(([, flavor]) => flavor);
  if (active.length === 0) return '';
  const FLAVOR_KEYWORDS = {
    architect: ['agent', 'rag', 'retrieval', 'embedding', 'integration', 'webhook', 'warehouse', 'schema', 'sso', 'rbac', 'platform', 'kubernetes', 'infra'],
    productManager: ['platform', 'api', 'enterprise', 'ai product', 'agent', 'growth', 'activation'],
    qa: ['agent', 'prompt', 'api', 'sdk', 'pipeline', 'etl', 'ui', 'ux', 'accessibility'],
    security: ['prompt injection', 'privacy', 'pii', 'dependency', 'cloud', 'iam', 'auth', 'xss', 'csrf'],
    dataAnalyst: ['experiment', 'a/b', 'telemetry', 'metric', 'funnel'],
    dataEngineer: ['vector', 'embedding', 'warehouse', 'pipeline', 'etl', 'pgvector'],
    engineer: ['llm', 'agent', 'rag', 'kubernetes', 'k8s', 'terraform', 'infra', 'docker', 'pipeline', 'etl', 'data model'],
  };
  const parts = active.map(([role, flavor]) => {
    const kws = (FLAVOR_KEYWORDS[role] || []).filter((kw) => text.includes(kw));
    const matched = kws.slice(0, 3).join(', ');
    return matched ? `${role}=${flavor} (matched ${matched})` : `${role}=${flavor}`;
  });
  return `Overlays: ${parts.join(', ')}`;
}

export function routeRequest(options = {}) {
  const intent = classifyIntent(options.request);
  const riskFlags = detectRiskFlags(options.request);
  const roleFlavors = classifyRoleFlavors(options.request);
  const productFlavor = isProductIntelligenceRequest(options.request)
    ? classifyProductManagerFlavor(options.request)
    : null;
  const workCategory = classifyWorkCategory(options.request, riskFlags);
  const track = determineExecutionTrack({ ...options, riskFlags });
  const docAuthoring = detectDocAuthoringIntent(options.request);
  const externalResearch = requiresExternalResearch({ request: options.request, workCategory, riskFlags });
  const framingChallenge = requiresFramingChallenge({ request: options.request, workCategory, riskFlags, introducesContract: options.introducesContract });
  const artifactReview = resolveArtifactReviewRequirements(docAuthoring);
  const suggestedWorkflowType = suggestWorkflowType({ intent, request: options.request, docAuthoring });
  const researchExecutionPolicy = intent === INTENT_CLASSES.research || externalResearch?.required
    ? buildResearchExecutionPolicy({ request: options.request })
    : null;
  const signals = requestSignals(options.request, options.context);
  const triggers = proactiveTriggers(signals);
  const reasons = {};
  for (const { specialist, reason } of triggers) {
    reasons[specialist] = reason;
  }

  const augmentOpts = {
    request: options.request,
    docAuthoring,
    externalResearch,
    framingChallenge,
    artifactReview,
    triggers,
  };

  let specialists = augmentSpecialists(
    selectSpecialists({ ...options, intent, track, riskFlags, workCategory }),
    augmentOpts,
  );

  const policyTrack = track === EXECUTION_TRACKS.immediate ? EXECUTION_TRACKS.focused : track;
  let policySpecialists = augmentSpecialists(
    selectSpecialists({ ...options, intent, track: policyTrack, riskFlags, workCategory }),
    augmentOpts,
  );
  policySpecialists = enrichPolicyForProjectQuestion(options.request, policySpecialists);

  const displaySpecialists = specialists.length ? specialists : policySpecialists;

  const contractChain = resolveContractChain({
    intent,
    workCategory,
    track,
    riskFlags,
    specialists: displaySpecialists,
    framingChallenge,
    externalResearch,
    docAuthoring,
    artifactReview,
  });

  // Team-aware routing: analyze specialist-to-team mapping and identify
  // team involvement, primary owner, required approvals, and escalation paths.
  const teamRouting = teamRoutingForSpecialists(displaySpecialists, {
    intent,
    request: options.request,
    cwd: options.cwd ?? null,
    docAuthoring,
  });

  const route = {
    intent,
    workCategory,
    track,
    riskFlags,
    productFlavor,
    roleFlavors,
    specialists,
    policySpecialists,
    displaySpecialists,
    signals,
    triggers,
    dispatchReasons: reasons,
    docAuthoring,
    externalResearch,
    framingChallenge,
    artifactReview,
    suggestedWorkflowType,
    researchExecutionPolicy,
    contractChain,
    teamRouting,
  };

  if (process.env.CONSTRUCT_VERBOSE === '1' && triggers.length > 0) {
    for (const { specialist, reason } of triggers) {
      console.error(`[route] proactive: ${specialist} (${reason})`);
    }
  }

  return route;
}

// Sync wrapper that returns the keyword route immediately and fires the
// LLM intent verifier in the background. The verifier writes its verdict
// to ~/.cx/intent-verifications.jsonl for offline tuning; the dispatched
// route never waits on a model round-trip. Disable the background call
// entirely with CONSTRUCT_INTENT_VERIFY=off — see lib/intent-classifier.mjs.
export function routeRequestVerified(options = {}) {
  const route = routeRequest(options);
  return verifyRoute(route, { request: options.request, modelCaller: options.modelCaller });
}

/**
 * Build the construct→orchestrator contract packet (specialists/org).
 * Callers must pass this object to agent_contract — not a bare goal string.
 */
export function buildConstructToOrchestratorPacket(options = {}) {
  const request = String(options.request || '');
  const route = options.route || routeRequest({
    request,
    fileCount: options.fileCount ?? 0,
    moduleCount: options.moduleCount ?? 0,
    introducesContract: options.introducesContract ?? false,
    explicitDrive: options.explicitDrive ?? false,
  });
  if (route.track === EXECUTION_TRACKS.immediate) return null;

  const goal = String(options.goal || request || '').trim() || 'User-requested work';
  const acceptanceCriteria = Array.isArray(options.acceptanceCriteria) && options.acceptanceCriteria.length
    ? options.acceptanceCriteria
    : ['Dispatch plan emitted with specialists in sequence', 'Acceptance criteria verified before close'];

  return {
    goal,
    intent: route.intent,
    workCategory: route.workCategory,
    riskFlags: route.riskFlags || {},
    suggestedWorkflowType: route.suggestedWorkflowType || null,
    acceptanceCriteria,
  };
}
