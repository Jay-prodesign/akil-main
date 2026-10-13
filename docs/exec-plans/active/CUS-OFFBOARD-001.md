# CUS-OFFBOARD-001 — Customer Offboarding Request/Decision Lifecycle (OS V2 floor slice)

## Provenance

- Governing authority: canonical Handoff **REV215** (AA-005, 2026-10-11), re-confirmed this session as still the latest substantive revision (a full scan of AA-005 found REV numbers only up to 215; REV212 explicitly reinforces that a routine Brain-disposition/awaiting-review state is not itself a stop condition for continuing dependency-safe reversible work).
- Immediate trigger: the Founder's explicit "Continuous Completion Mode" direction (this session), continuing the live current-main + canonical-blueprint dependency/reuse scan that already produced `V2-FLOOR-INT-001`.
- Canonical OS blueprint (Drive `1SsxLDjARcmv9QG04UWjUoCNl3QLsfm_vOrj7yQxgXWg`), §"V2 — EXTERNAL COMMERCIAL RELEASE / GA", re-read verbatim this session. Of its full required-items list, `full offboarding` is the one remaining textually-named item that is genuinely buildable as a pure dark/internal domain contract: production IdP/KMS/billing/legal-terms/external-pilot/production observability/SLOs/broader connector lifecycle are all Hard-Stop (new external-provider admission, credential/secret activation, payment/financial commitment, production infrastructure); "customer-facing organization provisioning/onboarding," "subscription/contract → entitlement → usage allowance/credit → access lifecycle," and "customer-facing usage/quota/credit and upgrade/downgrade/suspend/cancel flows" were already closed by `ORG-ONBOARD-001`/`APP-SUB-001`/`APP-SUB-002`. `OS-V1-04`'s own `organization-lifecycle-archive.ts` already closed the equivalent concern for `Organization` (export/restore/offboard); nothing in this repository had ever closed it for `Customer`.
- Branch: `claude/cus-offboard-001-lifecycle-request`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a` (current `main` tip at session start) — independent of, and with zero dependency on, the `APP-SUB-001`/`APP-SUB-002`/`ORG-ONBOARD-001`/`V2-FLOOR-INT-001` stacked chain.

## Design decision: do not widen `Customer` itself

- `organization-lifecycle-archive.ts`'s own pattern mutates/reads `Organization`'s own `OrganizationLifecycleState` field directly — that field already existed on `Organization` from `OS-V0-01`. `Customer` (`src/domain/customer.ts`) carries no lifecycle field at all today, and a live grep confirmed `createCustomer` is called from 75+ files across this repository, every one of them already independently reviewed/accepted.
- Widening `Customer`'s own constructor input to require a new field (e.g. a mandatory `createdAt`, needed to mirror `Organization`'s shape fully) would touch all 75+ call sites — a sweeping, high-blast-radius change to a foundational type, not the smallest coherent reversible packet this corridor's own discipline calls for.
- Instead, offboarding here is tracked exactly the way `organization-onboarding.ts` tracks admission: as its own request/decision record that points at an existing `Customer` by `(tenantId, customerId)`, never as a mutation of `Customer` itself. A direct grep confirmed zero direct object-literal construction of `Customer` anywhere outside `createCustomer` itself, so `Customer` remains completely untouched, type-only.

## Scope (this checkpoint)

- `src/domain/customer-offboarding.ts` (new): `CustomerOffboardingRequest` (always born `REQUESTED`, via `requestCustomerOffboarding`); `completeCustomerOffboarding` (fails closed unless the request is `REQUESTED`, the given `customer` exactly matches the request's own `(tenantId, customerId)`, `currentAccess` is a fresh `GRANTED` `EffectiveAccessResolution` bound to the same tenant with `canPerformProtectedActions`, and the deciding principal — `currentAccess.membershipId` — is distinct from the request's own `requestedByRef`; on success returns a `CustomerOffboardingSnapshot`, a scope-limited export of the customer's own already-public fields plus the decision's provenance, mirroring `exportOrganizationLifecycleSnapshot`'s own discipline); `denyCustomerOffboarding` (terminal, no reconsideration path, mirroring `rejectOrganizationOnboardingRequest`).
- `tests/customer-offboarding.test.ts` (12 tests): C1 (happy-path completion + snapshot), C2 (deny with recorded reason), C3 (adversarial: foreign-customer substitution rejected), C4 (adversarial: cross-tenant `currentAccess` rejected), C5 (adversarial: `DENIED` `currentAccess` rejected), C6 (adversarial: `GRANTED`-but-non-protected-action `currentAccess` rejected), C7 (adversarial: self-completion — deciding principal equals requester — rejected), C8/C9 (adversarial: no resurrection from `COMPLETED`/`DENIED`), C10 (adversarial: no double-denial), C11 (adversarial: empty `requestedByRef` rejected), B1 (boundary scan: imports only `tenant-scope.js`/`customer.js`/`effective-organization-access.js`, no `authority.ts`/`organization-membership.ts` direct coupling).
- Guard-disable sanity performed on all three fail-closed guards this module's own `completeCustomerOffboarding` introduces (self-completion, cross-tenant, resurrection-from-terminal): each disabled independently, confirmed exactly its own named test(s) failed (C7 alone; C8+C9 together; C4 alone), then restored and reconfirmed green.
- Full regression: **2676/2676 passing** (2664 pre-existing on `main` + 12 new), clean strict typecheck, zero new runtime dependency, zero modification to any existing file.

## Explicitly deferred (not fabricated)

- **No actual cross-module data purge.** This checkpoint is the admission/decision record and a scope-limited export of the `Customer`'s own already-public fields only — mirroring `ORG-ONBOARD-001`'s own "domain contract only" discipline exactly. It does not delete, anonymize, or purge any `Subscription`/`Entitlement`/`OutcomeJob`/project/evidence data that references the customer elsewhere in this repository; a real "delete everything this customer owns" sweep would require enumerating every customer-scoped module (a much larger, separately-scoped task) and is not attempted here.
- **No modification to `Customer` itself.** See "Design decision" above.
- **No HTTP route, admin UI, or billing coupling.** Domain contract only, matching every other OS V0–V2 floor-slice checkpoint's own established scope discipline.
- **No real IdP.** `requestedByRef` and `currentAccess`'s own `membershipId` are never checked against any external identity-provider shape — `currentAccess` itself is produced entirely by the already-accepted `effective-organization-access.ts`, consumed unmodified.

## Architecture / semantic invariants (verified by test)

- A request for one customer can never be completed while exporting a different customer's data, even within the same tenant (C3).
- Completion is a protected action: it requires `GRANTED` + `canPerformProtectedActions`, and never crosses a tenant boundary (C4–C6).
- The requester can never complete their own offboarding (C7).
- Neither `COMPLETED` nor `DENIED` is ever reversible — both are dead ends this module's own code has no branch to escape from (C8–C10).
- All three fail-closed guards independently confirmed load-bearing via guard-disable sanity, then restored.

## Hard Non-Scope

No modification to `customer.ts`, `organization.ts`, `organization-membership.ts`, `authority.ts`, `tenant-scope.ts`, or `effective-organization-access.ts` — all consumed unmodified, type-only where applicable. No new runtime dependency. No route/application-boundary wiring. No real data-deletion sweep across other modules.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild from scratch): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2676/2676 passing** (2664 pre-existing on `main` tip `5dcbee99e3f0a0455915a7785ac939b069c1e33a` + 12 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/customer-offboarding.ts` (new), `tests/customer-offboarding.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR cut directly from `main`, no stacking dependency on any other open PR; merge requires its own separately-granted protected owner-gate, never inferred from any other PR's grant. Risk classification: LOW, pure/dark-internal — this module remains unreferenced by any other `src/` file; no live platform install/config, credentials, payment, data purge, or MAIN mutation.
