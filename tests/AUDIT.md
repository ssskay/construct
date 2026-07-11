<!--
tests/AUDIT.md. Test-suite audit produced for construct-sbh.

Categorizes every test file by signal type so future trimming and gap analysis
have a starting point. Updated when categories change, not on every PR.
-->

# Test suite audit

A snapshot of what the test suite covers, why each file exists, and where the gaps live. Produced for `construct-sbh`. Refresh when categories shift.

## At a glance

- **878 test files** total: 365 at `tests/` top level + 513 in subdirectories.
- **Layers:** unit 579, functional 251, visual 12, live-provider 2, integration 34.
- **Functional layer:** 251 file(s) under `tests/functional/` or `*.functional.test.mjs`. End-to-end checks spawn the real binary or import real modules in an isolated tmpdir.
- **Contract subsystems:** 44 file(s) under profile/outcomes/hooks/knowledge/intake/graph/evals and related subdirs.
- **Hook tests:** 9 file(s) (including `tests/hooks/`).
- **Capability-marked:** 50 file(s) declare `@capability` markers.
- **Skipped markers:** 0 file(s) contain `test.skip` / `describe.skip` (see inventory for paths).
- **Regenerate inventory:** `node scripts/generate-test-corpus-inventory.mjs`.

## Categories

### 1. Structural / contract guards (~30 files)

Assert that a file exists, that a string appears in a config, that a registry parses. Cheap, high-signal for catching drift. Examples:

- `agent-prompts.test.mjs` (word budgets, prompt surface contracts)
- `release-workflow.test.mjs` (CI shape lint)
- `parity.test.mjs` (cross-surface adapter parity, with new copilot regression)
- `comment-lint.test.mjs` (comment policy, with new `.md`-in-tests regression)
- `agents-registry.test.mjs` (registry schema)
- `cli-catalog-accuracy.test.mjs` (catalog ↔ handler parity: new)
- `auto-docs.test.mjs`, `docs-verify.test.mjs`

Keep. These are the cheapest tests that catch the loudest classes of bug.

### 2. Unit tests on pure modules (~80 files)

Cover the deterministic libraries: extractors, classifiers, formatters, embedding helpers, intake table logic. Examples:

- `intake-classify.test.mjs`, `intake/golden-rnd.test.mjs`
- `intent-classifier.test.mjs`, `prompt-composer*.test.mjs`
- `embeddings*.test.mjs`, `hashing-bow.test.mjs`
- `observation-store.test.mjs` (with new `extras` field coverage)
- `reflect.test.mjs`, `reflect/extractor.test.mjs`

Keep. Fast, focused, low maintenance.

### 3. Integration / dual-mode storage (~25 files)

Exercise the file ↔ SQL dual-mode patterns: `*store*`, `*-postgres-queue*`, `hybrid-query`, `vector-client`. Many gracefully degrade when Postgres is not available, which is the right design but means some assertions only fire under specific env.

Keep. The class-of-bug they protect against (dual-mode drift) shipped real regressions in earlier releases.

### 4. Hook tests (~20 files, partly under `tests/hooks/`)

Verify Stop / SessionStart / PreToolUse hooks: `session-start-hook`, `session-reflect`, `hook-budget`, `hook-audit-reads`, `comment-lint`, `policy-engine*`. Run as spawned child processes to mirror production.

Keep. Hooks are protected files per `CLAUDE.md`; a regression here can block every tool call.

### 5. Functional layer (251 tests, 251 files)

New in this PR. Pattern documented at `tests/functional/README.md`:

- `a1-session-reflect.functional.test.mjs`: A1 end-to-end + vector-index regression
- `a2-research-persistence.functional.test.mjs`: A2 CLI round-trip
- `a3-outcomes.functional.test.mjs`: A3 + live `agent-tracker` production trigger
- `a4-optimize-gate.functional.test.mjs`: A4 `--apply` / `--rollback` gate
- `b1-profile-loader.functional.test.mjs`: every profile classifies its representative input
- `profile-lifecycle.functional.test.mjs`: draft → archive → health round-trip

Expand. Every multi-component change must land with a functional test going forward (rule in `CLAUDE.md`).

### 6. Skipped (0)

No tests are currently marked `skip` in the suite. Previously-skipped tests have been addressed or removed.

## Coverage gaps

These showed up while categorizing:

- **`lib/sandbox.mjs`**: new module, no dedicated test file. Smoke-tested via the CLI but should grow a unit test for `pruneSandboxes` time-window logic.
- **`lib/profiles/validate-custom.mjs`**: validator has no direct test. The lifecycle functional test exercises the happy path through it; the cap and shape error branches are not regression-locked.
- **`lib/profiles/lifecycle.mjs::archiveProfile`**: file-move path is only tested for the empty-reason rejection. The success path (moving + writing archive-note) is not asserted because it would mutate the real `profiles/` directory; a tmpdir fork of the function would let this be tested cleanly.

These are gaps, not bugs. Future PRs that touch these surfaces should close their corresponding gap before merge.

## Anti-patterns this audit looked for and did not find

- Tests that ONLY assert a string match against a file with no behavioral check. The structural-guard category looks like this on its surface but the strings under assertion are load-bearing contract anchors (registry schema, AUTO regions, CI shape), not cosmetic.
- Duplicate coverage. Some intake-* tests overlap on classification fixtures, but each exercises a different layer (raw classifier vs. CLI surface vs. session prelude). Not duplication.
- Slow tests masquerading as unit tests. The whole suite runs in 5.5 s. The integration/storage tests are gated on env presence rather than masquerading as fast unit work.

## Disposition

The suite is high-signal, not bloated. Most of the volume is structural guards and unit tests on deterministic modules, both of which are cheap to run and load-bearing. The gaps above are real but specific; they do not call for a sweep.

Recommended cadence: refresh this audit when the suite passes 2000 tests or when a new top-level category (today: functional) gets added.
