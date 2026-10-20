# AUD-DURABILITY-GAP-V2 (re-derived) — closing the remaining durable-store concurrency gap

## Provenance

- Original PR #145 (`claude/aud-durability-gap-v2`, cut from `main` at `5dcbee9...`): independent re-derivation of abandoned PR #30's finding, closing a torn-read/lost-write gap in `durable-outcome-job-store.ts`, `durable-plan-admission-store.ts`, and `durable-engineering-store.ts`.
- Governing instruction for THIS re-derivation: Brain's "BACKLOG RESCUE / CURRENT-MAIN INTEGRATION PACKET" (PR #145 comment `6294430140`, 2026-10-20), item 7: re-derive against current `main` rather than cherry-pick the stale commit, because `durable-outcome-job-store.ts`'s locking has since been superseded and strengthened by the merged PR #167/#168 systemic torn-read/lost-write correction — naively porting the old PR's `putIfAbsent` would self-deadlock (current `get()` already locks internally; the old `putIfAbsent` called `this.get()` from inside its own lock).
- Scope of this re-derivation: `durable-outcome-job-store.ts` is **deliberately untouched** (already correct and strengthened on current `main`). Only `durable-engineering-store.ts` and `durable-plan-admission-store.ts` — the two stores Brain confirmed are "still real gaps confirmed on current MAIN" — are corrected here.

## FileDurableEngineeringStore

- Gap: no lock at all around `appendEvent`'s read-check-write critical section (a lost-write hazard in the same class `FileDurableOutcomeJobStore` had pre-correction); `getEvents` did a blind `JSON.parse` cast with zero structural revalidation.
- Fix: a `linkSync`-based per-run lock (keyed by the same `runKey` identity the file itself uses), shared by `appendEvent` AND `getEvents`/`getState` — applying the #167/#168 lesson that a writer-only lock does not stop a reader from observing a torn file mid-write. `getEvents` now reapplies `createEngineeringEventEnvelope`/`createDec138Provenance`'s own constructor invariants against every parsed line (the established "reapply constructor invariants on replay" pattern, Rev183 F4), plus a cross-run-contamination identity check (the parsed event's own `(projectRef, taskId, runId)` must match the file's own identity).
- New witnesses: a 5-process concurrency test (`durable-engineering-store-concurrency.test.ts`) and 6 adversarial replay-corruption tests + 1 positive control in `durable-engineering-store.test.ts`.
- Guard-disable sanity: lock disabled → **8/8 repeated runs of the concurrency test failed** (reliably reproducible, matching the severity of a genuine lost-write hazard); replay validation disabled → exactly the 6 new corruption tests failed, nothing else, positive control unaffected. Both restored byte-identical.

## FileDurablePlanAdmissionStore

- Gap 1 (concurrency): no lock at all around `appendEvent`'s read-check-write critical section; `getEvents` fully lock-free.
- Gap 2 (replay invariants, named explicitly by Brain): `validatePersistedPlanAdmissionEvent` already checked identity/nested-result-identity/recognized-status, but:
  - never recomputed/compared `EVALUATION_RECORDED.eventId` against `evaluationEventId(result)` (the deterministic id `createEvaluationRecordedEvent` itself derives from `planId`+`planVersion`) — a forged `eventId` not matching its own `result` passed silently.
  - `result.blockedReasons`/`result.awaiting`/`result.evaluatedApprovalId` had **zero** type/shape validation — a corrupted or forged record could, for example, claim `status: "ADMITTED"` with no `evaluatedApprovalId`, or `status: "BLOCKED"` with a populated `awaiting`, neither of which `admitPlan()`'s own three branches (`plan-admission.ts`) can ever actually produce.
- Fix: the same `linkSync`-based per-plan lock pattern (keyed by the existing `planKey` identity), shared by `appendEvent` and `getEvents`. New `validatePersistedPlanAdmissionResult` enforces: `blockedReasons` is an array of non-empty strings; `awaiting`, when present, is `{entity, reason}` with non-empty strings; `evaluatedApprovalId`, when present, is a non-empty string; and the exact per-status cross-field invariants `admitPlan()` guarantees (`BLOCKED` ⇒ non-empty `blockedReasons`, no `awaiting`, no `evaluatedApprovalId`; `WAITING` ⇒ empty `blockedReasons`, `awaiting` present, no `evaluatedApprovalId`; `ADMITTED` ⇒ empty `blockedReasons`, no `awaiting`, `evaluatedApprovalId` present). `eventId` is now recomputed via `evaluationEventId(result)` and compared exactly.
- Boundary constraint: `durable-plan-admission-store.ts` has its own exact-import-allowlist boundary test (`OS-V0-03 P14`) that does not list `node:crypto`. The lock's temp-file uniqueness therefore uses `process.pid` + `process.hrtime.bigint()`, not `randomUUID()` — the same alternative already established for `durable-outcome-job-store.ts` during the #167/#168 correction.
- New witnesses: a 5-process concurrency test (`durable-plan-admission-store-concurrency.test.ts`, using distinct `ANSWER_RECORDED` events to avoid colliding on the single-event-per-version `EVALUATION_RECORDED` identity) and 3 new adversarial tests (`AUD-GAP-V2 P15`/`P16`/positive control) in `durable-plan-admission.test.ts`, covering eventId-recompute mismatch and every status/field-shape cross-field invariant.
- Guard-disable sanity: lock disabled → **6/8 repeated runs of the concurrency test failed** (a majority but not deterministic 8/8 — noted honestly, not inflated; still clearly load-bearing, consistent with this being the same append-log persistence pattern that was also non-deterministic-but-kept in the earlier #167/#168 correction); replay-strengthening disabled → exactly the 2 new strengthened tests failed, nothing else, positive control unaffected. Both restored byte-identical.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `node --test dist/tests/*.test.js`: **3094/3094 passing** (3090 after the engineering-store slice + 4 new in the plan-admission slice).
- Zero new runtime dependency (`durable-plan-admission-store.ts` deliberately avoids `node:crypto` to respect its own boundary test; `durable-engineering-store.ts` has no such constraint and reuses the repo's standard `randomUUID()`-based lock).
- `durable-outcome-job-store.ts` untouched — confirmed by diff; its own existing concurrency/replay tests continue to pass unmodified.

## Status

`IMPLEMENTED / SELF-VALIDATED` — re-derived directly on the active forward-port branch (`claude/akilta-continuity-readback-5hm3ed`), not a cherry-pick of the stale PR #145 commit. Part of the consolidated BACKLOG RESCUE packet (PR #145 comment `6294430140`) alongside DEPLOY-003, ORG-ONBOARD-001 (+ F1 correction), CXP-ACT-001, V5X-CAP-001, PROTO-HEADER-HARDENING, and SITE-INTEGRATION-001 Slice A V2. `MERGE_DISPOSITION: HOLD_MERGE` — pending a fresh exact-head independent REV218 review of the full consolidated candidate.
