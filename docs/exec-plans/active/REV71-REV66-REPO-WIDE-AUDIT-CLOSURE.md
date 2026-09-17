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

## Category 4 — APP-I18N-001 TR/EN completeness: SATISFIED/NO DEFECT

Re-verified fresh (not reused-unchanged-by-assumption): `ShellCopy` (`src/web/shell-copy.ts`) is a single TypeScript interface both the `EN` and `TR` catalog objects must structurally satisfy — the compiler itself makes a missing key in either locale a build failure, not merely a lint suggestion, so structural parity is proven by `tsc --noEmit` passing, not by manual inspection alone. `shell-render.ts` contains zero hardcoded UI-facing string literals outside the `ShellCopy` catalog (verified by pattern scan; the only literal-string matches are TypeScript union/type literals, not rendered copy). `resolveRequestLocale` (`src/web/locale.ts`) is wired end-to-end through `request-handler.ts` into `renderShellPage`. The Rev71 Category 3 durable-store fixes are backend-only (no client-portal-facing surface), so no new copy was introduced this round. Unchanged from Rev66's original finding.

## Category 5 — Repo-wide TODO/FIXME/HACK/stub/suppression classification: SATISFIED/NO DEFECT

Fresh repo-wide re-scan (not reused from Rev66 Round 1 by assumption): zero `TODO`/`FIXME`/`HACK`/`XXX` markers anywhere in `src/`/`tests/`. Zero `test.skip`/`.only`/`test.todo`. The only `@ts-expect-error` occurrences are in `worker-routing-policy.test.ts`, each a deliberate compile-time-invalid-value negative test with an inline comment naming its purpose — an established, already-classified pattern, not a suppression of a real defect. The only `as unknown as`-cast occurrences are (a) test-only adversarial-input casts simulating invalid runtime values bypassing the compile-time union, and (b) branded-newtype reconstruction casts in `postgres-outcome-job-store.ts`/`durable-external-sale-bootstrap-store.ts`, in every case preceded by explicit fail-closed runtime validation (`requireNonEmptyStringField`, tenant/customer/project cross-reference checks, recognized-enum-member checks) before the cast — the same already-audited pattern, not a new unvalidated cast. No new suppression comment (`eslint-disable`, `@ts-ignore`) exists anywhere in the 3 files touched by Category 3's fixes. Nothing new since Rev66 Round 1's original sweep.

## Category 6 — Acceptance-contract → source → load-bearing-test trace: BLOCKED finding RESOLVED/CLOSED; no new gap found

Rev66 Round 2 recorded one genuine finding: `FileDurableOutcomeJobStore.putIfAbsent`'s cross-process TOCTOU race was fixed only on unmerged **PR #30** (`AUD-DURABILITY-GAP`), not on `main`/the audited branch — disposition **BLOCKED** (correct action: merge PR #30, not re-implement). That fix has since been forward-ported (Rev68), corrected across three further Brain review rounds (Rev69 journal-serialization, Rev70 crash-recoverable lock, Rev72 ABA-safe epoch scheme), and confirmed **Brain Rev73 PASS/VERIFIED** on PR #97. **This finding's disposition is updated from BLOCKED to RESOLVED/CLOSED**: the accepted durability primitive now exists, corrected and independently verified, in the current lineage; the only remaining action is the Founder/Brain-gated merge itself, which is unchanged out of engineering's authority and was never the blocked part of the finding (the blocked part — an un-forward-ported fix — is now closed).

Re-traced the acceptance contract for the 3 stores fixed in Category 3 against their own source doc comments and load-bearing tests: `durable-engineering-store.ts`'s own header states "nothing is silently dropped at the storage layer" (line 33-36) — this is now actually true (previously false under concurrent load) and is proven by `durable-engineering-store-concurrency.test.ts`. `durable-plan-admission-store.ts` carries an equivalent implicit contract via its mirrored design comment ("mirrors `DurableEngineeringStore`'s contract") — same fix, same proof via `durable-plan-admission-store-concurrency.test.ts`. `durable-external-sale-bootstrap-store.ts`'s own `putIfAbsent` doc comment ("the sole write path — there is no plain insert") is now backed by the same crash-consistency guarantee as its sibling stores, proven by the 2 new Rev71 F1 tests. No other acceptance-contract gap was found in these 3 files during this trace.

## Category 7 — Dependency/config/test-runner/package-script consistency: SATISFIED/NO DEFECT

