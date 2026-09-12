import { requireStaffSession } from "./staff-route-guard.js";
import { requireCurrentStaffMembership } from "./staff-membership-guard.js";
import type { StaffSessionContext } from "./staff-session-context.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { OrganizationMembership } from "../domain/organization-membership.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import {
  buildInternalCommandCenterProjection,
  type InternalCommandCenterProjection,
} from "../domain/internal-command-projection.js";
import type { OperationsAttentionItem } from "../domain/operations-attention.js";
import type { PartnerCapabilityClaim } from "../domain/partner-capability-admission.js";

/**
 * V5 Workstream J / §14's own recorded stopping point (`internal-command-
 * projection.ts`, verbatim): *"this repository has no internal/staff
 * authentication concept anywhere... Live routing and internal
 * authentication remain explicitly open dependencies... not fabricated
 * here."* Rev98 Family 10 ("internal operations/command... frontend
 * convergence as Family 2 becomes available") is exactly this: Family 2
 * now exists, so this module is the wiring point - it never redefines or
 * modifies `internal-command-projection.ts`, `staff-route-guard.ts`, or
 * `staff-membership-guard.ts`, it only composes them so the internal
 * command-center projection can no longer be reached without first
 * proving a genuine authenticated staff session bound to a real,
 * current `OrganizationMembership`.
 *
 * The customer/internal separation §14 itself requires is preserved
 * structurally: this module imports nothing from `session-context.ts`/
 * `session-provider.ts`/`route-guard.ts` (the customer-facing shell), so
 * an internal command view can never be reached through a customer
 * session by construction.
 */
export interface InternalCommandAccess {
  readonly session: StaffSessionContext;
  readonly membership: OrganizationMembership;
}

/**
 * The one required gate before any internal command-center data may be
 * read: a valid staff session (`requireStaffSession`) that resolves to
 * exactly one current, tenant-scoped `OrganizationMembership`
 * (`requireCurrentStaffMembership`) - both unmodified, both fail-closed,
 * neither weakened here.
 */
export function requireInternalCommandAccess(input: {
  provider: StaffSessionProvider;
  sessionToken: string | undefined;
  tenantScope: TenantScope;
  memberships: ReadonlyArray<OrganizationMembership>;
}): InternalCommandAccess {
  const session = requireStaffSession(input.provider, input.sessionToken);
  const membership = requireCurrentStaffMembership({
    session,
    tenantId: input.tenantScope.tenantId,
    memberships: input.memberships,
  });
  return { session, membership };
}

/**
 * The full convergence: gate access, then delegate entirely to the
 * unmodified `buildInternalCommandCenterProjection` for the actual
 * read-model aggregation. This function adds no new attention/partner
 * data source, no independent judgment, and no persistence of its own -
 * it is exactly the access-control layer §14 named as its own missing
 * piece, nothing more.
 */
export function resolveInternalCommandCenterView(input: {
  provider: StaffSessionProvider;
  sessionToken: string | undefined;
  tenantScope: TenantScope;
  memberships: ReadonlyArray<OrganizationMembership>;
  attentionItems: ReadonlyArray<OperationsAttentionItem>;
  partnerClaims: ReadonlyArray<PartnerCapabilityClaim>;
  generatedAt: unknown;
  asOf: unknown;
}): InternalCommandCenterProjection {
  requireInternalCommandAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    tenantScope: input.tenantScope,
    memberships: input.memberships,
  });
  return buildInternalCommandCenterProjection({
    attentionItems: input.attentionItems,
    partnerClaims: input.partnerClaims,
    generatedAt: input.generatedAt,
    asOf: input.asOf,
  });
}
