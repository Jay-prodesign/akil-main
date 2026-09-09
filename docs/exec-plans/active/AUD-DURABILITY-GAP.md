# AUD-DURABILITY-GAP — Durable Store Concurrent-Writer + Fail-Closed Replay Hardening

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; Brain Handoff (Drive `1gjK-R58WPtUDBJPZY7x1NhivV1nkYlr9WV0qKEFb1p0`) Rev62 block, "FULL-SYSTEM / VERSION-COMPLETION GAPS" section, finding `AUD-DURABILITY-GAP`.
- **Selection reasoning**: after PR #25 merged (Rev70) and the resulting post-merge evidence was persisted, the corridor's next unresolved items were either Brain-verification-gated (awaiting a fresh Handoff revision) or large architecture-decision items (AUD-V5-GAP-01 authority ingress contract, AUD-V5-GAP-02 Cold-Start Website Build proof). The Founder explicitly asked whether genuine work existed that did not require waiting on Brain. A fresh scan of the still-unaddressed Rev62 findings found `AUD-DURABILITY-GAP` to be dependency-safe: it names a concrete, already-diagnosed defect in already-shipped local code, requires no architecture decision, no owner gate, and no external input — only local engineering hardening squarely within Claude's delegated authority.
- Brain's exact finding text (Rev62, verbatim, unchanged through Rev70):

  > **AUD-DURABILITY-GAP — LOCAL/REFERENCE DURABILITY IS NOT CONCURRENT-WRITER PROOF**
  >
  > - `FileDurableEngineeringStore`, `FileDurablePlanAdmissionStore`, and `FileDurableOutcomeJobStore` use read-current-content → concatenate line → rewrite-file behavior for existing files.
  > - This proves bounded local restart/replay behavior but is not safe evidence for concurrent multi-worker production persistence: two writers can read the same prior content and a later rewrite can lose the other writer's event/job.
  > - Replay also parses persisted JSON and type-casts it directly into domain event/job shapes rather than re-running full constructor/ingress validation.
  > - CLASSIFICATION: full-system durability/production-readiness gap, not a retrospective failure of a task that explicitly shipped a local/reference store. Before production/double-worker claims, replace or harden the persistence boundary and add concurrent-writer + corrupted/forged replay tests.

- Branch: `claude/aud-durability-gap-correction`, cut fresh from merged `main` after PR #25 (`fe2cbc02f20e800b309e127288cc32a72176c109`).
- `BASE_PROVENANCE_SHA`: `fe2cbc02f20e800b309e127288cc32a72176c109`.

## Goal

Close both halves of the Rev62 finding for all three durable stores, exactly as prescribed: (1) replace the read-modify-write append with a genuinely concurrent-writer-safe append, and (2) replace the blind `JSON.parse(...) as T` replay cast with fail-closed re-validation, then prove both with real adversarial and concurrency tests rather than asserting them.

## Scope (this checkpoint)

- `src/domain/durable-engineering-store.ts`:
  - `appendEvent` now writes via a single `appendFileSync` call (`O_APPEND`) instead of `readFileSync` + `writeFileSync(existing + line)`. `O_APPEND` positions each write at the current end-of-file atomically at write time (kernel-managed); it cannot lose an already-written concurrent writer's bytes, unlike the prior read-then-full-rewrite cycle, which is a textbook lost-update race.
  - `getEvents` no longer trusts `JSON.parse(line) as EngineeringEventEnvelope`. Each line is now re-run through the existing (unmodified) `createDec138Provenance`/`createEngineeringEventEnvelope` ingress validators — both already implement full field-level validation and required no changes, only reuse. A malformed-JSON, non-object, bare-array, or field-invalid line throws the new `CorruptedEngineeringEventLineError` (filePath + 1-indexed line number + reason) instead of silently flowing a corrupted/forged record into the reducer.
- `src/domain/plan-admission.ts`:
  - New exported `validatePersistedPlanAdmissionResult(raw: unknown): PlanAdmissionResult` — `admitPlan` itself has no "reconstruct from raw JSON" mode (it recomputes a fresh result from live plan/blueprint inputs), so this is the new ingress-validation counterpart for durable replay of the nested `result` field.
- `src/domain/plan-admission-event.ts`:
  - New exported `parsePersistedPlanAdmissionEvent(raw: unknown): PlanAdmissionEvent` — discriminates on `type`, validates every field with the same non-empty/non-whitespace rule the existing constructors enforce, and for `EVALUATION_RECORDED` re-validates the nested `result` via `validatePersistedPlanAdmissionResult`.
- `src/domain/durable-plan-admission-store.ts`:
  - `appendEvent` now writes via `appendFileSync`, mirroring the engineering store's fix.
  - `getEvents` re-runs each line through `parsePersistedPlanAdmissionEvent`, throwing the new `CorruptedPlanAdmissionEventLineError` on failure.
- `src/domain/outcome-job.ts`:
  - New exported `validatePersistedOutcomeJob(raw: unknown): OutcomeJob` — deliberately not a reuse of `createOutcomeJob` (which only ever produces a fresh `DRAFT` job and cannot reconstruct a job already advanced to any other lifecycle state). Validates all seven persisted fields, including that `state` is one of the eleven known `OutcomeJobState` literals.
