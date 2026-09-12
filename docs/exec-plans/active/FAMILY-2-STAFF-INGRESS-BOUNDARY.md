# Family 2 — Trusted Authenticated Internal/Staff Ingress, dark/internal boundary (Rev98/Rev101/Rev102)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev98's Family 2: *"final trusted authenticated internal/staff ingress."*
- Had been dispositioned globally `BLOCKED_BY_EXACT_PROTECTED_GATE` on the reasoning that PR #33 (`AUD-V5-AUTHORITY-INGRESS`) found binding a genuinely *authenticated* caller identity requires an actual identity/session provider this repository has never integrated. Brain's Rev102 exact-head review of PR #47 corrected this: Rev101 already authorizes dependency-safe dark/internal Family 2 contracts, mocks, routes and tests before live identity-provider activation, and `LOCAL-EXEC-004` explicitly needs to reuse this exact boundary. Only *real, live* identity-provider credential/account activation remains protected — see `docs/exec-plans/active/DEP-ORCH-001.md`'s "Family 2 disposition — CORRECTED per Rev102" for the full correction record.
- This checkpoint is that dark/internal boundary. Branch `claude/family-2-staff-ingress-boundary`, cut **fresh from `main`** (`3226c76fa338e425e553638e5f5f48924182a1c0`) — its only dependencies, `organization-membership.ts` (V3-ORG-001) and `tenant-scope.ts`, are already merged; no draft branch of this session's own is needed as a base.

## Design rationale (why a new, parallel module rather than extending V2-APP-001's session types)

- `src/web/session-context.ts`'s `AuthenticatedPrincipal` (V2-APP-001) is customer-facing: it carries `tenantId`/`customerId` and scopes an external customer's own account (`TenantContext`). A staff principal is AKILTA-internal and has no customer account of its own to be scoped to — reusing/extending that type would blur exactly the identity-domain boundary this repository's own precedent keeps separate (`partner-organization.ts` deliberately not importing `organization-membership.ts`; `automation-operating-integration.ts` keeping human-membership vs. worker-id domains structurally distinct).
- Instead, this checkpoint builds a **structural mirror** of V2-APP-001's own proven pattern (`AuthenticatedPrincipal`/`SessionContext`/`SessionProvider`/`route-guard.ts`/dev-fixture+production providers) for the staff identity domain specifically — same mechanical discipline, distinct types, zero shared state.
- `docs/architecture/DEPENDENCY_MAP.md` already documents the intended reuse contract for `organization-membership.ts`'s `principalRef: string`: *"`AuthenticatedPrincipal.principalId` (V2-APP-001, `src/web/session-context.ts`) is reused by shape ... not by import"* — this checkpoint applies that exact same documented contract to the new `AuthenticatedStaffPrincipal.principalId`.

## Scope (this checkpoint)

