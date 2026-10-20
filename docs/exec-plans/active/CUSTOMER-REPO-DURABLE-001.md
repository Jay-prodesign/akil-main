# CUSTOMER-REPO-DURABLE-001 — Durable CustomerRepository + Authenticated Staff Offboarding Decision Boundary

## Provenance

- Governing authority: **REV216** (AA-005, "Founder Completion Directive / Continuous Software Finish Mode," 2026-10-15). Independently verified before acting on it — not accepted on a bare PR-comment claim: cross-checked via Drive `modifiedTime` advance (`2026-10-11T08:24:11.833Z` → `2026-10-15T14:35:07.611Z`) and a full fresh-read of the document's content, then further independently verified the specific factual claim inside it (that `CustomerRepository`/`InMemoryCustomerRepository` already exist) directly against the filesystem before proceeding.
- REV216 explicitly supersedes the prior per-item "explicit Founder authorization required" restriction for bounded internal engineering primitives of the kind this checkpoint is, and explicitly names both deliverables: a durable `CustomerRepository` implementation, and "the deferred authenticated staff offboarding decision boundary" that implementation unlocks.
- REV216 corrects a prior session's wrong premise (recorded in `CUS-OFFBOARD-DURABLE-001`'s own "fresh-scan result on the mutation-boundary follow-up question") that no `Customer`-lookup capability existed at all. It did: `src/ports/customer-repository.ts` (`CustomerRepository`) and `src/application/in-memory-customer-repository.ts` (`InMemoryCustomerRepository`, `AKI-BE-001`) have existed since the first checkpoint in this repository, with production storage explicitly disclosed as deferred in that module's own doc comment. This checkpoint closes exactly that disclosed gap.

## Reuse surface (read before designing)

