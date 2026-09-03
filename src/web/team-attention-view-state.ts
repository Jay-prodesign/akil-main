import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { TeamAttentionProjection } from "../domain/team-attention-projection.js";
import type { SessionContext, TenantContext } from "./session-context.js";
import { requireTenantOwnership, TenantScopeMismatchError } from "./route-guard.js";

/**
 * V3 Workstream F floor slice: the one new provider-neutral shell read
 * port this checkpoint adds. It returns the already-built, already
 * tenant-scoped `TeamAttentionProjection` or `undefined` - never a raw
 * `OwnershipAssignment`/`AttentionState`/`OrganizationMembership` record.
 * No implementation of this port may create persistence, a provider SDK/
 * OAuth connector, or a new commercial/financial type - this port's only
 * job is to hand back a projection someone else already built from
 * merged-main domain modules.
 */
export interface TeamAttentionSource {
  getTeamAttentionProjection(ownership: ProjectOwnershipRef): TeamAttentionProjection | undefined;
}

/**
 * A deliberately small, closed result set - mirroring
 * `snapshot-view-state.ts`'s `ShellViewState` exactly. `UNAVAILABLE`
 * covers every "no data" case uniformly (no source wired at all, source
 * returned `undefined`, or source threw) so the shell can render one
 * honest "unavailable" message without distinguishing implementation
 * detail from a caller-visible state.
 */
export type TeamAttentionViewState =
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "READY"; readonly projection: TeamAttentionProjection };

function tenantContextFromOwnership(ownership: ProjectOwnershipRef): TenantContext {
  return {
    tenantId: ownership.tenantId,
    customerId: ownership.customerId,
    ...(ownership.projectId !== undefined ? { projectId: ownership.projectId } : {}),
  };
}

/**
 * Tenant/project isolation fails closed exactly like
 * `resolveProtectedSnapshotView`: `requireTenantOwnership` runs before the
 * source is ever queried, so a tenant/project mismatch never reaches
 * `source.getTeamAttentionProjection` at all. `source` is optional so a
 * caller (e.g. `request-handler.ts`) that has not wired this new port yet
 * degrades to `UNAVAILABLE` rather than throwing or fabricating data -
 * this port is additive, not a required dependency of the existing shell.
 *
 * Bounded correction (Brain handoff Rev28, CHANGES_REQUIRED_SOURCE_SECURITY
 * on PR #8): "The resolver checks requested ownership before querying the
 * source but does not fail closed if the returned projection itself
 * carries a different tenant/customer/project scope. A faulty or
 * compromised source could therefore yield READY with foreign-scope
 * data." Checking `input.session` against `input.requestedOwnership`
 * proves the caller is allowed to see *that* scope - it proves nothing
 * about what `source.getTeamAttentionProjection` actually handed back.
 * The returned `projection`'s own `tenantId`/`customerId`/`projectId` are
 * therefore independently verified against `input.requestedOwnership`
 * before it is ever wrapped in `READY`; any mismatch resolves
 * `UNAVAILABLE` (the same honest "no trustworthy data" outcome already
 * used for a missing/throwing source, per this type's own "UNAVAILABLE
 * covers every 'no data' case uniformly" design) rather than leaking a
 * foreign-scope projection.
 */
export function resolveProtectedTeamAttentionView(input: {
  session: SessionContext;
  requestedOwnership: ProjectOwnershipRef;
  source: TeamAttentionSource | undefined;
}): TeamAttentionViewState {
  try {
    requireTenantOwnership(input.session, tenantContextFromOwnership(input.requestedOwnership));
  } catch (error) {
    if (error instanceof TenantScopeMismatchError) {
      return { kind: "FORBIDDEN_TENANT_SCOPE" };
    }
    throw error;
  }

  if (input.source === undefined) {
    return { kind: "UNAVAILABLE" };
  }

  let projection: TeamAttentionProjection | undefined;
  try {
    projection = input.source.getTeamAttentionProjection(input.requestedOwnership);
  } catch {
    return { kind: "UNAVAILABLE" };
  }

  if (projection === undefined) {
    return { kind: "UNAVAILABLE" };
  }

  if (
    projection.tenantId !== input.requestedOwnership.tenantId ||
    projection.customerId !== input.requestedOwnership.customerId ||
    projection.projectId !== input.requestedOwnership.projectId
  ) {
    return { kind: "UNAVAILABLE" };
  }

  return { kind: "READY", projection };
}
