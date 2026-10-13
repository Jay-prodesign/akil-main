import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { BillingReferenceRecord } from "../domain/billing-reference.js";
import type { SessionContext, TenantContext } from "./session-context.js";
import { requireTenantOwnership, TenantScopeMismatchError } from "./route-guard.js";

/**
 * V2-CUST-SURFACE-001 (Brain reconciliation on PR #145, comment
 * `6155840409`): the one new provider-neutral shell read port this
 * checkpoint adds for billing-reference status. It returns the already-
 * built, already customer-safe `BillingReferenceRecord` (`APP-BILL-001`)
 * or `undefined` - never a raw billing-provider payload, and this record
 * itself already carries no monetary amount field (see `billing-
 * reference.ts`'s own doc comment). No implementation of this port may
 * create a real billing-provider call, live credentials, or fabricate an
 * amount - mirroring `team-attention-view-state.ts`'s own discipline.
 */
export interface BillingReferenceStatusSource {
  getBillingReferenceStatus(ownership: ProjectOwnershipRef): BillingReferenceRecord | undefined;
}

export type BillingReferenceStatusViewState =
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "READY"; readonly record: BillingReferenceRecord };

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
 * before the source is ever queried. The returned `record`'s own
 * `tenantId`/`customerId` are independently re-verified against
 * `input.requestedOwnership` before it is ever wrapped in `READY` -
 * mirroring the Rev28 bounded correction - so a faulty or compromised
 * source can never yield `READY` with foreign-scope billing data.
 */
export function resolveProtectedBillingReferenceStatusView(input: {
  session: SessionContext;
  requestedOwnership: ProjectOwnershipRef;
  source: BillingReferenceStatusSource | undefined;
}): BillingReferenceStatusViewState {
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

  let record: BillingReferenceRecord | undefined;
  try {
    record = input.source.getBillingReferenceStatus(input.requestedOwnership);
  } catch {
    return { kind: "UNAVAILABLE" };
  }

  if (record === undefined) {
    return { kind: "UNAVAILABLE" };
  }

  if (record.tenantId !== input.requestedOwnership.tenantId || record.customerId !== input.requestedOwnership.customerId) {
    return { kind: "UNAVAILABLE" };
  }

  return { kind: "READY", record };
}
