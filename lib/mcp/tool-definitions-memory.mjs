/**
 * lib/mcp/tool-definitions-memory.mjs — raw tool schemas: memory, scope/outcomes/knowledge, provider fetch/write, document export.
 *
 * Pure data: name/description/inputSchema/outputSchema for a slice of the
 * hardcoded (non-self-registered) MCP tool catalog. Split out of
 * lib/mcp/tool-definitions.mjs (which itself was split out of
 * lib/mcp/server.mjs) purely to keep each file under the ~600-line
 * house limit — no behavior differs from one combined array.
 * lib/mcp/server.mjs concatenates every slice and applies
 * withSafetyEnvelope (lib/mcp/tool-safety.mjs) at load time.
 */
export const TOOL_DEFS_MEMORY = [
    {
      name: 'memory_search',
      outputSchema: { type: 'object' },
      category: 'retrieval',
      description: 'Search the observation store for patterns, decisions, and insights learned by specialists across sessions. Returns semantically matched observations scoped by role, category, or project.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search query (e.g., project name, pattern, component).' },
          role: { type: 'string', description: 'Filter by specialist role (e.g., cx-engineer, cx-architect).' },
          category: { type: 'string', description: 'Filter by category: pattern, anti-pattern, dependency, decision, insight, session-summary.' },
          project: { type: 'string', description: 'Filter by project name.' },
          limit: { type: 'number', description: 'Max results (default: 10).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_add_observations',
      outputSchema: { type: 'object' },
      description: 'Record observations (patterns, insights, decisions, anti-patterns) that specialists discover during work. These are indexed for semantic search and surface in future sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          observations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', description: 'Specialist role (e.g., cx-engineer).' },
                category: { type: 'string', description: 'Category: pattern, anti-pattern, dependency, decision, insight.' },
                summary: { type: 'string', description: 'Brief summary (max 500 chars).' },
                content: { type: 'string', description: 'Detailed observation (max 2000 chars).' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering.' },
                confidence: { type: 'number', description: 'Confidence 0.0-1.0 (default: 0.8).' },
              },
              required: ['summary'],
            },
            description: 'Observations to record (max 10 per call).',
          },
        },
        required: ['observations'],
      },
    },
    {
      name: 'memory_create_entities',
      outputSchema: { type: 'object' },
      description: 'Track recurring entities (components, services, APIs, dependencies) that specialists encounter. Enables "what do we know about X?" queries.',
      inputSchema: {
        type: 'object',
        properties: {
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Entity name (normalized to lowercase).' },
                type: { type: 'string', description: 'Type: component, service, dependency, api, concept, file-group.' },
                summary: { type: 'string', description: 'Brief description (max 500 chars).' },
                observation_ids: { type: 'array', items: { type: 'string' }, description: 'Link to observation IDs.' },
              },
              required: ['name'],
            },
            description: 'Entities to create or update (max 10 per call).',
          },
        },
        required: ['entities'],
      },
    },
    {
      name: 'memory_recent',
      outputSchema: { type: 'object' },
      description: 'Returns the most recent observations for the current project, deduplicated by (role, summary). Use this when the session-start hint indicates prior observations are available — fetch them on demand instead of paying for them every session.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project directory (default: process.cwd()).' },
          project: { type: 'string', description: 'Filter by project name (default: inferred from cwd).' },
          limit: { type: 'number', description: 'Max distinct observations (default: 10, max: 50).' },
        },
      },
    },
    {
      name: 'rovo_search',
      outputSchema: { type: 'object' },
      category: 'retrieval',
      description: 'Cross-system semantic search via Atlassian Rovo. Searches Jira, Confluence, and other accessible sources. Returns excerpts with source attribution. Does NOT store results in the observation store. Use for broad queries across all sources, not just focal projects.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g., "Iverson reliability", "DR failover").' },
          top_k: { type: 'number', description: 'Max results (default: 10, max: 50).' },
          sources: { type: 'string', description: 'Comma-separated source filter (e.g., "jira,confluence").' },
        },
        required: ['query'],
      },
    },
    {
      name: 'efficiency_snapshot',
      outputSchema: { type: 'object' },
      description: 'Returns the read-efficiency snapshot for the current session — repeated reads, large reads, hot-spot files, and recommendations. Use this when investigating why a session feels slow or to surface optimization opportunities.',
      inputSchema: {
        type: 'object',
        properties: {
          home_dir: { type: 'string', description: 'Home directory override (default: os.homedir()).' },
        },
      },
    },
    {
      name: 'session_usage',
      outputSchema: { type: 'object' },
      description: 'Returns locally recorded interaction token and cost usage for the current Construct session.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project directory (default: process.cwd()).' },
          home_dir: { type: 'string', description: 'Home directory override for reading ~/.cx session logs.' },
        },
      },
    },
    {
      name: 'provider_fetch',
      outputSchema: { type: 'object' },
      category: 'retrieval',
      description: 'Look up current data for a configured repo, project, or team. This is an internal lookup against sources the operator has already authorized (set in config.env). Call this immediately — no user approval needed — whenever the user asks about a specific repo, project, or team name (e.g. "what is project iverson", "cloud-reliability status", "PLAT issues"). Pass the user\'s query and the tool resolves the right source automatically. Returns repo metadata, README, docs, open PRs, issues, and recent commits, then stores them as observations.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The user\'s question or the project/repo name (e.g. "project iverson", "hashicorp/project-iverson", "PLAT"). The tool matches this against configured GITHUB_REPOS, JIRA_PROJECTS, LINEAR_TEAMS.' },
          root_dir: { type: 'string', description: 'Data root dir override (default: homedir()). Use CX_DATA_DIR value if set.' },
          team_id: { type: 'string', description: 'Optional team id (from the unified registry). Scopes the fetch to that team\'s declared sources; observations are tagged team:<id>.' },
          target_ids: { type: 'array', items: { type: 'string' }, description: 'Optional source-target ids to restrict to (must belong to team_id). A target outside the team returns a typed OUT_OF_SCOPE error rather than a silent wrong-source fetch.' },
        },
      },
    },
    {
      name: 'scope_show',
      outputSchema: { type: 'object' },
      description: 'Return the active Construct scope (id, displayName, roles, departments, intake taxonomy, doc templates). Use when a specialist needs to know which role set, classification taxonomy, or doc templates apply before drafting work.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project root (default: server cwd).' },
          id: { type: 'string', description: 'Force a specific scope id instead of resolving from config.' },
        },
      },
    },
    {
      name: 'scope_list',
      outputSchema: { type: 'object' },
      description: 'List the curated org scope catalog (rnd, operations, creative, research) with role/department counts. Use to discover which scopes are available before suggesting `construct scope set`.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'scope_drafts',
      outputSchema: { type: 'object' },
      description: 'List in-progress draft scopes under `.construct/scopes/draft-*` and any user-defined custom scope at `.construct/scope.json`. Use to see what scope work is pending before scaffolding another draft.',
      inputSchema: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Project root (default: server cwd).' } },
      },
    },
    {
      name: 'scope_health',
      outputSchema: { type: 'object' },
      description: 'Per-scope health rollup over a window: observation count, per-role outcome runs and success rates. Use to check whether a scope is producing data before recommending changes or archive.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project root (default: server cwd).' },
          id: { type: 'string', description: 'Scope id (default: active scope).' },
          window_days: { type: 'number', description: 'Window in days (default 30).' },
        },
      },
    },
    {
      name: 'outcomes_summary',
      outputSchema: { type: 'object' },
      description: 'Read `.construct/outcomes/_summary.json` (per-role success rate, 30-day trend). Pass `aggregate=true` to rebuild the summary from JSONL outcome files first. Use to ground tiebreakers and improvement suggestions in real specialist performance.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project root (default: server cwd).' },
          aggregate: { type: 'boolean', description: 'Rebuild `_summary.json` before reading (default false).' },
        },
      },
    },
    {
      name: 'outcomes_record',
      outputSchema: { type: 'object' },
      description: 'Append a specialist outcome line to `.construct/outcomes/<role>.jsonl` (writes durable state — requires `confirm=true`). Use when a specialist wants to self-report success/failure outside the automatic agent-tracker path.',
      inputSchema: {
        type: 'object',
        required: ['confirm', 'role', 'success'],
        properties: {
          confirm: { type: 'boolean', description: 'Must be true.' },
          cwd: { type: 'string' },
          role: { type: 'string', description: 'Specialist id (e.g. cx-engineer, product-manager).' },
          success: { type: 'boolean' },
          intake_id: { type: 'string' },
          profile: { type: 'string', description: 'Override active scope id stamp.' },
          escalated: { type: 'boolean' },
          duration_ms: { type: 'number' },
          notes: { type: 'string', description: 'Trimmed to 500 chars.' },
          source: { type: 'string', description: 'Origin tag (default: "mcp").' },
          session_id: { type: 'string', description: 'Session the outcome belongs to; enables per-skill outcome attribution against skill-calls.jsonl.' },
        },
      },
    },
    {
      name: 'knowledge_add',
      outputSchema: { type: 'object' },
      description: 'Persist a research finding as `.construct/knowledge/external/research/<slug>.md` with research-specific frontmatter (topic, confidence, sources, expiresAt, scope). Writes durable state — requires `confirm=true`. `confidence=confirmed` requires at least one source.',
      inputSchema: {
        type: 'object',
        required: ['confirm', 'slug', 'topic', 'body'],
        properties: {
          confirm: { type: 'boolean', description: 'Must be true.' },
          cwd: { type: 'string' },
          slug: { type: 'string', description: 'Lowercase hyphenated, max 60 chars.' },
          topic: { type: 'string' },
          body: { type: 'string', description: 'Findings / inferences / gaps / recommendation block. Capped at 50KB total file.' },
          confidence: { type: 'string', enum: ['confirmed', 'inferred', 'weak'], description: 'Default: inferred.' },
          sources: {
            type: 'array',
            description: 'Required when confidence=confirmed.',
            items: {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string' },
                accessedAt: { type: 'string', description: 'ISO timestamp; default now.' },
                span: { type: 'string', description: 'Citation locator; trimmed to 200 chars.' },
              },
            },
          },
          ttl_days: { type: 'number', description: 'Default 90.' },
        },
      },
    },
    {
      name: 'scope_create',
      outputSchema: { type: 'object' },
      description: 'Scaffold a draft org scope under `.construct/scopes/draft-<id>/` (requirements.md + scope.json + persona stubs + department charters). Writes durable state — requires `confirm=true`. For curated catalog work, follow `docs/guides/concepts/profile-lifecycle.md` after creation.',
      inputSchema: {
        type: 'object',
        required: ['confirm', 'id'],
        properties: {
          confirm: { type: 'boolean', description: 'Must be true.' },
          cwd: { type: 'string' },
          id: { type: 'string', description: 'Scope id (^[a-z][a-z0-9-]{1,30}$).' },
          display_name: { type: 'string' },
          seed_roles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Role ids to scaffold persona files for (cap 80).',
          },
          seed_departments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' },
                displayName: { type: 'string' },
              },
            },
            description: 'Departments to scaffold charters for (cap 12).',
          },
        },
      },
    },
    {
      name: 'scope_archive',
      outputSchema: { type: 'object' },
      description: 'Archive a curated scope: moves `specialists/org/scopes/<id>.json` and its intake table into `archive/scopes/<id>/` with an archive note. Destructive — requires `confirm=true` and a substantive `reason` (>=8 chars). Observations and outcomes are preserved.',
      inputSchema: {
        type: 'object',
        required: ['confirm', 'id', 'reason'],
        properties: {
          confirm: { type: 'boolean', description: 'Must be true.' },
          id: { type: 'string' },
          reason: { type: 'string', description: 'Substantive reason (>= 8 chars).' },
        },
      },
    },
    {
      name: 'sandbox_list',
      outputSchema: { type: 'object' },
      description: 'List Construct sandboxes under `~/.cx/sandboxes/` (id, path, createdAt). Use to find an isolated environment for QA or dry-runs without polluting the active project.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'provider_write',
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          provider: { type: 'string' },
          dryRun: { type: 'boolean' },
          diff: { type: 'object' },
          envelope: { type: 'object' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      description: 'Governed external write to a contract-adapter provider (jira, confluence, github). Destructive — dry_run defaults to true and only renders the would-write diff from adapter validation (no network, no side effect). Executing (dry_run=false) requires the out-of-band destructive-gate approval_token; the actual write then routes through the J2 envelope (idempotency, dedup, retry, audit) to the governed-write adapter — never called directly. Pass specialist_id when calling on behalf of an embedded specialist so the LMCP-E4 embedBindings grant is enforced.',
      inputSchema: {
        type: 'object',
        required: ['provider', 'item'],
        properties: {
          provider: { type: 'string', enum: ['jira', 'confluence', 'github'], description: 'Target contract-adapter provider.' },
          item: { type: 'object', additionalProperties: true, description: 'Write payload; shape depends on provider (e.g. { type: "issue", project, summary } for jira).' },
          dry_run: { type: 'boolean', description: 'Default true. When true, returns the validated would-write diff only — never reaches the adapter write path.' },
          specialist_id: { type: 'string', description: 'Embedded-specialist caller id (e.g. "cx-writer"); enforces that specialist\'s LMCP-E4 embedBindings grant before dispatch.' },
          idempotency_key: { type: 'string', description: 'Explicit idempotency key forwarded to the J2 envelope (auto-derived from payload when omitted).' },
          approval_token: { type: 'string', description: 'Out-of-band destructive-gate token, required to execute (dry_run=false). Issue with `construct tokens issue provider_write`.' },
        },
      },
    },
    {
      name: 'knowledge_graph_ask',
      outputSchema: { type: 'object' },
      category: 'retrieval',
      description: 'GraphRAG-style global query over the entity graph in `.construct/observations/`. Detects communities via label propagation, ranks them by BM25 against the query, and returns each top community with its central members and extractive summary. Use for "tell me about how X relates across the project" questions that pure semantic retrieval handles poorly.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Natural-language question.' },
          cwd: { type: 'string', description: 'Project root (default: server cwd).' },
          top_k: { type: 'number', description: 'Max communities to return (default 5).' },
          min_size: { type: 'number', description: 'Skip communities smaller than this (default 2).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Restrict entity extraction to observations carrying these tags.' },
          tag_match: { type: 'string', enum: ['any', 'all'], description: 'Tag match mode: any (default) or all.' },
        },
      },
    },
    {
      name: 'learning_status',
      outputSchema: { type: 'object' },
      description: 'One-shot mirror of `npm run learning:status`: active scope, observation counts (last 24h + total), research finding count, per-role outcome rollup. Use to answer "is Construct learning?" without spawning a shell.',
      inputSchema: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Project root (default: server cwd).' } },
      },
    },
    {
      name: 'document_export',
      outputSchema: { type: 'object' },
      description: 'Convert a markdown file into a distributable document — PDF, DOCX, legacy DOC (LibreOffice), deck HTML, PPTX, HTML, RTF, ODT, EPUB, LaTeX, plain text, or Markdown — via Pandoc and Typst (PDF engine) plus optional pptxgenjs/LibreOffice, per ADR-0024. Engines are optional dependencies discovered at runtime — the tool returns a structured "install <binary>" error when tooling is absent, never crashes. Use `detect_only=true` to check availability without running an export.',
      inputSchema: {
        type: 'object',
        required: ['format'],
        properties: {
          input_path: { type: 'string', description: 'Absolute path to the markdown source file (required unless detect_only=true).' },
          output_path: { type: 'string', description: 'Optional absolute output path; defaults to <input>.<format> next to the source.' },
          format: { type: 'string', enum: ['pdf', 'docx', 'doc', 'deck', 'pptx', 'html', 'rtf', 'odt', 'epub', 'tex', 'txt', 'md', 'mdx'], description: 'Target format.' },
          detect_only: { type: 'boolean', description: 'When true, report binary availability without exporting. Default false.' },
          figures: { type: 'boolean', description: 'When true, render d2/mermaid via pandoc-ext/diagram filter. Default false.' },
        },
      },
    },
];
