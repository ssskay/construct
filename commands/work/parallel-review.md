---
description: "Adversarial parallel review: roster-derived reviewers must agree before output ships"
---
You are Construct running a parallel adversarial review of: $ARGUMENTS

Dispatch the following review roles concurrently. Every name below resolves against the live 12-role roster in `specialists/org/specialists/` — no retired or invented names.

1. **cx-reviewer**: Correctness and logic: does it do what it claims? Are there off-by-ones, edge cases, or control flow bugs?
2. **cx-security**: Vulnerabilities and data exposure: injection, auth bypass, secret leakage, SSRF, unvalidated input
3. **cx-qa**: Test coverage and edge cases: what's untested? What inputs would break this?
4. **cx-architect**: Assumption stress-test: what design/interface assumptions could be wrong? What failure modes are unaddressed at the boundary level? (Replaces the retired `cx-devil-advocate` — the architect's fence already covers ADR/RFC-level assumption scrutiny, distinct from cx-reviewer's code-level correctness pass.)
5. **cx-designer** (UI changes) or **cx-debugger** (non-UI): Inclusive UX/accessibility, or root-cause trace of performance bottlenecks. (Replaces the retired `cx-accessibility`/`cx-trace-reviewer` — designer owns the accessibility skills and `a11y.violation` event; debugger owns performance tracing and `regression.detected`/`hang.detected` events.)

## Merge Gate

All dispatched roles must return **PASS** before output ships.

| Finding severity | Action |
|---|---|
| CRITICAL | Blocks merge. Must fix before proceeding. |
| HIGH | Blocks merge. Must fix before proceeding. |
| MEDIUM | Requires explicit acknowledgment. Document why it's acceptable or fix it. |
| LOW | Informational only. No action required. |

## Output Format

For each role:
```
[ROLE] PASS | FAIL
Findings:
- [severity] description
```

Final verdict: **MERGE READY** or **BLOCKED** (list blocking findings)

## Future: risk-triggered additional reviewers

The 4 roles above are the fixed baseline. A separate epic (`construct-pteo2`) is building a condition-driven specialist participation system (the "cdsp recruiter") that will invoke *additional* roster roles beyond this baseline when a change trips a specific risk condition — e.g. `cx-data-analyst` on metrics-shape changes, `cx-operations` on deploy/rollback-sensitive changes, `cx-product-manager` on user-facing behavior changes. That system does not exist yet; this is a forward-looking note, not a working integration. Until it lands, this gate stays fixed at the 4 roles above.
