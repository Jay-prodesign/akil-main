import { requireStaffSession } from "./staff-route-guard.js";
import { requireMatchingStaffMembership } from "./staff-membership-guard.js";
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
 *
 * Rev106 correction (F1 - authentication is not authorization / cross-
 * tenant read): a valid staff session bound to a matching `OrganizationMembership`
 * in tenant X proves ONLY that fact - it does not prove the caller is
 * authorized to see `internal-command-projection.ts`'s own intentionally
 * cross-tenant, company-wide aggregation. Independently re-verified: no
 * `AuthorityContext`/permission/role policy anywhere in this repository
 * honestly extends to "internal staff, entitled to see all-tenant data" -
 * `authority.ts`'s own `AuthorityContext` is itself hard tenant-scoped
 * (`CrossTenantAuthorityError`), so reusing it here would not authorize
 * cross-tenant visibility, it would contradict its own invariant. Per
 * Rev106's own explicit fallback ("otherwise keep the access layer
 * tenant-bounded and do not expose cross-tenant/company-wide data until
 * the explicit authority-composition policy exists"), this module now
 * narrows what it exposes rather than inventing a policy: `resolveInternalCommandCenterView`
 * filters `attentionItems` to only the caller's own resolved tenant
 * before ever calling the unmodified `buildInternalCommandCenterProjection`
 * (`OperationsAttentionItem` carries a real `tenantId`), and passes an
 * empty `partnerClaims` array - `PartnerCapabilityClaim` carries no
 * tenant field at all, so no tenant-bounded filter can be honestly
 * constructed for it, and Rev106 forbids representing unscoped access as
 * authorized. `internal-command-projection.ts` itself is not modified;
 * it still faithfully aggregates whatever it is given, exactly as
 * before - the boundary now lives entirely in this access layer.
 */
export interface InternalCommandAccess {
  readonly session: StaffSessionContext;
  readonly membership: OrganizationMembership;
}

/**
 * The one required gate before any internal command-center data may be
 * read: a valid staff session (`requireStaffSession`) that resolves to
 * exactly one matching, tenant-scoped `OrganizationMembership`
 * (`requireMatchingStaffMembership`) - both unmodified, both fail-closed,
 * neither weakened here.
 */
export function requireInternalCommandAccess(input: {
  provider: StaffSessionProvider;
  sessionToken: string | undefined;
  tenantScope: TenantScope;
  memberships: ReadonlyArray<OrganizationMembership>;
}): InternalCommandAccess {
  const session = requireStaffSession(input.provider, input.sessionToken);
  const membership = requireMatchingStaffMembership({
    session,
    tenantId: input.tenantScope.tenantId,
    memberships: input.memberships,
  });
  return { session, membership };
}

/**
 * The full convergence: gate access, then delegate to the unmodified
 * `buildInternalCommandCenterProjection` for the actual read-model
 * aggregation - but only over data this module can honestly attribute to
 * the caller's own resolved tenant. This function adds no new attention/
 * partner data source and no independent judgment of its own; it is the
 * access-control *and* tenant-scoping layer §14 named as its own missing
 * piece, nothing more.
 *
 * Rev106 correction: `attentionItems` are filtered to `membership.tenantId`
 * before aggregation (`OperationsAttentionItem.tenantId` is a real,
 * existing field - no new type or lookup invented). `partnerClaims` are
 * never forwarded here at all: `PartnerCapabilityClaim` has no tenant
 * field to filter on, and no canonical authority policy exists yet that
 * would honestly authorize exposing it company-wide through a
 * tenant-membership-only gate - an empty array is passed rather than
 * fabricating either a filter or a policy.
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
  const access = requireInternalCommandAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    tenantScope: input.tenantScope,
    memberships: input.memberships,
  });
  const tenantBoundedAttentionItems = input.attentionItems.filter(
    (item) => item.tenantId === access.membership.tenantId,
  );
  return buildInternalCommandCenterProjection({
    attentionItems: tenantBoundedAttentionItems,
    partnerClaims: [],
    generatedAt: input.generatedAt,
    asOf: input.asOf,
  });
}
