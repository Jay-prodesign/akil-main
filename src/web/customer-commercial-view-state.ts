import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { SubscriptionUsageStatus } from "../domain/subscription-usage-status.js";
import type { SessionContext, TenantContext } from "./session-context.js";
import { requireTenantOwnership, TenantScopeMismatchError } from "./route-guard.js";

/**
 * V2-CUST-SURFACE-001 (Brain reconciliation on PR #145, comment
 * `6155840409`): the one new provider-neutral shell read port this
 * checkpoint adds for subscription/entitlement/commercial-usage status.
 * It returns the already-built, already customer-safe
 * `SubscriptionUsageStatus` (`APP-SUB-002`) or `undefined` - never a raw
 * `Subscription`/`Entitlement` record. No implementation of this port may
 * create persistence, a real billing-provider call, or fabricate a
 * numeric usage/credit value - this port's only job is to hand back a
 * projection someone else already built from merged-main domain modules,
 * mirroring `team-attention-view-state.ts`'s own exact discipline.
 */
export interface CustomerCommercialStatusSource {
  getCommercialStatus(ownership: ProjectOwnershipRef): SubscriptionUsageStatus | undefined;
}

/**
 * A deliberately small, closed result set - mirroring
 * `TeamAttentionViewState` exactly. `UNAVAILABLE` covers every "no data"
 * case uniformly (no source wired, source returned `undefined`, or
 * source threw) so the shell can render one honest message without
 * distinguishing implementation detail from a caller-visible state.
 */
export type CustomerCommercialStatusViewState =
  | { readonly kind: "FORBIDDEN_TENANT_SCOPE" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "READY"; readonly status: SubscriptionUsageStatus };

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
 * before the source is ever queried, so a tenant/customer mismatch never
 * reaches `source.getCommercialStatus` at all. `source` is optional so a
 * caller that has not wired this port yet degrades to `UNAVAILABLE`
 * rather than throwing or fabricating data.
 *
 * The returned `status`'s own `tenantId`/`customerId` are independently
 * re-verified against `input.requestedOwnership` before it is ever
 * wrapped in `READY` - mirroring the Rev28 bounded correction already
 * applied to `team-attention-view-state.ts` - so a faulty or compromised
 * source can never yield `READY` with foreign-scope commercial data.
 * `SubscriptionUsageStatus` has no `projectId` field (subscription status
 * is customer-scoped, not project-scoped), so only `tenantId`/`customerId`
 * are compared here.
 */
export function resolveProtectedCustomerCommercialStatusView(input: {
  session: SessionContext;
  requestedOwnership: ProjectOwnershipRef;
  source: CustomerCommercialStatusSource | undefined;
}): CustomerCommercialStatusViewState {
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

  let status: SubscriptionUsageStatus | undefined;
  try {
    status = input.source.getCommercialStatus(input.requestedOwnership);
  } catch {
    return { kind: "UNAVAILABLE" };
  }

  if (status === undefined) {
    return { kind: "UNAVAILABLE" };
  }

  if (status.tenantId !== input.requestedOwnership.tenantId || status.customerId !== input.requestedOwnership.customerId) {
    return { kind: "UNAVAILABLE" };
  }

  return { kind: "READY", status };
}