Six new files, `src/web/` (depends on `src/domain/`, matching the repository's one-directional layering; zero back-edges):

- **`staff-session-context.ts`**: `AuthenticatedStaffPrincipal` (`principalId`, `displayName` — no tenant/customer field), `createAuthenticatedStaffPrincipal` (sole construction path), `StaffSessionContext` (`principal`, `issuedAt`).
- **`staff-session-provider.ts`**: `StaffSessionProvider` interface — `resolveStaffSession(token) => StaffSessionContext | undefined`. Mirrors `session-provider.ts` exactly.
- **`dev-fixture-staff-session-provider.ts`**: `createDevFixtureStaffSessionProvider` — mechanically, construction-time guarded against `isProduction: true` (mirrors `dev-fixture-session-provider.ts`'s exact discipline), backed by a fixed, deterministic in-memory token→session map.
- **`production-staff-session-provider.ts`**: `createProductionStaffSessionProvider` — always resolves `undefined`, for any token. No code path can fabricate a logged-in staff member; a real provider is a separately gated future task.
- **`staff-route-guard.ts`**: `requireStaffSession` — the sole way to obtain a `StaffSessionContext`; throws `StaffUnauthenticatedError` (a new type, deliberately distinct from customer-side `UnauthenticatedError`) on `undefined`.
- **`staff-membership-guard.ts`**: the actual remaining gap PR #33 named — binds an authenticated `StaffSessionContext` to a real, tenant-scoped `OrganizationMembership` record. `resolveCurrentStaffMembership` (pure lookup, `undefined` on no match, throws `AmbiguousStaffMembershipError` on more than one — never guesses). `requireCurrentStaffMembership` (fail-closed form: throws `NoStaffMembershipError` rather than returning `undefined` — an authenticated session token alone is never sufficient authority to act; it must resolve to a real current membership).
- `tests/family-2-staff-ingress.test.ts` (16 tests: F2-1–F2-16) and `tests/family-2-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No real identity/session provider.** Exactly like V2-APP-001's own admitted scope, connecting a real external IdP for staff remains a separately authorized, separately gated task — `BLOCKED_BY_EXACT_PROTECTED_GATE` per Rev102's own corrected disposition.
- **No `AuthorityContext` composition.** `authority.ts`'s `AuthorityContext.canPerformProtectedActions`/`permissions` require a policy decision — *which* `OrganizationRole` maps to *which* permission/protected-action grant — that Rev98 does not hand down and that this checkpoint does not invent. Binding a resolved `OrganizationMembership` to an `AuthorityContext` is a real, named, later gap, not fabricated here (matching `authority.ts`'s own forward-looking doc comment: *"this module does not resolve 'who is calling' from anywhere ... that remains a future, explicit integration"*).
- **No durable session/membership store.** `StaffSessionProvider`/`resolveCurrentStaffMembership` are both pure/caller-supplied, matching every other `src/web/`/`src/domain/` module's discipline; no `FileDurable*` store is added.
- **No admin/staff UI wiring.** This is the ingress/route-guard floor only — no dark/internal Settings page (§19-equivalent) is attempted.
- **No modification to `session-context.ts`/`session-provider.ts`/`route-guard.ts`/their dev-fixture/production providers.** The customer-facing V2-APP-001 module is untouched, read-only precedent only.

## Architecture / semantic invariants (verified by test)

- Principal construction fails closed on empty/whitespace-only fields (F2-1–F2-3).
- Dev fixture provider is mechanically guarded against `isProduction: true` at construction time (F2-4); resolves known tokens (F2-5); returns `undefined` for unknown/absent tokens (F2-6).
- Production provider never resolves a session for any token whatsoever, including one that happens to match a real fixture token by coincidence (F2-7) — the two providers share no state.
- `requireStaffSession` returns the session on a valid token (F2-8); throws `StaffUnauthenticatedError` on an undefined token (F2-9) or against the production provider regardless of token (F2-10).
- `resolveCurrentStaffMembership` finds the matching membership (F2-11); returns `undefined` (never throws) when no membership matches — an unbound session is an expected state (F2-12); never matches a membership from a different tenant even with the same `principalRef` — no cross-tenant leakage (F2-13); throws `AmbiguousStaffMembershipError`, never guesses, on more than one match (F2-14).
- `requireCurrentStaffMembership` returns the membership on exactly one match (F2-15); throws `NoStaffMembershipError` — never returns `undefined` — when unbound, proving an authenticated session alone is never sufficient authority (F2-16).

## Hard Non-Scope

No modification to `session-context.ts`, `session-provider.ts`, `route-guard.ts`, `dev-fixture-session-provider.ts`, `production-session-provider.ts`, `organization-membership.ts`, `tenant-scope.ts`, or `authority.ts` (all read-only precedent/type dependencies); no real network/IdP/OAuth/JWT library anywhere (boundary-scan enforced); no persistence; no admin/UI wiring; no new runtime dependency; no `AuthorityContext` composition.

## Evidence

- `npx tsc --noEmit -p .` / `npm run build`: exit 0, strict mode.
- `npm run test`: **730/730 pass** (708 pre-existing on fresh `main` + 22 new: 16 functional + 6 boundary-scan).
- `package.json`: zero new runtime dependency; unchanged (this branch's `main` base predates the `clean`-script build-hygiene fix applied on several sibling branches this session, but no stale-`dist` contamination occurred here since the build ran against a freshly `rm -rf dist`'d tree — left untouched to keep this PR's diff scoped to Family 2 only).
- Files touched: `src/web/staff-session-context.ts` (new), `src/web/staff-session-provider.ts` (new), `src/web/dev-fixture-staff-session-provider.ts` (new), `src/web/production-staff-session-provider.ts` (new), `src/web/staff-route-guard.ts` (new), `src/web/staff-membership-guard.ts` (new), `tests/family-2-staff-ingress.test.ts` (new), `tests/family-2-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — cut fresh from `main`, a normal task-scoped PR. Per Rev95/97/98/99/100/101/102's continuous-execution batch-mode authorization, independent Brain exact-head review is deferred to the one consolidated end-of-batch packet alongside every other open checkpoint in this batch (PR #32/SVC-ADM-001 Rev102-corrected, #38, #39, RUNTIME-001, V5-PTN-002 Rev101+Rev102-corrected, V4-EFF-001, LOCAL-EXEC-001/002/003, OBS-TEL-001, AUT-OPS-001, DEP-ORCH-001 Rev102-corrected, Family 5, Family 7, Family 8).
