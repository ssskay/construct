<!--
tests/functional/README.md. Discipline doc for the functional test layer.

End-to-end checks that exercise a feature in an isolated filesystem, the same
way it would behave in a real session. Distinct from unit tests in tests/.
-->

# Functional tests

End-to-end checks that exercise a feature in an isolated filesystem, the same way it would behave in a real session. Distinct from unit tests in `tests/`.

## When to add one

Every change that touches more than one of these surfaces needs a functional test here:

- A hook that writes to `.cx/` or `~/.cx/`
- A learning loop (observation capture, research persistence, outcome capture, prompt improvement)
- A profile or intake table that drives routing
- A CLI subcommand that reads or writes durable state
- Any pipeline where the value only shows up after multiple steps run together

If a defect would slip past unit tests because each unit looks fine in isolation, it belongs here.

## Pattern

Every functional test:

1. Creates a fresh `mkdtempSync` directory. No shared fixtures.
2. Spawns the real binary or imports the real module, no mocks beyond what production uses.
3. Asserts on durable artifacts (files, JSONL lines, vector indexes), not return values alone.
4. Verifies the next-step contract: if A1 writes an observation, A1's functional test reads it back with `searchObservations` to prove the loop closes.
5. Cleans up. The tmpdir is deleted on success.

### Isolation contract

Durable writes must stay under the fixture root — never the developer's real `HOME`,
`~/.cx`, or repo `profiles/`. When a test redirects `process.env.HOME`, it must
restore the prior value in `finally`, `after`, or `t.after` (parallel `node --test`
shares one process environment).

- Use `tests/helpers/isolation-contract.mjs` (`assertPathUnderRoot`) after APIs that
  resolve project-scoped storage (`exportTurns`, `resolveProjectScopedPath`, etc.).
- Create a Construct project marker (`.cx/` or `package.json` + `.cx/`) in the
  fixture when exercising project-scoped commands.
- In-process code that writes through the machine-scoped state axis
  (`lib/config/xdg.mjs` `doctorRoot`) — the canonical case is a real `Broker`,
  whose default `auditRecorder` appends to the audit trail — needs
  `pinDoctorRoot()` from `tests/helpers/doctor-root.mjs` at the top of the file
  (restore in `after()`), or an injected `auditRecorder`.
- `tests/test-isolation.test.mjs` flags files that assign `HOME` without an in-file
  restore signal, and files that construct a `Broker` without an `auditRecorder`
  injection or a doctor-root pin.

### Inbound-env determinism

The isolation contract above is write-scoped; a test's *inbound* env must be
equally deterministic. A spawn/process env built as `{ ...process.env, ...overrides }`
inherits whatever the developer's shell happens to export — `CX_MODEL_*`,
provider keys, `WEB_SEARCH_URL`, `CX_USER_ENV_PATH` — and can even reach a real
`op` binary through `lib/providers/secret-resolver.mjs`'s file/rc discovery,
triggering a live 1Password biometric prompt mid-test.

- Any suite that spawns a child process (`child_process.spawn`/`spawnSync`,
  `StdioClientTransport`) or hands an isolated `env` object to an in-process
  call must build that env with `sterileSpawnEnv()` from
  `tests/helpers/sterile-env.mjs`, not a `{ ...process.env }` spread. The
  helper allowlists only `PATH`/`TMPDIR`/`LANG` and pins `HOME`/`CX_HOME_OVERRIDE`/
  XDG dirs to a fresh `mkdtempSync` root; nothing else is inherited unless named
  in `overrides`.
- A hermetic `resolveSecret`/`resolveSecretAsync` call must pass
  `allowAmbient: false` explicitly — the public default is `true` — so file/rc
  discovery (and any real `op` read) is suppressed.
- Verify the guard with `createOpStub()` (same module): put its `binDir` first
  on `PATH` and assert its log stays empty after the suite runs. See
  `tests/functional/spawn-env-hermeticity.functional.test.mjs` for the
  reference pattern, including the poisoned-parent-env regression check
  (`CX_MODEL_STANDARD=poison OPENROUTER_API_KEY=sk-poison ... npm run test:functional`
  must produce the same result as a clean env).

## Run

```bash
npm run test:functional
```

Or a single file:

```bash
node --test tests/functional/a1-session-reflect.functional.test.mjs
```

These run as part of `npm test` so the gate fails the same way locally as in CI.

## Test runner

`node --test` (via `scripts/run-tests.mjs`) is the sole supported test runner. The suite
was fully ported off `ava` in `construct-m7k2-fix-tests`; do not reintroduce alternate
runners or discovery globs that bypass `scripts/run-tests.mjs`.

Beads concurrency is covered by `beads-concurrent-write.functional.test.mjs` (optimistic
locking, no legacy file-lock fallback).

## Why this exists

CI is a backstop, not a primary gate. If a learning loop only fails when components interact, a unit-test green checkmark gives a false sense of safety. The vector-index regression in A1's first commit is the canonical example: `addObservation` was async, the hook forgot to await it, every unit test passed, and the vector write was killed by `process.exit`. A functional test that asserted `vectors.json` exists would have caught it locally in seconds.

Functional tests are how Construct keeps that kind of class-of-bug from reaching CI.