- `src/domain/durable-outcome-job-store.ts`:
  - `putIfAbsent`'s write path now uses `appendFileSync`.
  - **Distinct TOCTOU race, also fixed**: `putIfAbsent`'s absence-check (`this.get(...)`) and its own append are not atomic with each other, so a concurrent writer can append a line for the same `jobId` in between. Since `dedupedByJobId`'s "first line in the file wins" rule makes on-disk append order the single source of truth, `putIfAbsent` now re-derives the true winner from disk immediately after its own append and compares it to what it just wrote: if another writer's line landed first, this call honestly returns `{ job: <true winner>, created: false }` instead of the optimistic `{ job, created: true }` it would otherwise have returned for a duplicate-jobId append it actually lost.
  - `readAll` re-runs each line through `validatePersistedOutcomeJob`, throwing the new `CorruptedOutcomeJobLineError` on failure.
- All four new/hardened validators (`validatePersistedPlanAdmissionResult`, `parsePersistedPlanAdmissionEvent`, `validatePersistedOutcomeJob`, and the engineering store's reuse of existing validators) reject a bare JSON array as well as a JSON object missing required fields — arrays pass `typeof x === "object"` in JavaScript, so this was checked explicitly (`Array.isArray`) rather than assumed.

## Explicitly deferred (not invented)

No change to the stores' public interfaces, no new runtime dependency, no replacement of the file-based persistence mechanism itself with a database/queue (Brain's finding says "replace or harden" — hardening the existing mechanism to be genuinely concurrent-writer-safe, without discarding the zero-dependency local/reference design, is the narrower and sufficient fix; a full persistence-layer replacement would be a larger architecture decision outside this bounded correction's scope). No change to any reducer (`reconstructState`, `reconstructPlanAdmissionState`, `dedupedByJobId`) — the fix is entirely at the write-atomicity and read-validation boundary the finding named.

## Architecture / semantic invariants (verified by test)

- Real, separate OS processes (not in-process Promises, which cannot reproduce a true concurrent-writer race under Node's single-threaded execution) appending to the same durable engineering store file lose zero events: 8 worker processes × 25 events each all land, all unique, none dropped.
- A malformed-JSON persisted line fails closed with a descriptive `Corrupted*LineError` (filePath + line number + reason) for all three stores, never a silent skip or an unhandled `SyntaxError`.
- A structurally valid JSON object missing required fields ("forged") fails closed the same way, for all three stores, including one level of nesting (an `EVALUATION_RECORDED` event with a structurally invalid nested `result.status`).
- A bare JSON array (valid JSON, `typeof === "object"`, but not a record) is explicitly rejected, not silently coerced into per-field `undefined` reads that surface a confusing internal error.
- `FileDurableOutcomeJobStore.putIfAbsent`'s TOCTOU race is closed: when another writer's line for the same `jobId` is already on disk by the time this call's own append lands, it reports `created: false` and returns the true first-on-disk winner.

## Hard Non-Scope

No filesystem-mechanism replacement, no queue/broker/database dependency, no change to any reducer's dedup/ordering semantics, no production deployment action, no change to any store's public method signatures.

## Test Coverage

| Test | Rev62 finding direction | Covered in |
|---|---|---|
| Real OS-process concurrent writers lose zero events | "two writers can read the same prior content and a later rewrite can lose the other writer's event" | `tests/durable-engineering-store-concurrency.test.ts` |
| Malformed JSON / forged / bare-array line fails closed (engineering store) | "replay... type-casts... rather than re-running full constructor/ingress validation" | `tests/durable-engineering-store.test.ts` (3 new AUD-DURABILITY-GAP tests) |
| Malformed JSON / unknown type discriminant / invalid nested result.status fails closed (plan-admission store) | same | `tests/durable-plan-admission.test.ts` (3 new AUD-DURABILITY-GAP tests) |
| Malformed JSON / invalid OutcomeJobState fails closed (outcome-job store) | same | `tests/durable-outcome-job-store.test.ts` (2 new AUD-DURABILITY-GAP tests) |
| `putIfAbsent` TOCTOU race-honesty | "a later rewrite can lose the other writer's event/job" (job-store-specific race, additional to the shared read-modify-write bug) | `tests/durable-outcome-job-store.test.ts` (1 new AUD-DURABILITY-GAP test) |
| Full pre-existing regression suite still green | no regression introduced | full `npm run test` |

## Evidence

- `rm -rf dist && npx tsc -p .`: exit 0, strict mode, zero errors, clean rebuild.
- `npm run test`: **715/715 pass**, 0 fail, 0 skipped, 0 cancelled (705 pre-existing + 10 new AUD-DURABILITY-GAP tests: 3 engineering-store, 3 plan-admission-store, 3 outcome-job-store adversarial + 1 race-honesty, plus the dedicated real-OS-process concurrency test — the concurrency test alone was independently re-run 3 additional times to confirm it is not flaky).
- `package.json`: zero new runtime or dev dependency.
- Files touched: `src/domain/durable-engineering-store.ts`, `src/domain/plan-admission.ts`, `src/domain/plan-admission-event.ts`, `src/domain/durable-plan-admission-store.ts`, `src/domain/outcome-job.ts`, `src/domain/durable-outcome-job-store.ts`, `tests/durable-engineering-store.test.ts`, `tests/durable-plan-admission.test.ts`, `tests/durable-outcome-job-store.test.ts`, `tests/durable-engineering-store-concurrency.test.ts` (new), `tests/helpers/concurrent-append-worker.ts` (new), this exec-plan.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain independent exact-head review of the full 40-character head SHA. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
