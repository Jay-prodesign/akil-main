# System Map

Live structural map of `src/`, reconciled against actual repository state (not aspirational). Regenerate the affected section rather than letting this drift when a checkpoint adds/removes/renames files.

## Layers

```
src/domain/        pure domain types + logic — zero I/O, zero framework, zero runtime dependency
src/application/   in-memory application services composed from domain + ports
src/ports/         interfaces the application layer depends on (implemented by adapters)
src/fixtures/      deterministic dev/test-only data and dev-fixture adapters — never reachable from production code paths
src/web/           the V2-APP-001 web shell: provider-neutral session/tenant boundary + a thin node:http adapter
```

Dependency direction is strictly downward: `web` and `application` may depend on `domain` and `ports`; `domain` depends on nothing else in `src/`; `fixtures` depends only on `domain` (never the reverse). See `DEPENDENCY_MAP.md` for the exact per-module edges.

## `src/domain/` — domain kernel

Grouped by the capability it backs:

- **Tenancy/identity**: `tenant-scope.ts`, `customer.ts`, `project.ts`, `project-ownership.ts`, `authority.ts`, `connection-authority.ts`, `capability-admission.ts`
- **Organization membership / role / assignment** (V3-ORG-001, first V3 slice): `organization-membership.ts` — `OrganizationMembership`/`OrganizationRole` (no owner role) + `AssignmentReference`/`resolveAssignmentStatus`; imports nothing from `authority.ts` — a role/membership can never itself grant permission or protected-action authority.
- **Multi-owner sales/account/delivery semantics** (V3-OWN-001): `ownership-assignment.ts` — `OwnerRole` (`LEAD_OWNER`/`DEAL_OWNER`/`ACCOUNT_OWNER`/`DELIVERY_OWNER`) + `OwnershipAssignment`/`createOwnershipAssignment`/`reassignOwnership` (provenance-preserving)/`resolveCurrentOwner` (fail-closed on ambiguity). Depends on `organization-membership.ts` (V3-ORG-001) and `project-ownership.ts` (V2-CDO-003); imports nothing from `outcome-job.ts`/`project-plan.ts`/`approval-reference.ts`.
- **Agency/partner multi-organization boundary** (V3-PTR-001): `partner-organization.ts` — `PartnerOrganization`/`PartnerRelationshipType` + `PartnerEmployeeMembership` (deliberately distinct from `OrganizationMembership`) + `PartnerClientAssignment`/`revokePartnerClientAssignment` (provenance-preserving) + fail-closed `resolvePartnerClientAccess`. Depends only on `tenant-scope.ts` and `project-ownership.ts`; imports nothing from `organization-membership.ts` or `authority.ts`.
- **Delivery/outcome tracking**: `delivery-recipe.ts`, `delivery-status.ts`, `delivery-timeline.ts`, `client-project-snapshot.ts`, `outcome-job.ts`, `outcome-job-spec.ts`, `outcome-job-wiring.ts`, `durable-outcome-job-store.ts`
- **Delivery Project Advisor** (V2-CDO-008): `delivery-advisor.ts` — pure L0 Observe / L1 Recommend contract over `client-project-snapshot.ts` + `delivery-recipe.ts`; no mutation, no provider/model reference.
- **Planning**: `project-plan.ts`, `project-plan-diff.ts`, `project-plan-validation.ts`, `plan-admission.ts`, `plan-admission-event.ts`, `plan-admission-run-state.ts`, `durable-plan-admission-store.ts`, `admission-readiness.ts`, `offer-blueprint.ts`, `sold-scope.ts`, `approval-reference.ts`
- **Communication/evidence**: `project-communication.ts`, `customer-evidence.ts`, `evidence.ts`, `verification-result.ts`, `audit-event.ts`, `dec-138-provenance.ts`
- **Engineering-orchestration primitives** (ENG-ORCH-001): `engineering-event-envelope.ts`, `engineering-run-state.ts`, `durable-engineering-store.ts`, `worker-invoker.ts`

## `src/application/`

- `authorized-outcome-job-operations.ts` — application-level operations over `OutcomeJob`, gated by `AuthorityContext`.
- `in-memory-audit-log.ts`, `in-memory-customer-repository.ts` — in-memory adapters (no persistence layer exists yet; see `docs/engineering/CURRENT_STATE.md` "What does not exist yet").

## `src/ports/`

- `customer-repository.ts` — the one port interface currently defined; implemented in-memory only.

## `src/fixtures/`

Deterministic, dev/test-only. `website-build-v1*.ts` back the `WEBSITE_BUILD_v1` Delivery Recipe fixture family (V2-CDO-002+), including `website-build-v1-advisor.ts` (V2-CDO-008); `web-shell.ts` backs the V2-APP-001/V2-CDO-006 dev session + snapshot fixtures. Mechanically excluded from any production path — see A7/A8 in `docs/exec-plans/completed/V2-APP-001.md` and the boundary-scan tests.

## `src/web/` (V2-APP-001)

- `session-context.ts` — `AuthenticatedPrincipal` / `SessionContext` / `TenantContext`, provider-neutral.
- `session-provider.ts` (port) / `production-session-provider.ts` (fail-closed, no real IdP) / `dev-fixture-session-provider.ts` (dev-only, throws at construction time if `isProduction`).
- `route-guard.ts` — `requireSession`, `requireTenantOwnership`, fail-closed.
- `snapshot-view-state.ts` — tenant-ownership check before ever touching the snapshot source; maps to `FORBIDDEN_TENANT_SCOPE` / `NOT_FOUND` / `ERROR` / `READY`.
- `shell-render.ts` — the one shared HTML shell (accessible, responsive), expanded by V2-CDO-006 into the Client Portal IA and by V2-CDO-008 (`renderAdvisorSection`) with the Delivery Advisor's L0/L1 presentation.
- `request-handler.ts` — pure `IncomingRequestLike -> OutgoingResponseLike`, zero `node:http` import.
- `http-server.ts` — the only file that imports `node:http`; the transport adapter.

## Not present (by design, see `docs/engineering/CURRENT_STATE.md`)

No HTTP framework beyond the hand-written `src/web/` layer, no database/ORM, no queue/cache/object storage, no external provider SDK, no CI configuration, zero runtime `dependencies` in `package.json`.
