# AUDIT-DURABLE-001 — Durable AuditLog + ClientProjectSnapshot Delivery-Timeline Wiring

## Provenance

- Governing authority: Brain continuation on PR #145 (comment `6205619559`), issued immediately after PR #161's own F1/F2 correction round closed. REV216 (AA-005, "Founder Completion Directive / Continuous Software Finish Mode") remains controlling; Founder gate NONE.
- Reason given: `src/application/in-memory-audit-log.ts` explicitly declares itself a test adapter whose own doc comment discloses "production durable audit storage is deferred"; the canonical OS requires append-safe audit/evidence lineage; and `buildClientProjectSnapshot` already has an existing `auditEvents` input whose durable source is currently absent — an existing product contract with a real consumer, not speculative store coverage.
- Explicit scope boundary from the same comment: do not conflate `AuditEvent` with `EvidenceReference`/`VerificationResult` (`OperationalObservabilityView.auditEvidence` is a different domain type and stays separate unless a real adapter exists); prefer reuse of the existing audit-log contract; do not invent broader query/persistence abstractions unless a concrete consumer requires them.

## Reuse surface (read before designing)

- `src/domain/audit-event.ts` — `AuditEvent`/`createAuditEvent` (AKI-BE-001), reused unmodified. Its own construction-time invariants (non-empty, canonically-trimmed `eventId`/`actorRef`/`eventType`/`timestamp`/`reason`/each `relatedRefs` element; tenant/customer/job/project identity derived from a real `OutcomeJob`) are the exact floor the new durable store's own replay validation re-checks.
- `src/application/in-memory-audit-log.ts` — `InMemoryAuditLog`/`DuplicateAuditEventError` (AKI-BE-001). Its own doc comment ("production durable audit storage is deferred") is the explicitly-named gap this checkpoint closes. `DuplicateAuditEventError` is reused verbatim (imported, not redefined) so both `AuditLog` implementations throw the identical error type for the identical precondition.
- `src/application/durable-customer-repository.ts` (`CUSTOMER-REPO-DURABLE-001`) and `src/domain/durable-project-store.ts` (`PROJ-DURABLE-001`, including its own Brain F1 canonical-trim correction) — the established file-durable-store convention cloned for the new module: one JSON file per tenant under `baseDir`, a cross-process `linkSync` mutual-exclusion lock (Rev94 F1's own primitive), full structural revalidation of persisted JSON on every read, canonical-trim invariant applied from the start.
- `src/ports/customer-repository.ts` — the exact port/application split precedent mirrored here: `InMemoryAuditLog` already exists with no formal port (same situation `CustomerRepository`/`InMemoryCustomerRepository` were in before `AKI-BE-001`'s own port was named), so this checkpoint names `src/ports/audit-log.ts` directly from `InMemoryAuditLog`'s own pre-existing two-method contract, then retrofits `InMemoryAuditLog implements AuditLog` (no behavior change) and adds the new `FileDurableAuditLog` beside it.
- `src/domain/client-project-snapshot.ts`/`buildClientProjectSnapshot` and `src/domain/delivery-timeline.ts`/`buildDeliveryTimeline` — reused unmodified. `buildDeliveryTimeline` already fails closed on any `auditEvents` entry whose `tenantId`/`customerId`/`projectId` does not exactly match the given `project` — this is why the snapshot composer must filter the `AuditLog` port's own tenant-wide `findByTenant` result down to the exact project before passing it through, not invent a new project-scoped port method.
- `src/web/client-project-snapshot-durable-source.ts` (`CLIENT-SNAPSHOT-DURABLE-001`) — the existing composer extended with a third constructor argument (`auditLog: AuditLog`); its only caller is its own test file (not wired into any production route, matching every sibling adapter's established precedent).

## Scope (this checkpoint)

### Part 1 — `AuditLog` port (`src/ports/audit-log.ts`)

- Names `InMemoryAuditLog`'s own existing, unmodified two-method contract: `append(event: AuditEvent): void`; `findByTenant(tenantScope: TenantScope): ReadonlyArray<AuditEvent>`. Deliberately no update/remove method — append-only by contract, not merely by convention.
- `InMemoryAuditLog` retrofitted to `implements AuditLog` — pure type-level change, zero behavior difference, zero existing test touched.

### Part 2 — `FileDurableAuditLog` (`src/application/durable-audit-log.ts`)

- One JSON array file per tenant under `baseDir`, keyed by tenant only (no compound key — the per-tenant file itself already provides exact tenant isolation, same reasoning `FileDurableCustomerRepository` already documented for its own plain-`customerId` key).
- Per-tenant `linkSync` lock around `append`'s read-check-append-write critical section, closing the one real concurrency hazard this contract has: two processes appending different `AuditEvent`s into the same tenant file at the same time could otherwise race on a torn whole-file read-modify-write and silently lose one append. Proven by a 5-process real-OS-process race test, not merely asserted. The same lock naturally also serializes the duplicate-`eventId` check, so a same-`eventId` race is closed for free by the same mechanism.
- `DuplicateAuditEventError` reused verbatim from `in-memory-audit-log.ts` (imported) — not redefined, so both implementations of `AuditLog` throw the identical error type.
- Full replay revalidation on every read: non-empty canonically-trimmed `eventId`/`tenantId`/`customerId`/`jobId`/`projectId`/`actorRef`/`eventType`/`timestamp`/(optional)`reason`, cross-tenant contamination check (stored file's tenant vs. record's own `tenantId`), and a `relatedRefs` array of canonically-trimmed, non-empty strings.

### Part 3 — ClientProjectSnapshot delivery-timeline wiring (`src/web/client-project-snapshot-durable-source.ts`)

- `createDurableClientProjectSnapshotSource` gains a third required parameter, `auditLog: AuditLog`. `getSnapshot` now calls `auditLog.findByTenant({ tenantId: project.tenantId })` and filters the result to the exact project's own `customerId`/`projectId` before passing it to `buildClientProjectSnapshot` as `auditEvents` — required, not optional, because `buildDeliveryTimeline` itself fails closed on any foreign-project event rather than silently dropping it.
- The `AuditLog` port's own `findByTenant` contract is preserved exactly (no new project-scoped query method invented) — the project-scoping filter lives in this composer, the one genuinely novel guard this checkpoint adds here.

## Explicitly deferred (not fabricated)

- **`AuditEvent` stays structurally distinct from `EvidenceReference`/`VerificationResult`.** `OperationalObservabilityView.auditEvidence` remains unchanged and unwired — a different domain type, per the governing comment's own explicit instruction.
- **No new project-scoped query method on the `AuditLog` port.** The existing tenant-wide `findByTenant` plus client-side filtering in the one real consumer is the smallest coherent extension; a broader persistence/query abstraction is not invented absent a second consumer that needs it.
- **Not wired into any live HTTP route.** Mirrors every sibling `ClientProjectSnapshotSource`-adjacent adapter's own established precedent exactly.

## Hard Non-Scope

No modification to `audit-event.ts`, `client-project-snapshot.ts`, `delivery-timeline.ts`, or any `/portal` route composition file. No new HTTP route. No conflation of `AuditEvent` with `EvidenceReference`/`VerificationResult`. No real billing-provider/IdP/credential anywhere. No production deploy, no DNS, no MAIN mutation, no self-merge.

## Mandatory adversarial witnesses

- `tests/durable-audit-log.test.ts` (15 tests): save/find round-trip, duplicate-eventId rejection (zero mutation), empty-tenant lookup, cross-tenant isolation, multiple-events-ordering, restart-reconstruction, and 8 corrupted-file adversarial cases (not-JSON, non-array, cross-tenant contamination, empty/whitespace actorRef, canonical-trim violation on eventType, relatedRefs-not-an-array, relatedRefs-element-whitespace, whitespace-corrupted optional reason).
- `tests/durable-audit-log-concurrency.test.ts` (1 test) + `tests/helpers/audit-log-race-worker.ts`: 5 real OS-level spawned processes appending 5 different `eventId`s into the same shared tenant file concurrently — every worker's append survives (proving the lock prevents a torn read-modify-write lost update), confirmed again on a fresh store instance (restart-safety).
- `tests/web-client-project-snapshot-durable-source.test.ts` (+2 new tests, 8 total): a real durable audit event for the exact current project reaches `snapshot.timeline.entries`; a different project's audit event in the same tenant-wide `findByTenant` result is filtered out, never leaking into this project's timeline.

## Guard-disable sanity

- **`FileDurableAuditLog`**: the cross-tenant contamination check and the canonical-trim invariant were each independently disabled and the suite rebuilt. Disabling the cross-tenant check broke exactly its own dedicated adversarial test. Disabling the trim check broke exactly the two tests that depend specifically on trim detection (eventType, reason) — the whitespace-only variants (actorRef, relatedRefs element) still failed closed via the pre-existing non-empty check, confirming defense-in-depth rather than a redundant guard. No other test regressed in either case. Both guards were then restored and verified byte-identical to the pre-edit source via `diff`.
- **Project-scoping filter in `client-project-snapshot-durable-source.ts`**: disabled (replaced with the bare tenant-wide `findByTenant` result) and the suite rebuilt — exactly the "different project's audit event is filtered out" test failed, surfacing the real `InvalidDeliveryTimelineError` uncaught from `buildDeliveryTimeline` itself (confirming the filter is the first guard, with the domain function's own fail-closed check as defense-in-depth behind it). No other test regressed. Restored and verified byte-identical via `diff`.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **2964/2964 passing** (2947 pre-existing + 17 new).
- Zero new runtime dependency.

## Brain correction (F1)

Brain's independent review of exact head `c2811ba6d0adafb46c219bb83de97485b261a81d` (PR #162 comment `6211081375`) found a port-semantics drift: `InMemoryAuditLog`'s own `#seenEventIds` is a SINGLE global `Set`, so `eventId` uniqueness is global across the entire log, never scoped to a tenant. The original `FileDurableAuditLog` checked duplicates only inside the current tenant's own file, so the identical `eventId` could be appended once per tenant without ever colliding — adapter-dependent behavior behind the same `AuditLog` port, with no canonical/domain evidence that tenant-scoped uniqueness was ever the intended contract.

**Fix**: preserved the pre-existing global-uniqueness semantics exactly rather than widening the in-memory adapter to match the (wrong) durable one. A second, separate global index file (`__global-event-index__.json`, the full set of every `eventId` ever appended across every tenant) is read-checked-written under a single GLOBAL lock (not per-tenant) that serializes every `append` call system-wide — exactly mirroring how `InMemoryAuditLog`'s own single-threaded, single-`Set` design already serializes every append in-process. `findByTenant` is entirely unaffected: reads remain lock-free, single-tenant-file reads, so tenant read isolation is not weakened by this fix.

**Test changes**: a same-`eventId`/different-tenant parity test now runs against BOTH `AuditLog` implementations (`InMemoryAuditLog` and `FileDurableAuditLog`) and asserts they reject identically. Two new corrupted-global-index-file adversarial tests. A new 5-process real-OS-process race test proves the specific hazard Brain named: concurrent writers in DIFFERENT tenants appending the SAME `eventId` — exactly one succeeds, every other fails closed with `DuplicateAuditEventError`, and exactly one tenant's file ends up holding the event (no duplicate admission, no lost write).

**Guard-disable sanity**: the global-uniqueness check was disabled and the suite rebuilt. Exactly 3 tests failed: the basic duplicate-rejection test, the durable-side parity test, and the new cross-tenant race test — precisely the tests that depend on this check. No other test regressed. Restored and verified byte-identical to the pre-edit source via `diff`.

Full regression after the fix: **2969/2969 passing** (2964 pre-existing + 5 new), clean strict typecheck, zero new runtime dependency. New exact head: see PR #162's latest commit.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
