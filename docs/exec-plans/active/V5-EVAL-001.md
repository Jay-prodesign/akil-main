# V5-EVAL-001 — Governed Evaluation / Improvement Loop Floor (V5 Workstream I, §13)

## Authorization

Continuation of the Rev89 Founder continuation authorization (see `docs/exec-plans/active/V5-LAB-001.md` for the full authorization record). After opening the `V5-LAB-001` draft PR, per Rev89's own instruction to "continue automatically after each bounded task until a genuine protected/dependency/capability boundary," a fresh scan of the remaining V5 workstreams found Workstream I (§13, Governed Evaluation / Improvement Loop) with no existing implementation anywhere in `src/` and no external dependency blocking it.

## Goal

Implement the smallest honest, repo-native floor of §13's own loop:

> collect governed evidence → evaluate against versioned metrics → diagnose → propose change → classify impact/authority → test in bounded environment → independent review where material → adopt/reject → monitor.

The first three steps (collect/evaluate/diagnose) are caller-side inputs, not lifecycle states — they enter this module as the `evalEvidenceRef`/`evalVersionRef` a proposal is constructed with. The final step (`monitor`) is deliberately **not** modeled: monitoring an already-adopted, live change is a distinct ongoing external activity, and no monitoring/telemetry system exists anywhere in this repository to honestly hook into.

## Scope

New pure domain module: `src/domain/governed-evaluation-loop.ts`.

- `GovernedChangeProposalStatus`: `"PROPOSED" | "CLASSIFIED" | "TESTED" | "REVIEWED" | "ADOPTED" | "REJECTED"`.
- `ChangeImpactClassification`: `"SAFE" | "MATERIAL"`.
- `GovernedChangeProposal`: the lifecycle record — `changeRef` (opaque, uninterpreted), `proposedByWorkerId`, `evalEvidenceRef`/`evalVersionRef` (required at construction, carried immutably through every transition).
- `proposeChange(input)` — the only construction function; always `PROPOSED`; accepts no classification/test/review/decision field.
- `classifyChangeImpact(input)` — `PROPOSED` → `CLASSIFIED`.
- `recordBoundedEnvironmentTest(input)` — `CLASSIFIED` → `TESTED`; records (never suppresses) `regressionOnCriticalBoundary`/`safetyRegression`.
- `reviewProposal(input)` — `TESTED` → `REVIEWED`; fail-closed self-review prevention (`reviewedByWorkerId` must differ from `proposedByWorkerId`), directly reusing the self-certification-prevention pattern already established in `partner-capability-admission.ts` (V5 Workstream H).
- `adoptChange(input)` — the only function producing `ADOPTED`; unconditionally rejects any critical-boundary or safety regression; requires `REVIEWED` status (not merely `TESTED`) plus a non-empty `rollbackPlanRef` for a `MATERIAL` proposal.
- `rejectChange(input)` — works from any non-terminal status; requires a non-empty `rejectionReason`; refuses to re-decide an already-`ADOPTED`/`REJECTED` proposal.

## §13 acceptance directions and how each is satisfied

| §13 text | This module's enforcement |
|---|---|
| "regression on critical boundary blocks affected adoption" | `adoptChange` unconditionally throws when `regressionOnCriticalBoundary === true` (test I7) |
| "cost wins cannot override safety" | `adoptChange` unconditionally throws when `safetyRegression === true`; no cost field exists anywhere on the type that could be weighed against it (test I8) |
| "eval version and sample provenance retained" | `evalEvidenceRef`/`evalVersionRef` are required at `proposeChange` and preserved verbatim through every transition (test I17) |
| "rollback path exists for material routing/prompt/process change" | `adoptChange` requires a non-empty `rollbackPlanRef` when `impactClassification === "MATERIAL"`; not required for `SAFE` (tests I9, I13, I14) |
| "benchmark/eval score does not equal production readiness" | `adoptChange` requires `TESTED` (or `REVIEWED`) status — a `PROPOSED` or `CLASSIFIED` proposal cannot be adopted regardless of how good its evidence looks |
| "independent review where material" | `adoptChange` requires `REVIEWED` (not just `TESTED`) specifically when `MATERIAL` (test I10) |
| "change to protected policy/scope requires proper decision authority" | `reviewProposal` fail-closed rejects self-review (test I12) |
| "optimization cannot silently weaken security/privacy/authority" | The regression/safety flags are recorded as facts by `recordBoundedEnvironmentTest` (never coerced or defaulted away) and gated unconditionally by `adoptChange` |

## Explicitly deferred

- The `monitor` loop step — no telemetry/observability system exists in this repository to honestly wire a post-adoption monitoring state into.
- Automatic evidence collection/evaluation/diagnosis (the loop's first three steps) — this floor accepts caller-supplied `evalEvidenceRef`/`evalVersionRef` only, matching this repository's existing "declared, not yet producible" discipline (e.g. `V5-LAB-001`'s caller-supplied observations, `V5-INT-001`'s caller-supplied insights).
- Any wiring of this loop's outcomes into a real routing-policy/prompt/reusable-capability mutation — `changeRef` remains an opaque, uninterpreted pointer; this module does not itself apply the change it governs.

## Test coverage

`tests/governed-evaluation-loop.test.ts`, 17 tests (I1–I17): construction validation, per-status transition guards, regression/safety-gated adoption (both positive and negative), self-review prevention, MATERIAL-vs-SAFE rollback-plan requirement, rejection from every non-terminal status, terminal-state immutability, and evidence/version provenance preservation across the full lifecycle.

## Evidence

- Branch: `claude/v5-eval-001-governed-evaluation-loop`, cut fresh from `main` at `3226c76fa338e425e553638e5f5f48924182a1c0`.
- Build: `npm run test` → clean `tsc` build (strict, `exactOptionalPropertyTypes: true`), full regression **767/767 pass** (750 pre-existing + 17 new).
- Zero new dependency. Zero imports (fully self-contained, unlike `V5-LAB-001`'s one type-only `TenantScope` import — this floor does not need tenant isolation since it governs process/policy proposals, not customer-scoped data).
- No filesystem/network/child_process coupling; pure functions only.

## Status

**IMPLEMENTED / SELF-VALIDATED.** Not yet reviewed by Brain. `MERGE_DISPOSITION: HOLD_MERGE` (no `MAIN` mutation per the Rev89 authorization's own explicit prohibition list).
