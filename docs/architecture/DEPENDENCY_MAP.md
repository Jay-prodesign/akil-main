# Dependency Map

## External dependencies

`package.json` declares **zero runtime dependencies**. `devDependencies` are limited to `typescript` and `@types/node`. Any change to this fact is itself a reportable dependency delta in the affected task's evidence (see `docs/engineering/ACCEPTANCE_CRITERIA.md`).

The environment's pre-installed Playwright/Chromium (used to capture V2-APP-001/V2-CDO-006 rendered evidence) is an out-of-repo evidence-capture tool only — it is never imported by anything under `src/` or referenced in `package.json`.

## Internal module dependency direction

```
src/web/        ──depends on──▶  src/domain/  (session-context types reuse none; snapshot-view-state
                                                consumes ClientProjectSnapshot)
                ──depends on──▶  src/fixtures/  (dev-fixture-session-provider, http-server dev wiring only —
                                                 never from the production session provider path)

src/application/──depends on──▶  src/domain/
                ──depends on──▶  src/ports/

src/fixtures/   ──depends on──▶  src/domain/   (fixture data is typed against real domain contracts)

src/ports/      ──depends on──▶  src/domain/   (port signatures reference domain types)

src/domain/     ──depends on──▶  (nothing else under src/)
```

No back-edges exist: `src/domain/` never imports from `application/`, `ports/`, `fixtures/`, or `web/`. This is enforced informally today by the boundary-scan tests (e.g. `tests/v2-app-001-boundary-scan.test.ts` asserts `production-session-provider.ts` never imports the dev-fixture module, and that only `http-server.ts` imports `node:http`) rather than a build-time lint rule — introducing one is a candidate, not yet-decided, improvement; do not assume it exists.

## Cross-task reuse (not duplication)

- `ClientProjectSnapshot` (`src/domain/client-project-snapshot.ts`, V2-CDO-005) is consumed verbatim by `src/web/snapshot-view-state.ts` and `shell-render.ts` (V2-APP-001/V2-CDO-006) — no second projection type was created.
- `ProjectOwnershipRef` (`src/domain/project-ownership.ts`, V2-CDO-003) is reused directly by the V2-APP-001 tenant-scope checks.
- `WEBSITE_BUILD_V1_OWNERSHIP` / `WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT` fixtures (V2-CDO-005) are reused directly by the V2-APP-001/V2-CDO-006 dev fixtures in `src/fixtures/web-shell.ts`, not re-derived.
- `delivery-advisor.ts` (V2-CDO-008) depends only on types from `client-project-snapshot.ts` (V2-CDO-005) and `delivery-recipe.ts` (V2-CDO-002) — no create/transition/verify function from any domain module, so it cannot mutate `OutcomeJob`/`ProjectPlanVersion`/`ApprovalReference`/`CapabilityAdmission`/`ConnectionBinding` state. `shell-render.ts` (`src/web/`) calls `buildAdvisorResult` directly with the already-validated snapshot; no new port was added for this — the render layer has no `DeliveryRecipe` source, so it always calls `buildAdvisorResult` without a `recipe` argument.
- `organization-membership.ts` (V3-ORG-001) depends only on `tenant-scope.ts`'s `TenantScope` type. It deliberately does NOT import `authority.ts` (a role/membership must never itself grant permission/protected-action authority) or anything from `src/web/` (domain depends on nothing else in `src/`) — `AuthenticatedPrincipal.principalId` (V2-APP-001, `src/web/session-context.ts`) is reused by shape (`principalRef: string`) at future call sites, not by import.
- `ownership-assignment.ts` (V3-OWN-001) depends on `tenant-scope.ts`, `project-ownership.ts` (V2-CDO-003, `ProjectOwnershipRef` reused directly, not re-derived), and `organization-membership.ts` (V3-ORG-001, `OrganizationMembership` reused directly). It deliberately does NOT import `outcome-job.ts`/`project-plan.ts`/`approval-reference.ts` — an `OwnershipAssignment` cannot manufacture transition/approval authority over either.
- `partner-organization.ts` (V3-PTR-001) depends only on `tenant-scope.ts` and `project-ownership.ts` (V2-CDO-003, `ProjectOwnershipRef` reused directly). It deliberately does NOT import `organization-membership.ts` (V3-ORG-001) — a `PartnerEmployeeMembership` must remain structurally distinct from AKILTA-internal `OrganizationMembership`, per the V3 blueprint's own "partner/agency organization identity is distinct from AKILTA/customer organizations" requirement — nor `authority.ts`.
- `attention-state.ts` (V3-SLA-001) depends on `tenant-scope.ts`, `audit-event.ts` (`AuditEvent` type, AKI-BE-001), `project-ownership.ts` (V2-CDO-003), and `ownership-assignment.ts` (V3-OWN-001, `resolveCurrentOwner`/`OwnershipAssignment` reused directly). It imports `outcome-job.ts` as **types only** (`OutcomeJob`/`OutcomeJobState`) — no create/transition function — and nothing from `authority.ts`.
- `team-attention-projection.ts` (V3-F-001) depends only on `tenant-scope.ts`, `project-ownership.ts` (V2-CDO-003), `ownership-assignment.ts` (V3-OWN-001, `resolveCurrentOwner`/`OwnershipAssignment` reused directly), `organization-membership.ts` (V3-ORG-001, `OrganizationMembership` type reused directly), and `attention-state.ts` (V3-SLA-001, `AttentionState`/`InternalAttentionLevel` types reused directly). It imports nothing from `outcome-job.ts`, `authority.ts`, `capability-admission.ts`, `connection-authority.ts`, or `partner-organization.ts`, and cannot import `commercial-authority.ts`/`service-capability-routing.ts`/`operations-attention.ts` at all — none of those files exist on the branch this module was built on. `src/web/team-attention-view-state.ts` (the one new shell read port) depends on `team-attention-projection.ts`, `project-ownership.ts`, and `session-context.ts`/`route-guard.ts` (reusing `requireTenantOwnership` verbatim) — no new session/auth primitive was created.

## Known gaps

No persistence layer exists (`src/application/in-memory-*` are the only adapters), so there is currently no database/ORM dependency edge to map. No external provider/connector is wired — `src/domain/connection-authority.ts` and `capability-admission.ts` model admitted capability/connection *boundaries*, not live provider integrations.
