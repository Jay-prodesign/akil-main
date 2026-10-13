# CUS-BACKUP-001 — Customer Lifecycle Backup/Export/Restore Floor (OS V2 floor slice)

## Provenance

- Governing authority: canonical Handoff **REV215** (AA-005, 2026-10-11). Immediate trigger: Brain's reconciliation comment on PR #145 (id `6152530150`), step 4: after correcting PR #147's F1 finding, reconciling PR #148, shipping `CUS-OFFBOARD-002`, and composing `V2-FLOOR-INT-002`, fresh-scan again and self-select the next task.
- Fresh scan performed this session: a full bullet-by-bullet read of the canonical OS blueprint's V0 §17 and V2 §"EXTERNAL COMMERCIAL RELEASE / GA" sections against current source, confirming via direct grep:
  - "customer-facing organization provisioning/onboarding" — closed (`ORG-ONBOARD-001`).
  - "subscription/contract → entitlement → usage allowance/credit → access lifecycle" — closed (`APP-SUB-001`/corrected `APP-SUB-002`).
  - "billing provider/payment/invoice reference handling" — closed, sandbox/reference floor (`APP-BILL-001`).
  - "customer-facing usage/quota/credit and upgrade/downgrade/suspend/cancel flows" — upgrade/downgrade closed (`changeSubscriptionPlan`); suspend/cancel already modeled in `subscription-entitlement.ts`'s own `SubscriptionStatus` lifecycle (`PAUSED`/`CANCELED` transitions, confirmed present via direct grep) — no new work needed.
  - export/offboarding — closed (`CUS-OFFBOARD-001`/`CUS-OFFBOARD-002`).
  - production IdP/KMS, production observability/SLOs/support, customer-facing legal/trust/commercial docs, external connector/provider activation, real external design-partner pilot, release/security/commercial audit before GA — all remain genuinely Hard-Stop (require real external provider/credential/legal/customer commitment), correctly not attempted.
  - **Genuine remaining gap found:** the canonical blueprint's V0 bullet 17 explicitly names "Full customer-facing backup/export/offboarding product UX remains V1/V2" and V2's own bullet groups "backup/restore, export/delete/offboarding and retention" together. `OS-V1-04`'s `organization-lifecycle-archive.ts` already closed export+backup/restore for `Organization`; `CUS-OFFBOARD-001`/`CUS-OFFBOARD-002` closed export+offboarding+the honest delete/retention disposition for `Customer`, but nothing had ported the "backup/restore" half of `OS-V1-04`'s own pattern to `Customer` specifically.

## Scope (this checkpoint)

