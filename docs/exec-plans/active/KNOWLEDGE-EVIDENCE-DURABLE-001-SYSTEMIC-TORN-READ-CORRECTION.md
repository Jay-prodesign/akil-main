# KNOWLEDGE-EVIDENCE-DURABLE-001 — Systemic Torn-Read/Lost-Write Correction (Brain Batch-Merge-Review CHANGES_REQUIRED)

## Provenance

- Governing instruction: Brain's independent batch merge review of PR #167 exact head `3cca9d034752cdfffd9574294f8fb4f77f367664` (PR #145 comment `6280195112`), CHANGES_REQUIRED — the consolidated `MERGE_READY`/`BUILDABLE_NOW: none` report was premature: this candidate's own CI investigation (the `FileDurableProjectStore` torn-read fix) had already identified a systemic hazard class and corrected only two of the components actually in the integrated chain, leaving the identical unlocked-read pattern live in seven more named components plus one (`FileDurableOutcomeJobStore`) with no lock at all.
- Correction performed on the active branch (`claude/knowledge-evidence-durable-001`), per Brain's explicit instruction — no new PR, no merge, no MAIN mutation.

## Scope — every FileDurable* component in the #167 integrated chain with concurrent read/write access to a shared file

Audited all 12 such components. Findings and fixes:

### Already fixed before this correction (same session, earlier CI-driven fix)
- `FileDurableProjectStore`, `FileDurableEvidenceReferenceStore` — `get`/`list*` now share the existing per-tenant `withTenantLock` with `create`/`update`.

### Whole-file-rewrite pattern — same fix applied (reads now share the existing per-tenant lock)
- `FileDurableOrganizationServicePrincipalStore` (`get`/`listByTenant`)
- `FileDurableOrganizationMembershipStore` (`get`/`listByTenant`)
- `FileDurableCustomerRepository` (`findByTenantAndId`)
- `FileDurableCustomerOffboardingRequestStore` (`get`/`list`/`listPending`)
- `FileDurableConnectorConnectionStore` (`get`/`list`)

### Global-index+tenant-file pattern — `FileDurableAuditLog`
- `findByTenant` now acquires the same `withGlobalLock` `append` already uses (this store has no per-tenant lock — uniqueness is global, one lock already serializes every write).
- New dedicated witness: a real reader process racing five real writer processes mid-append. **Without the fix: 10/10 runs failed.** With the fix: clean.

### Append-log pattern — `FileDurableOrganizationResourceBindingStore`, `FileDurableProtectedDecisionRecordStore`
- Both already had a per-record-id `linkSync` creation lock (proving exactly one winner per id) but no coordination over the SHARED per-tenant `.jsonl` file itself. Added a second, coarser `linkSync` lock keyed by `tenantId` alone, acquired by every read and by each `appendFileSync` call (never nested inside the per-id creation-lock dance).
- New dedicated witness (`durable-organization-resource-binding-store-concurrency.test.ts`, stands for both per Brain's own instruction not to duplicate a test per shared primitive): five processes each `putIfAbsent` a different id into the same shared file, interleaved reads. **Did not force a reproducible corruption locally even without the added lock** — `appendFileSync`'s small single-syscall writes appear safe in practice. Treated as inconclusive, not proof: this is the exact same evidentiary position the Project-store defect was in before a real CI run (never a local one) exposed it. **The lock is kept, not removed, on that basis.**

### "Shared file, lock keyed by the wrong identity" — `FileDurableConfigurationPolicyDecisionStore` (Brain's own named special-attention item)
- Pre-existing lock was keyed by `(tenantId, decisionKey, decisionId)` — an idempotency guard for one decisionId, not a lock over the shared decision-log FILE, which is keyed only by `(tenantId, decisionKey)` and can receive many decisionIds over its lifetime. Added a second `linkSync` lock keyed by `(tenantId, decisionKey)` — the file's own identity — acquired by every read method and by the entirety of `appendDecisionProjection` (wrapping, not replacing, the existing per-decisionId arbitration).
- New dedicated witness: five processes each append a different decisionId into the same `(tenantId, decisionKey)` file, interleaved reads. Same result as the append-log pattern above (no local repro either way) — lock kept on the same conservative basis.

### Zero lock at all — `FileDurableOutcomeJobStore` (the most severe finding)
- Unlike every sibling store, this one had **no lock whatsoever**: `putIfAbsent` performed an unguarded read-modify-`writeFileSync` (whole-file truncate-then-rewrite). This is a **lost-write** hazard, not merely a torn-read one — two concurrent writers for different jobIds could each read the same prior content and the second write could silently discard the first's entirely.
- Fixed: added the standard `linkSync`-based per-tenant lock (cloned verbatim from every sibling store), now guarding the whole `putIfAbsent` critical section and every read method.
- New dedicated witness: five processes `putIfAbsent`-ing different jobIds concurrently, interleaved reads. **Without the fix: 8/8 runs failed** (reliably reproducible locally, unlike the torn-read-only hazards — a lost-update race has a much larger timing window than a single write() syscall's atomicity gap). With the fix: clean.

## New import-boundary consequence

`FileDurableOutcomeJobStore`'s own boundary test (`OS-V0-03 B13`) asserts an exact allow-list of import specifiers (no `node:crypto`). Generated the lock's temp-file uniqueness via `process.pid` + `process.hrtime.bigint()` instead of `randomUUID()` to avoid introducing a new import specifier. Three other stores (`durable-organization-resource-binding-store.ts`, `durable-protected-decision-record-store.ts`, `durable-configuration-policy-decision-store.ts`) have their own boundary tests asserting the literal string `Date.now()` never appears in source (every timestamp must be caller-supplied) — converted their new locks' timeout from a wall-clock deadline to a bounded retry-count (`MAX_LOCK_ATTEMPTS = 1000` at the same 5ms backoff ≈ the same ~5s budget) to respect that invariant without weakening the lock's own bounded-wait guarantee.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **3037/3037 passing** (3033 pre-existing + 4 new dedicated race witnesses).
- 5x repeated runs of all 10 affected concurrency test files (50 runs total): 0 failures.
- Guard-disable sanity performed for every NEW witness (outcome-job, organization-resource-binding, configuration-policy-decision, audit-log read-race): each correctly fails without its corresponding fix (outcome-job: 8/8 fail; audit-log: 10/10 fail; the two append-log witnesses did not force a local repro either way — treated as inconclusive per the epistemic note above, not as "fix unnecessary"). All restores verified byte-identical via `diff`.
- The five whole-file-rewrite stores fixed by the identical, verbatim-cloned lock pattern already proven via `FileDurableProjectStore`'s own guard-disable sanity (same session, earlier correction) were not each individually guard-disable-tested again — the pattern is mechanical and identical, and their own pre-existing test suites pass cleanly across 5 repeated runs each.
- Zero new runtime dependency.

Status: `IMPLEMENTED / SELF-VALIDATED` — correction applied directly to PR #167's active branch per Brain's instruction, not a new PR. `MERGE_DISPOSITION: HOLD_MERGE`, pending Brain's own re-review of this exact correction.
