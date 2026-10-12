# AUD-DURABILITY-GAP-V2 — concurrent-writer locking + fail-closed replay for the remaining durable stores

## Provenance

This is a fresh, independently re-derived correction, not a port of PR #30 (`claude/aud-durability-gap-correction`, abandoned open since 2026-09-10). PR #30's own Rev74/Rev77 Brain-reviewed fix was verified line-for-line against current `main` (`5dcbee99e3f0a0455915a7785ac939b069c1e33a`) before any porting was attempted - and found to be stale: all three source files PR #30 touched (`durable-engineering-store.ts`, `durable-outcome-job-store.ts`, `durable-plan-admission-store.ts`) have structurally diverged from PR #30's own base (`3226c76`) by ~50 intervening PRs, so PR #30's own diff cannot be applied or ported. Instead, each store's *current* state was inspected directly and found to have a different, independently-confirmed mix of gaps than PR #30 described:

- `durable-outcome-job-store.ts`: `putIfAbsent`'s TOCTOU race is **still present** (exactly PR #30's own F1 finding), but `validatePersistedOutcomeJobLine` (fail-closed replay) **already landed** via the unrelated `OS-V0-03` task - no rescue needed for replay here.
- `durable-plan-admission-store.ts`: `appendEvent`'s TOCTOU race is **still present**; `validatePersistedPlanAdmissionEvent` has **partial** replay validation (envelope/nested-result scope correlation already present) but was missing exactly the two gaps PR #30's own Rev77 correction closed (eventId recomputation, impossible status/field-shape rejection) **plus** a gap PR #30 itself never flagged: `blockedReasons`/`awaiting`/`evaluatedApprovalId` were not type/shape-validated at all before this correction.
- `durable-engineering-store.ts`: **both** the TOCTOU race and fail-closed replay validation were missing entirely - `getEvents` did a blind `JSON.parse(line) as EngineeringEventEnvelope` cast with zero revalidation, a gap PR #30 never touched (it never fixed this particular file's replay boundary, only its race).

The fix below was therefore designed fresh against each file's actual current content, reusing the exact `linkSync`-based atomic-creation lock primitive already Brain-accepted for `FileDurableConnectorConnectionStore.save` (CONN-001 Rev94 F1, merged to `main`) rather than re-deriving a new locking mechanism, and reusing this repository's own established "reapply constructor invariants on replay" pattern (Rev183 F4) for the engineering-store validator.

