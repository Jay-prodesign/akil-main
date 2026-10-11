# ORG-ONBOARD-001 — Organization Onboarding Admission Gate (OS V2 floor slice)

## Provenance

- Governing authority: canonical Handoff REV215 (AA-005, 2026-10-11) — authorizes continuous post-V1 engineering, requiring a bounded V2 contract derived from the existing canonical OS blueprint/execution-program/dependency-map before coding.
- Canonical OS blueprint consulted fresh (Drive `1SsxLDjARcmv9QG04UWjUoCNl3QLsfm_vOrj7yQxgXWg`), §"V2 — EXTERNAL COMMERCIAL RELEASE / GA": names "customer-facing organization provisioning/onboarding" as a required V2 capability.
- Not invented scope: a repo-wide audit of the existing organization-provisioning surface found `controlled-organization-provisioning.ts` (OS-V1-01) already provisions an `Organization` end to end, but its own `provisionControlledOrganization` is deliberately "controlled" — it accepts a caller-supplied `founderPrincipalRef`/`founderMembershipId` and immediately constructs the Organization with **no admission/evaluation step at all**, because every real caller of that function is already a trusted internal/regression actor (an AKILTA staff member or test harness). There is no honest path anywhere in this repository from "an unauthenticated prospective customer submitted a request" to "an admitted, real Organization" — exposing `provisionControlledOrganization` directly to such a prospect would let an arbitrary caller mint an Organization with zero review. This checkpoint is exactly that missing admission gate, nothing more.
- Branch: `claude/org-onboard-001-admission-gate`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a` (same current `main` tip as `APP-SUB-001`/PR #140 — no dependency between the two checkpoints; disjoint files).

## Scope (this checkpoint)

- `src/domain/organization-onboarding.ts` (new): `OrganizationOnboardingRequest` (deliberately carries **no** `tenantId`/`TenantScope` — a prospect has no tenant identity before admission); `submitOrganizationOnboardingRequest` (the only construction path, always born `SUBMITTED`); `admitOrganizationOnboardingRequest` (fails closed unless the request is `SUBMITTED`, `evidenceRef` is non-empty, and `admittingAuthorityPrincipalRef` is non-empty and distinct from the request's own `requestedByRef` — mirroring `partner-capability-admission.ts`'s Rev55 F1 self-certification guard and `service-catalog-admission.ts`'s evidence-required discipline exactly; on success delegates Organization/membership/access-role construction entirely to the existing, unmodified `createOrganization`/`activateOrganization`/`createOrganizationMembership`/`createOrganizationAccessRoleContext`); `rejectOrganizationOnboardingRequest` (terminal, one-way, no reconsideration path).
- `tests/organization-onboarding.test.ts` (10 tests, O1–O10) and `tests/org-onboard-001-boundary-scan.test.ts` (7 tests, B1–B7).
- `IMPLEMENTED / SELF-VALIDATED`: clean build, clean strict typecheck, full regression **2681/2681 passing** (2664 pre-existing + 17 new), zero new runtime dependency.

## Explicitly deferred (not fabricated)

- **No real external identity provider.** `requestedByRef` and `admittingAuthorityPrincipalRef` are plain opaque caller-supplied strings, never validated against any OAuth/JWT/SAML shape (re-confirmed by boundary-scan B7) — a production IdP remains its own, separately gated, later activation decision, same as every other dark/internal checkpoint in this corridor.
- **No HTTP route, admin UI, or self-service signup form.** This checkpoint is the domain contract only — a future `/onboarding/*` route or admin review surface is separate, later integration work, matching every other OS floor-slice checkpoint's own established scope discipline (e.g. `CONN-001` slice 1).
- **No numeric/billing concept.** Admission produces an `Organization` with no entitlement/subscription binding — composing this with `APP-SUB-001`'s `subscription-entitlement.ts` (e.g. "an admitted organization's founder also needs a `SubscriptionPlan`") is a distinct, later integration step, not attempted here, since the two checkpoints are intentionally independent and disjoint.
- **No modification to `controlled-organization-provisioning.ts`.** It remains exactly what OS-V1-01 built — the internal/regression-tenant provisioning path — untouched, serving a genuinely different caller (an already-trusted internal actor) than this checkpoint's own external-prospect admission gate.

## Architecture / semantic invariants (verified by test)

- A freshly `submitOrganizationOnboardingRequest`-ed request carries no `tenantId` field at all — structurally, not by convention (O9).
- `admitOrganizationOnboardingRequest` rejects whenever `admittingAuthorityPrincipalRef === request.requestedByRef` — a prospective applicant can never admit their own application (O4), checked before any `Organization`/membership construction is attempted (boundary-scan B3).
- Only a `SUBMITTED` request may be admitted or rejected — an already-`ADMITTED` request can never be admitted again (O5), and a `REJECTED` request can never be admitted or re-rejected (O8); both guards run before any other field validation (boundary-scan B4).
- An admission with an empty `evidenceRef` is rejected (O6) — no admission with no recorded reviewing evidence is ever accepted.
- On success, the admitted `Organization` is genuinely `ACTIVE`, bound to the caller-supplied `TenantScope`, with `displayName` taken from the original request and a founder `OrganizationMembership`/`OWNER` `OrganizationAccessRoleContext` bound to the original `requestedByRef` (O3) — the admitted request itself records `admittedOrganizationId` as forward provenance.
- Zero coupling to `authority.ts`/`AuthorityContext`/any permission function anywhere in the module (boundary-scan B1/B2) — an admission decision here can never manufacture broader AKILTA protected-action authority.

## Hard Non-Scope

No modification to `organization.ts`, `organization-membership.ts`, `organization-access-role.ts`, `controlled-organization-provisioning.ts`, or `authority.ts` — all consumed unmodified, and the first three only via their own existing public constructors. No new runtime dependency. No route/application-boundary wiring. No real identity-provider credential or account anywhere.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2681/2681 passing** (2664 pre-existing on this `main` tip + 17 new: 10 in `tests/organization-onboarding.test.ts`, 7 in `tests/org-onboard-001-boundary-scan.test.ts`).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/organization-onboarding.ts` (new), `tests/organization-onboarding.test.ts` (new), `tests/org-onboard-001-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires its own separately-granted protected owner-gate. Risk classification: MEDIUM — this checkpoint composes `OrganizationMembership`/`OrganizationAccessRoleContext` construction (adjacent to, but not itself, IAM authority), so it is reviewed with the same care as `service-catalog-admission.ts`/`partner-capability-admission.ts`, not treated as a routine LOW/pure-data change.
