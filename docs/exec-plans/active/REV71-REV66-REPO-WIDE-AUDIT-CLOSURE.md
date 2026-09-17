# REV71 — Founder-Confirmed Rev66 Repo-Wide Audit Closure Continuation

## Authorization

AA-005 Rev71 (Founder-confirmed, "EXECUTE WITHOUT FOUNDER RELAY"): after PR #97 (AUD-DURABILITY-GAP forward-port) passes, do not stop or issue final STOP_PROOF — immediately resume and exhaust the remaining Rev66 repo-wide bounded audit surfaces from the current composed lineage. Seven required categories: (1) test discovery/config/suppression inventory; (2) strict typecheck/build/lint/smoke; (3) adversarial/fail-closed coverage across auth/tenant/customer/project/authority/provenance, subscriptions/entitlements, connectors/durable stores, persistence/domain invariants, replay/idempotency/concurrency/error paths; (4) APP-I18N-001 TR/EN audit; (5) repo-wide TODO/FIXME/HACK/stub/suppression classification; (6) acceptance-contract → source → load-bearing-test trace; (7) dependency/config/test-runner/package-script consistency and deterministic/replay/idempotency/error-handling edges.

Brain Rev73 confirmed PR #97's Rev72 correction PASS/VERIFIED (exact head `ae2c1a0`) before this continuation began — the durability edge that blocked this audit's closure is now resolved. This document tracks the Rev71 continuation, branched from PR #97's PASS head (`claude/rev71-rev66-repo-wide-closure-continuation`).

## Category 1 — Test discovery/configuration integrity: SATISFIED/NO DEFECT

Re-verified against the current lineage (161 test files, up from 157 at Rev66 — the +4 are the new durable-outcome-job-store race/witness test files added during the PR #97 correction rounds): `package.json`'s `node --test dist/tests/*.test.js` matches every `.test.ts` file, all directly under `tests/` (none nested/hidden). Zero `.skip(`/`.only(`/`test.skip`/`describe.skip`/`it.skip` anywhere. Full regression confirms `0 skipped`, `0 todo`, `0 cancelled` every run.

## Category 2 — Strict typecheck/build/lint/smoke: SATISFIED/NO DEFECT

Strict `tsc --noEmit -p .` clean. Clean `dist/` rebuild. No lint/static-analysis tool configured (unchanged from Rev66) — classified **OUTSIDE_SCOPE**. Smoke tests (`tests/web-http-server.test.ts`, real `node:http` server end-to-end) pass as part of the full regression.

## Category 3 — Adversarial/fail-closed coverage: 3 concrete defects FIXED/VERIFIED

Rev66 Round 1-3 already closed the caller-controlled-prototype-chain bug class repo-wide (exhaustive sweep, zero remaining instances) and the Rev102 F1 timestamp-ordering class. This round audited this repository's five `FileDurable*Store` implementations specifically for the concurrency/crash-consistency bug classes discovered and closed during the PR #97 correction arc (Rev68-72), since those corrections were themselves proof that this exact bug class exists in this codebase and had not previously been swept repo-wide.

**Finding 1 & 2 — unlocked read-modify-write races** (`durable-engineering-store.ts`'s `appendEvent`, `durable-plan-admission-store.ts`'s `appendEvent`): both used `existsSync` → `readFileSync` → `writeFileSync(existing + line)` — the exact TOCTOU lost-update race already found and fixed in `durable-outcome-job-store.ts` prior to this session's work. Two concurrent `appendEvent` calls for the same run/plan could both read the same content and one's write would silently discard the other's event, directly contradicting `durable-engineering-store.ts`'s own documented invariant ("nothing is silently dropped at the storage layer"). **Fixed**: both replaced with a single `appendFileSync` call — one atomic `write(2)` in append mode, no read-modify-write cycle possible. Zero behavior change for the non-concurrent case (all existing tests pass unchanged).

**Finding 3 — missing F1 crash-consistency reconciliation** (`durable-external-sale-bootstrap-store.ts`): this store already had the Rev94 F3 `linkSync`-based atomic-creation-lock primitive, but had never received the Rev68 F1 self-healing correction — a process killed after `linkSync` succeeds but before its own `appendFileSync` completes leaves the record permanently invisible to `get()`/`putIfAbsent()` forever, exactly PR #30/Rev68's original F1 finding. **Fixed** by porting the exact `FileDurableOutcomeJobStore` design proven correct through Rev69/Rev70/Rev72 (tenant-journal epoch scheme, `appendRecordIfAbsentLocked`, `reconcileOrphanedLocks`) — implemented correctly on the first attempt here rather than re-discovering the same three correction rounds, since the proven design was already in hand.

### Adversarial tests added

- `tests/durable-engineering-store-concurrency.test.ts` + `tests/helpers/engineering-store-append-worker.ts`: 10 real OS processes concurrently append distinct events to the same run; asserts all 10 survive with no lost update.
- `tests/durable-plan-admission-store-concurrency.test.ts` + `tests/helpers/plan-admission-store-append-worker.ts`: identical pattern for `ANSWER_RECORDED` events on the same plan.
- `tests/durable-external-sale-bootstrap-store.test.ts`: two new tests — an F1 crash-recovery witness (pre-planted orphaned creation lock heals via `get()`, durable across a fresh store instance, `putIfAbsent` retry does not duplicate) and an F1 corrupted-lock fail-closed proof (malformed JSON and referentially-invalid lock content both fail closed with the new `CorruptedExternalSaleBootstrapLockError`).

### Sanity-check disclosure

Each fix was independently reverted and reconfirmed to cause exactly its own proving test(s) to fail, nothing else:
- `durable-engineering-store.ts`: reverted to the read-modify-write race — the new concurrency test failed reliably (3/3 runs).
- `durable-plan-admission-store.ts`: same revert, same reliable (3/3) failure.
- `durable-external-sale-bootstrap-store.ts`: reconciliation disabled — exactly the 2 new F1 tests failed, all 12 pre-existing tests still passed.

All three fixes restored and full regression reconfirmed green after each.

**1740/1740 tests pass** (1736 base at Rev73 + 4 new: 2 concurrency tests, 2 F1 witness tests), strict typecheck clean, clean `dist/` rebuild, zero new runtime dependency.

## Remaining categories (4-7): in progress

This document will be updated as categories 4-7 are worked through.