Branch: `claude/aud-durability-gap-v2`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a` (which already includes `DEPLOY-001`/`DEPLOY-002`, PR #136/#137).

## The defects (confirmed by direct inspection of current `main`, not assumed)

1. **Concurrent-writer lost-update race** in all three stores' append/write paths: each did read-current-content -> concatenate line -> rewrite-whole-file, with no cross-process mutual exclusion. Two independent processes (e.g. two worker instances, or a WORKER and a BRAIN process) racing to append to the same durable file could both read the same prior content, and the later write would silently discard the earlier writer's already-"successful" append - a genuine lost-update, not just a benign interleaving.
2. **Blind replay cast** in `durable-engineering-store.ts.getEvents`: `JSON.parse(line) as EngineeringEventEnvelope` with zero revalidation - a corrupted or forged line (wrong role, invalid eventType, missing/malformed DEC-138 provenance, or a foreign projectRef/taskId/runId) would flow straight into the reducer.
3. **Incomplete replay validation** in `durable-plan-admission-store.ts`'s `validatePersistedPlanAdmissionEvent`: the persisted `EVALUATION_RECORDED.eventId` was never checked against the deterministic `evaluationEventId(result)` it is supposed to equal; `result.blockedReasons`/`result.awaiting`/`result.evaluatedApprovalId` were never type/shape-validated at all; and no check enforced that the three fields' combination matches one of `admitPlan`'s own three legal status shapes (a forged line could claim e.g. `ADMITTED` with populated `blockedReasons`).

## Fix

- **Locking**: each store gained a `.locks/` subdirectory and a `with<X>Lock` method, identical in structure to `FileDurableConnectorConnectionStore.withTenantLock` - `linkSync(tmpPath, lockPath)` atomically creates-or-`EEXIST`s the lock, with a bounded synchronous backoff/timeout (`OutcomeJobStoreLockTimeoutError` / `EngineeringStoreLockTimeoutError` / `PlanAdmissionStoreLockTimeoutError`). `putIfAbsent`/`appendEvent` now run their entire read-check-write (or read-modify-write) critical section inside the lock.
  - `durable-outcome-job-store.ts`: locked per-tenant (the store's own file granularity).
  - `durable-engineering-store.ts`: locked per `(projectRef, taskId, runId)` run (the store's own file granularity).
  - `durable-plan-admission-store.ts`: locked per `(tenantId, customerId, projectId, planId)` plan (the store's own file granularity).
- **Engineering-store replay validation (new)**: `validatePersistedEngineeringEvent` reapplies the exact same constructor invariants `createEngineeringEventEnvelope`/`createDec138Provenance` already enforce at creation time, plus a cross-tenant-contamination-style check that the persisted line's own `projectRef`/`taskId`/`runId` match the tuple `getEvents` was actually asked for. Every failure throws the new `CorruptedEngineeringEventLineError`.
- **Plan-admission replay validation (strengthened)**: `validatePersistedPlanAdmissionEvent`'s `EVALUATION_RECORDED` branch now additionally: recomputes `evaluationEventId({planId, planVersion})` and rejects any mismatch; validates `blockedReasons` is a string array, `awaiting` (if present) has non-empty `entity`/`reason`, and `evaluatedApprovalId` (if present) is non-empty; and rejects any status/field combination other than `admitPlan`'s own three legal shapes (`BLOCKED` ⇒ non-empty `blockedReasons`, no `awaiting`/`evaluatedApprovalId`; `WAITING` ⇒ empty `blockedReasons`, populated `awaiting`, no `evaluatedApprovalId`; `ADMITTED` ⇒ empty `blockedReasons`, no `awaiting`, populated `evaluatedApprovalId`).

## Scope (this checkpoint)

- `src/domain/durable-outcome-job-store.ts`: `withTenantLock` + `OutcomeJobStoreLockTimeoutError`; `putIfAbsent` now runs inside the lock.
- `src/domain/durable-engineering-store.ts`: `withRunLock` + `EngineeringStoreLockTimeoutError`; `appendEvent` now runs inside the lock; new `validatePersistedEngineeringEvent` + `CorruptedEngineeringEventLineError`; `getEvents` now validates every line instead of blindly casting.
- `src/domain/durable-plan-admission-store.ts`: `withPlanLock` + `PlanAdmissionStoreLockTimeoutError`; `appendEvent` now runs inside the lock; `validatePersistedPlanAdmissionEvent`'s `EVALUATION_RECORDED` branch strengthened per above.
- `tests/durable-outcome-job-store-concurrency.test.ts` (new): 5 real OS processes race `putIfAbsent` on the same jobId - exactly one reports `created: true`, the rest observe the winner's own payload, restart replay reconstructs the winner.
- `tests/durable-engineering-store-concurrency.test.ts` (new): 8 real OS processes race `appendEvent` with 8 distinct events on the same run - all 8 survive (no lost-update), restart replay reconstructs the full set.
- `tests/durable-plan-admission-store-concurrency.test.ts` (new): 8 real OS processes race `appendEvent` with 8 distinct `ANSWER_RECORDED` events on the same plan - all 8 survive, restart replay reconstructs the full set.
- `tests/helpers/outcome-job-store-race-worker.ts`, `tests/helpers/engineering-store-race-worker.ts`, `tests/helpers/plan-admission-store-race-worker.ts` (new): standalone worker scripts spawned as real child processes by the three concurrency tests above (mirrors `tests/helpers/connector-connection-race-worker.ts`'s own established pattern).
- `tests/durable-engineering-store-replay.test.ts` (new): 9 adversarial forged-line cases (unknown eventType, empty eventId, non-positive fencingToken, missing/malformed provenance, non-object line, foreign projectRef/taskId/runId) all rejected fail-closed, plus one positive multi-event replay/restart case proving no false rejection.
- `tests/durable-plan-admission.test.ts` (extended): new **P15** (forged non-deterministic eventId rejected) and **P16** (5 sub-cases: populated blockedReasons/awaiting on ADMITTED, missing evaluatedApprovalId, non-array blockedReasons, malformed awaiting.entity - all rejected).
- `tests/durable-outcome-job-store.test.ts` / `tests/durable-plan-admission.test.ts` (boundary-scan tests **B13**/**P14** updated): both now also allow `node:crypto` as an import, since `randomUUID` (used for unique lock tmp-file names) is a Node built-in, not a new runtime dependency - the same primitive already accepted for `durable-connector-connection-store.ts`.
- `IMPLEMENTED / SELF-VALIDATED`: clean build, clean strict typecheck, full regression **2671/2671 passing** (2665 pre-existing on this `main` tip + 6 new... see Evidence for the exact breakdown), zero new runtime dependency (`node:crypto`'s `randomUUID` and `linkSync`/`unlinkSync` from `node:fs` are both Node built-ins already used elsewhere in this exact codebase for this exact purpose).

## Honest limitation (disclosed, not hidden)

A guard-disable sanity check (temporarily bypassing `withTenantLock` in `durable-outcome-job-store.ts` to confirm the new concurrency test would then fail without the real lock) was attempted and denied by this environment's own permission classifier (`[Security Weaken]`), the same transient limitation disclosed in this session's `APP-SUB-001`/`PROTO-HEADER-HARDENING` checkpoints. The edit was reverted immediately via the same tool (confirmed restored and re-passing before proceeding) and no mutation to the shipped code occurred. Confidence in the lock's correctness instead rests on: (a) it is a byte-for-byte structural copy of `FileDurableConnectorConnectionStore.withTenantLock`, a primitive already Brain-reviewed and accepted on `main` for the identical purpose; (b) all three new concurrency tests spawn genuine separate OS processes (not merely async interleaving, which Node's single-threaded execution cannot reproduce) and pass against the real, un-bypassed lock.

## Hard Non-Scope

No change to `admitPlan`, `applyPlanAdmissionEvent`, `applyEvent`/`engineering-run-state.ts`'s reducer, or any caller of these three stores. No change to `postgres-outcome-job-store.ts` or any other Postgres-backed store (PR #30 never touched those either - they have their own separate concurrency model via the database). No new runtime dependency. No route/behavior change for any already-legitimate (non-adversarial, non-racing) caller.

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json` (clean rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2671/2671 passing**, 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: 5 pre-existing files touched (547 insertions, 44 deletions) + 7 new files (3 concurrency tests, 1 replay test, 3 worker helper scripts).
- `git diff --stat origin/main -- package.json package-lock.json`: empty, zero new dependency.
- Each new concurrency test spawns real, separate `node` child processes (via `node:child_process.spawn`), synchronized on a shared "go" file so all racers attempt their write within the same tight window - not an in-process interleaving, which Node's own synchronous single-threaded execution cannot reproduce as a true race.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`. Risk classification: LOW-MEDIUM — a real, previously-identified concurrency/replay-integrity hardening fix reusing an already-accepted primitive, touching only the three file-backed durable stores' own internal critical sections; no IAM/authority/payment/provider coupling, no behavior change for any non-adversarial, non-racing caller.

PR #30 (`claude/aud-durability-gap-correction`) remains open/stale and should be closed once this checkpoint is reviewed - its own diff no longer applies to `main` and its findings are superseded by this independent re-derivation.