`package.json` declares zero runtime dependencies (only `@types/node`/`typescript` devDependencies) — unchanged; the Category 3 fixes added no new dependency. `npm test` (`npm run build && node --test dist/tests/*.test.js`) globs every file directly under `tests/` matching `*.test.ts`; a fresh count confirms 163 `.test.ts` files under `tests/` (161 at the Category 1 checkpoint + the 2 new Category 3 concurrency-test files; the 2 new F1 tests were added to the pre-existing `durable-external-sale-bootstrap-store.test.ts`, not a new file) all correctly discovered — none nested, none misnamed, none in `tests/helpers/` (verified zero `*.test.ts` files under `helpers/`). `tsconfig.json`'s strict settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) are unchanged and were used correctly by all new Category 3 code. A full fresh regression run confirms **1740/1740 tests pass, 0 skipped, 0 todo, 0 cancelled**. Unchanged from Rev66.

## REV66 FINAL COMPLETION-CONFIDENCE STOP_PROOF (IMPLEMENTED/SELF-VALIDATED — Claude's own prepared evidence, not a final/authoritative closure declaration)

**Lineage:** `main` (`3226c76`) → PR #95 → PR #96 (Rev66 Rounds 1-3, prototype-chain hardening) → PR #97 (Rev68-72, `AUD-DURABILITY-GAP` forward-port + corrections, Brain Rev73 PASS/VERIFIED at `ae2c1a0`) → **PR #98** (`claude/rev71-rev66-repo-wide-closure-continuation`, this document's branch, Rev71 Categories 1-7).

**Commands/checks run:** `npm test` (`tsc -p tsconfig.json` strict build + `node --test dist/tests/*.test.js` full regression) run fresh at this checkpoint's head: **1740/1740 pass, 0 skipped, 0 todo, 0 cancelled**, `duration_ms 8943`. Strict typecheck clean (part of `npm run build`). Clean `dist/` rebuild confirmed (no stale artifacts). Zero new runtime dependency at any point in the Rev66/Rev71 arc.

**Findings and dispositions, all 7 Rev66/Rev71 categories:**
1. Test discovery/config/suppression inventory — **SATISFIED/NO DEFECT**.
2. Strict typecheck/build/lint/smoke — **SATISFIED/NO DEFECT**; no lint/static-analysis tool configured — **OUTSIDE_SCOPE** (unchanged, not a gap this task can unilaterally introduce).
3. Adversarial/fail-closed coverage — **3 concrete defects FIXED/VERIFIED** (`durable-engineering-store.ts`, `durable-plan-admission-store.ts` lost-update races; `durable-external-sale-bootstrap-store.ts` missing F1 reconciliation), each with adversarial tests and honest revert-based sanity-check disclosure.
4. APP-I18N-001 TR/EN audit — **SATISFIED/NO DEFECT**.
5. TODO/FIXME/HACK/stub/suppression classification — **SATISFIED/NO DEFECT**.
6. Acceptance-contract → source → test trace — **one prior BLOCKED finding (PR #30 durability race) RESOLVED/CLOSED** via the completed Rev68-73 forward-port arc; no new gap found in the 3 Category-3-touched stores.
7. Dependency/config/test-runner consistency — **SATISFIED/NO DEFECT**.

**Skip/suppression/TODO-stub inventory:** none found repo-wide (Category 5).

**Smoke/adversarial evidence:** `tests/web-http-server.test.ts` (real `node:http` end-to-end) passes as part of the full regression; every Category 3 fix carries a real-OS-process adversarial test plus an independent revert-based sanity check confirming it fails exactly its own proving test(s) and nothing else.

**Acceptance→source→test coverage disposition:** SATISFIED for all surfaces re-traced this round (Category 6); the one previously BLOCKED item is now RESOLVED/CLOSED as detailed above.

**Remaining classified trigger/protected/outside-scope items (explicitly not "no remaining gap anywhere in the repository," only "no remaining gap within this bounded 7-category audit's admitted scope"):** no lint/static-analysis tool (OUTSIDE_SCOPE, Category 2, unchanged since Rev66); the PR #30/#97/#98 merge/topology action itself remains Founder/Brain-gated (`HOLD_MERGE`/`NOT SAFE_MERGE`, customer-isolation HIGH/PROTECTED per Rev68's own framing) — engineering has no authority to merge, only to prepare and evidence.

**No remaining admitted actionable defect or readiness gap was found within this bounded audit's 7-category scope.** This STOP_PROOF is prepared as `IMPLEMENTED/SELF-VALIDATED` evidence per Claude's role boundary (`AGENTS.md`/`CLAUDE.md` §10) — declaring it final/authoritative-complete remains Brain's/Founder's decision alone.