- New `src/domain/customer-lifecycle-backup.ts`: `exportCustomerLifecycleSnapshot` (a scope-limited, access-gated projection of `Customer`'s own public fields — `tenantId`/`customerId`/`displayName`/`learningEligibility` — exactly mirroring `exportOrganizationLifecycleSnapshot`'s own discipline) and `restoreCustomerLifecycleFromSnapshot` (deterministically reconstructs a `Customer` via the SAME already-accepted `createCustomer` constructor, mirroring `restoreOrganizationLifecycleFromSnapshot`'s own discipline exactly).
- Deliberately does NOT widen `Customer` itself and does NOT invent a lifecycle `state` field on it — honoring `customer-offboarding.ts`'s own explicit restraint. Since `Customer` has no `state` field to gate restore on (unlike `Organization`'s `OFFBOARDED`), the "an already-offboarded customer can never be restored" discipline is expressed via an explicit, OPTIONAL `relatedOffboardingRequest` parameter (type-only import of `CustomerOffboardingRequest` from `customer-offboarding.ts`): when supplied and its own `status` is already `"COMPLETED"`, restore is denied.
- `tests/customer-lifecycle-backup.test.ts` (14 tests): B1 (export happy path, scope-limited projection); B2 (adversarial — export denied when `currentAccess` is `DENIED`, using a genuinely revoked-membership resolution that still carries a `membershipId`, to isolate this guard from the separate membershipId-undefined guard); B3 (adversarial — export denied on cross-tenant `currentAccess`); B4 (adversarial — export denied when `currentAccess` is `GRANTED` but has no `membershipId`); R1 (restore happy path, deterministic + idempotent on replay); R2 (migration preserves provenance under a different `targetCustomerId`); R3a (adversarial — restore denied when `canPerformProtectedActions` is false, decision still `GRANTED`); R3b (adversarial — restore denied on a `DENIED` decision, checked independently of `canPerformProtectedActions` via a hand-constructed adversarial input, since the real resolver can never itself produce `DENIED` with `canPerformProtectedActions: true`); R4 (adversarial — restore denied when the snapshot's own tenant differs from `targetTenantScope`); R4b (adversarial — restore denied when `currentAccess`'s own tenant differs from `targetTenantScope`, even though the snapshot's tenant matches); R5 (adversarial — restore denied when a supplied `relatedOffboardingRequest` already reached `COMPLETED`); R6 (restore succeeds when a supplied `relatedOffboardingRequest` is still `REQUESTED`); R7 (adversarial — restore denied when a supplied `relatedOffboardingRequest` points at a different `(tenantId, customerId)` than the snapshot); boundary scan (structural — imports only `tenant-scope.js`/`customer.js`/`effective-organization-access.js`/`customer-offboarding.js`, no `organization.ts`/`authority.ts`/`organization-membership.ts` coupling).
- All 9 fail-closed guards independently confirmed load-bearing via guard-disable sanity (each disabled one at a time, rebuilt, confirmed EXACTLY its own corresponding test fails and no other, then reverted and reconfirmed full regression green): export's decision/tenant/membershipId guards (B2/B3/B4); restore's decision/canPerformProtectedActions/currentAccess-tenant/snapshot-tenant/relatedRequest-identity/relatedRequest-COMPLETED guards (R3b/R3a/R4b/R4/R7/R5).
- Full regression: **2690/2690 passing** (2676 pre-existing on PR #149's branch tip + 14 new), clean strict typecheck, zero new runtime dependency.

## Explicitly deferred (not fabricated)

- No HTTP route, admin UI, or wiring into any live surface — domain contract only, matching every prior floor-slice checkpoint's own scope discipline.
- No durable persistence — this is a pure, in-memory domain-value reconstruction, mirroring `organization-lifecycle-archive.ts`'s own established pattern exactly (that module has no durable store either).
- No modification to `Customer` itself — no new field, no widened constructor input.
- No actual cross-module data purge/retention policy — this module is export/restore only; `CUS-OFFBOARD-002` already honestly discloses the delete/retention gap as `BLOCKED_UNSUPPORTED`.

## Architecture / semantic invariants (verified by test)

- An export is a pure projection of `Customer`'s own already-public fields — nothing more exists to export, by construction (B1).
- A restore is deterministic and idempotent: identical inputs produce a deep-equal result (R1).
- Restore never crosses a tenant boundary, on either side of the check — neither the caller's own tenant (R4b) nor the snapshot's own tenant (R4) may differ from `targetTenantScope`.
- Restore is a protected action: both `decision === "GRANTED"` (R3b) and `canPerformProtectedActions === true` (R3a) are independently required, defense-in-depth.
- An already-offboarded customer (a `relatedOffboardingRequest` whose `status` is `COMPLETED`) can never be restored — deleted-data reappearance denied (R5), and a mismatched `relatedOffboardingRequest` is rejected rather than silently ignored (R7).
- Migration (restoring under a different `targetCustomerId`) preserves original provenance via `migratedFrom`, never silently discarding it (R2).

## Hard Non-Scope

No modification to `customer.ts`, `customer-offboarding.ts`, `organization.ts`, `organization-membership.ts`, `authority.ts`, `effective-organization-access.ts`, or `tenant-scope.ts`. No new runtime dependency. No route/application-boundary wiring. No real backup provider, storage system, or credential anywhere.

## Stacked-branch disclosure

Branch: `claude/cus-backup-001-lifecycle-backup`, cut from PR #149's branch tip (`claude/cus-offboard-001-lifecycle-request`), since its sole non-type-only dependency (`CustomerOffboardingRequest` from `customer-offboarding.ts`) does not exist on `main` yet. This PR's range carries PR #149's full diff; it needs PR #149 merged (or this branch rebased onto `main` after it merges) before it can itself be merged.

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json` (clean rebuild): exit 0, zero errors.
- `npx tsc --noEmit -p tsconfig.json`: exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2690/2690 passing** (2676 pre-existing on PR #149's branch tip + 14 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/customer-lifecycle-backup.ts` (new), `tests/customer-lifecycle-backup.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — stacked on PR #149's range; merge requires PR #149 merged first, plus its own separately-granted protected owner-gate, never inferred from any other PR's grant. Risk classification: LOW, pure/dark-internal — this module remains unreferenced by any other `src/` file; no live platform install/config, credentials, or MAIN mutation.
