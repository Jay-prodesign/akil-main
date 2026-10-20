import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { CustomerLifecycleReadinessProjection } from "../domain/customer-lifecycle-readiness.js";
import type { SessionContext, TenantContext } from "./session-context.js";
import { requireTenantOwnership, TenantScopeMismatchError } from "./route-guard.js";

/**
 * V2-CUST-SURFACE-001 (Brain reconciliation on PR #145, comment
 * `6155840409`): the one new provider-neutral shell read port this
 * checkpoint adds for customer lifecycle/offboarding/backup readiness. It
 * returns the already-built, already customer-safe
 * `CustomerLifecycleReadinessProjection` (`customer-lifecycle-
 * readiness.ts`) or `undefined` - never a raw `CustomerOffboardingRequest`/
 * `CustomerOffboardingExecutionState` record, and never a mutating action
 * path. No implementation of this port may perform a live
 * offboard/delete/export effect - this is a read-only readiness status
 * only, mirroring `team-attention-view-state.ts`'s own discipline.
 */
export interface CustomerLifecycleReadinessSource {
  getLifecycleReadiness(ownership: ProjectOwnershipRef): CustomerLifecycleReadinessProjection | undefined;
}

export type CustomerLifecycleReadinessViewState =
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "READY"; readonly projection: CustomerLifecycleReadinessProjection };

function tenantContextFromOwnership(ownership: ProjectOwnershipRef): TenantContext {
  return {
    tenantId: ownership.tenantId,
    customerId: ownership.customerId,
    ...(ownership.projectId !== undefined ? { projectId: ownership.projectId } : {}),
  };
}

/**
 * Tenant/customer isolation fails closed exactly like
 * `resolveProtectedTeamAttentionView`: `requireTenantOwnership` runs
 * before the source is ever queried. The returned `projection`'s own
 * `tenantId`/`customerId` are independently re-verified against
 * `input.requestedOwnership` before it is ever wrapped in `READY` -
 * mirroring the Rev28 bounded correction - so a faulty or compromised
 * source can never yield `READY` with foreign-scope lifecycle data.
 */
export function resolveProtectedCustomerLifecycleReadinessView(input: {
  session: SessionContext;
  requestedOwnership: ProjectOwnershipRef;
  source: CustomerLifecycleReadinessSource | undefined;
}): CustomerLifecycleReadinessViewState {
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

  let projection: CustomerLifecycleReadinessProjection | undefined;
  try {
    projection = input.source.getLifecycleReadiness(input.requestedOwnership);
  } catch {
    return { kind: "UNAVAILABLE" };
  }

  if (projection === undefined) {
    return { kind: "UNAVAILABLE" };
  }

  if (
    projection.tenantId !== input.requestedOwnership.tenantId ||
    projection.customerId !== input.requestedOwnership.customerId
  ) {
    return { kind: "UNAVAILABLE" };
  }

  return { kind: "READY", projection };
}