- `src/ports/customer-repository.ts` — the existing `CustomerRepository` port (`save(customer): void`; `findByTenantAndId(tenantScope, customerId): Customer | undefined`). Unmodified.
- `src/application/in-memory-customer-repository.ts` — the existing reference implementation. Unmodified; its own CXP-001W doc comment (compound-tuple key needed only because it uses a single global `Map`) informed the new store's own key design (see below).
- `src/domain/customer.ts` — `Customer`, `LearningEligibility`, `createCustomer`'s own construction-time invariants (non-empty, canonically-trimmed `customerId`/`displayName`; `learningEligibility` can currently only ever be `"NONE"`).
- `src/domain/durable-project-store.ts` (`PROJ-DURABLE-001`, including its own Brain F1 correction) and `src/domain/durable-outcome-job-store.ts` — the established file-durable-store convention cloned for the new module: one JSON file per tenant under `baseDir`, a cross-process `linkSync` mutual-exclusion lock (Rev94 F1's own primitive), `Object.create(null)` prototype-pollution-safe dictionaries, full structural revalidation of persisted JSON on every read, and — applied from the start here rather than as a later fix — `PROJ-DURABLE-001`'s own F1 canonical-trim invariant (`value.trim() !== value` fails closed).
- `src/web/connector-connection-admin-access.ts` (Rev188 F2) — the exact precedent mirrored for the new offboarding decision boundary: authenticate first via `requireInternalOsAccess`, then delegate to the pure domain function with the now-proven `context.access`/`context.membership`. Confirmed via grep this precedent is deliberately not wired into any live HTTP route, only its own test — establishing the same scope boundary for this checkpoint's new boundary.
- `src/web/internal-os-access.ts` — `requireInternalOsAccess` (authenticates + requires `access.decision === "GRANTED"` + `READ` permission), reused unmodified.
- `src/domain/customer-offboarding.ts` — `completeCustomerOffboarding`/`denyCustomerOffboarding`, both reused unmodified, including their pre-existing asymmetry (only completion requires `currentAccess` with `canPerformProtectedActions`; denial requires only `decidingAuthorityPrincipalRef`).
- `src/domain/durable-customer-offboarding-request-store.ts` (`DurableCustomerOffboardingRequestStore`) — reused unmodified for request lookup/transition.

## Scope (this checkpoint)

### Part 1 — `FileDurableCustomerRepository` (`src/application/durable-customer-repository.ts`)

- Implements the existing `CustomerRepository` port with no new runtime dependency (`node:fs`/`node:crypto` only), matching every other durable store in this repository.
- One JSON file per tenant under `baseDir`, keyed by plain `customerId` (not compound — the per-tenant file itself already provides exact tenant isolation, unlike `InMemoryCustomerRepository`'s single global map).
- `save` is a plain, unconditional upsert, matching the port's own signature exactly (no version field, no "already exists" rejection invented beyond what the port asks for).
- Per-tenant `linkSync` lock around the read-check-write critical section in `save`, closing the one real concurrency hazard this contract has: two processes saving different `customerId`s into the same tenant file at the same time could otherwise race on a torn whole-file read-modify-write and silently lose one write.
- Full replay revalidation on every read: non-empty canonically-trimmed `tenantId`/`customerId`/`displayName`, cross-tenant contamination check (stored file's tenant vs. record's own `tenantId`), stored-key-identity check (dict key vs. record's own `customerId`), and `learningEligibility` restricted to the one value `createCustomer` can ever actually produce (`"NONE"`).

### Part 2 — `customer-offboarding-decision-access.ts` (`src/web/customer-offboarding-decision-access.ts`)

- `completeCustomerOffboardingAsAuthenticatedStaff` and `denyCustomerOffboardingAsAuthenticatedStaff`: two separate functions (not a combined union), mirroring the domain layer's own pre-existing asymmetry faithfully rather than widening or narrowing it.
- Both call `requireInternalOsAccess` first; a forged identity fails there, before either domain function or either durable store is ever reached — zero store mutation either way.
- `completeCustomerOffboardingAsAuthenticatedStaff` looks up both the `CustomerOffboardingRequest` and the `Customer` it names fresh from the two real durable stores (never a caller-supplied copy of either), using the request's own `customerId` — a caller cannot substitute a mismatched tenant's/customer's record because there is no such parameter to mismatch.
- New errors: `CustomerOffboardingRequestNotFoundError`, `CustomerNotFoundForOffboardingDecisionError`.

## Explicitly deferred (not fabricated)

- **Not wired into any live HTTP route or render path.** Mirrors `connector-connection-admin-access.ts`'s own established precedent (confirmed via grep) exactly — this checkpoint supplies the authenticated boundary function only, not production route/UI wiring.
- No change to `completeCustomerOffboarding`/`denyCustomerOffboarding`'s own existing domain contract or asymmetry.
- No compound-key design for the new durable repository — deliberately unnecessary given per-tenant file isolation (see Reuse surface).

## Hard Non-Scope

No modification to `src/ports/customer-repository.ts`, `src/application/in-memory-customer-repository.ts`, `src/domain/customer.ts`, `src/domain/customer-offboarding.ts`, or any `/portal`/`/os/admin` route composition file. No new HTTP route. No real billing-provider/IdP/credential anywhere. No production deploy, no DNS, no MAIN mutation, no self-merge.

## Mandatory adversarial witnesses

- `tests/durable-customer-repository.test.ts` (14 tests): save/find round-trip, upsert-overwrite, unknown-id lookup, cross-tenant isolation, multiple-customers-per-tenant, restart-reconstruction (fresh instance over same `baseDir`), and 7 corrupted-file adversarial cases (not-JSON, non-object, cross-tenant contamination, stored-key mismatch, empty/whitespace `displayName`, unrecognized `learningEligibility`, non-canonically-trimmed fields).
- `tests/durable-customer-repository-concurrency.test.ts` (1 test) + `tests/helpers/customer-repository-race-worker.ts`: 5 real OS-level spawned processes saving 5 different `customerId`s into the same shared tenant file concurrently — every worker's write survives (proving the lock prevents a torn read-modify-write lost update), confirmed again on a fresh store instance (restart-safety).
- `tests/customer-offboarding-decision-access.test.ts` (11 tests): golden-path complete, golden-path deny, forged-identity (complete), revoked-membership (complete), authority-insufficient (complete), self-completion-blocked (complete), request-not-found (complete), customer-not-found (complete), stale-version-conflict (complete), request-not-found (deny), forged-identity (deny).

## Guard-disable sanity

- **`FileDurableCustomerRepository`**: the stored-key-identity check and the `learningEligibility` recognized-value check were each independently disabled and the suite rebuilt; each disablement caused exactly its own matching adversarial test to fail (surfacing the real corrupted value uncaught) with no other regression, confirming both guards are load-bearing. Each guard was then restored and verified byte-identical to the pre-edit source via `diff` before the final regression run.
- **`completeCustomerOffboardingAsAuthenticatedStaff`**: the two not-found guards (`CustomerOffboardingRequestNotFoundError`, `CustomerNotFoundForOffboardingDecisionError`) were disabled together (replaced with non-null assertions) and the suite rebuilt: exactly tests #7 ("adversarial (not found): completing a nonexistent request...") and #8 ("adversarial (customer not found)...") failed — both surfacing as `TypeError: Cannot read properties of undefined`, the expected guard-disable-sanity signal — while all 9 other tests in that file continued to pass. The guards were then restored and verified byte-identical to the pre-edit source via `diff`.

## Evidence

- Clean rebuild (`rm -rf dist && npx tsc -p tsconfig.json`): exit 0.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `node --test dist/tests/*.test.js`: **2941/2941 passing**.
- Zero new runtime dependency.

## Brain correction (F1)

Brain's independent review of exact head `ed44bc2b419853dd920ab4683d68a4500481a2ce` (PR #161 comment `6205583270`) found a cross-tenant authority defect in `denyCustomerOffboardingAsAuthenticatedStaff`: `requireInternalOsAccess` only proves authority for `input.organization`, but the function then used the SEPARATELY caller-supplied `input.tenantScope` for the actual request-store lookup and mutation. `denyCustomerOffboarding`'s own domain contract performs no tenant check at all (unlike `completeCustomerOffboarding`, which happens to catch a tenant mismatch, but only after an already-completed cross-tenant store read), so an authenticated Organization-A principal could supply Tenant B's `tenantScope` plus a known B `requestId` and transition B's REQUESTED record to DENIED using A's own authenticated identity.

**Fix**: both `completeCustomerOffboardingAsAuthenticatedStaff` and `denyCustomerOffboardingAsAuthenticatedStaff` now require `input.tenantScope.tenantId === context.access.tenantId` immediately after `requireInternalOsAccess` returns, BEFORE any request-store lookup. `context.access.tenantId` is `requireInternalOsAccess`'s own proven-equal-to-`input.organization.tenantId` value (enforced inside `resolveEffectiveOrganizationAccess` itself), so this is the one authoritative tenant for the whole authenticated call — `tenantScope` is never trusted as an independent dimension again once this check passes. New error: `CustomerOffboardingTenantScopeMismatchError`.

**Test changes**: two new adversarial tests — cross-tenant deny and the analogous cross-tenant completion boundary (per Brain's own instruction, added even though completion was already defense-in-depth protected by the domain function's own later check) — both proving zero mutation and the correct new error type.

**Guard-disable sanity**: the new check was disabled in both functions and the suite rebuilt. Exactly the 2 new tests failed: the cross-tenant *deny* case surfaced the real exploit (the mutation would have silently succeeded — no exception at all), and the cross-tenant *complete* case failed only on the expected error type (it still fails closed via the domain function's own older, later-catching tenant check, confirming that path was already defense-in-depth protected, while deny had none at all). No pre-existing test regressed. The check was then restored and verified byte-identical to the pre-edit source via `diff`.

Full regression after the fix: **2943/2943 passing** (2941 pre-existing + 2 new), clean strict typecheck, zero new runtime dependency. New exact head: `428d832`.

## Brain correction (F2)

Brain's independent review of exact head `428d832` (PR #161 comment `6205597388`) found a second authority defect in the same boundary: `denyCustomerOffboardingAsAuthenticatedStaff` authenticates through `requireInternalOsAccess`, whose minimum floor is READ, then called `denyCustomerOffboarding` with only a bare `decidingAuthorityPrincipalRef` string — the domain denial function itself revalidated no `EffectiveAccessResolution`, tenant authority, or mutation permission. Result: an ordinary READ-only staff member could terminalize a customer offboarding request as DENIED, inconsistent with the repository's accepted admin-mutation precedent (`connector-connection-admin-mutation.ts`), which re-resolves authority immediately before state change rather than treating authentication/membership alone as mutation permission.

**Fix**: `denyCustomerOffboarding` now takes `currentAccess: EffectiveAccessResolution` — exactly mirroring `completeCustomerOffboarding`'s own existing discipline, per Brain's explicit preference, so a non-web caller cannot bypass this floor either. It requires GRANTED decision, the SAME tenant as the request, a real `membershipId`, and WRITE permission before denying. Deliberately WRITE, not `canPerformProtectedActions` — that stronger protected-action bar remains reserved for `completeCustomerOffboarding` alone, preserving the existing, deliberate asymmetry rather than widening denial to the protected-action bar. The web boundary now passes `context.access` (the same proven-fresh resolution already threaded into completion) instead of a bare principal ref.

**Test changes**: three new domain-level adversarial tests (`customer-offboarding.test.ts` D1–D3: READ-only denial, cross-tenant denial, DENIED-access denial) plus one new web-boundary-level adversarial test (`customer-offboarding-decision-access.test.ts`: READ-only denial through the authenticated boundary) — all proving zero mutation. Existing domain-level and execution-level tests that called `denyCustomerOffboarding` directly (`customer-offboarding.test.ts` C2/C9/C10, `customer-offboarding-execution.test.ts` E3) were updated to pass a `currentAccess` fixture (with WRITE added to the shared `grantedAccess` helper) instead of a bare string.

**Guard-disable sanity**: the new WRITE-permission check was disabled and the suite rebuilt. Exactly the 2 new READ-only tests failed (one domain-level, one web-boundary-level) — both the real exploit scenario Brain named. No other test regressed. The check was then restored and verified byte-identical to the pre-edit source via `diff`.

Full regression after the fix: **2947/2947 passing** (2943 pre-existing + 4 new), clean strict typecheck, zero new runtime dependency. New exact head: see PR #161's latest commit.

Status: `IMPLEMENTED / SELF-VALIDATED` — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`.
