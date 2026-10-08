import { requireInternalOsAccess, type StaffAccessGrant } from "./internal-os-access.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import type { OrganizationResourceBindingStatus } from "../domain/organization-resource-binding.js";
import { InvalidControlledOrganizationProvisioningTransitionError } from "../domain/controlled-organization-provisioning.js";
import type { FileDurableControlledOrganizationProvisioningStore } from "../domain/durable-controlled-organization-provisioning-store.js";

/**
 * Rev205 F2-R2 (authenticated switch-admission ingress): `resolveSwitch`
 * (Rev204 F2-R1) re-resolves membership/assignment/READ/binding currentness
 * fresh immediately before granting switch access, but its own
 * `currentPrincipalRef` parameter is caller-supplied - exactly the same
 * missing application boundary `connector-connection-admin-access.ts`
 * (Rev188 F2) already closed for admin mutations: `resolveEffectiveOrganizationAccess`'s
 * own doc comment is explicit that it never authenticates `currentPrincipalRef`
 * itself, it only proves a supplied membership belongs to the identity the
 * caller currently ASSERTS, assuming an application boundary already
 * authenticated that assertion. Without this wrapper, a caller holding any
 * valid ACTIVE membership object could simply assert that membership's own
 * `principalRef` as `currentPrincipalRef` and pass the exact-match check
 * without ever having authenticated as that principal.
 *
 * This is that missing application boundary - the one this repository
 * already has for exactly this purpose (`requireInternalOsAccess`, OS-V0-08's
 * staff ingress chain: `StaffSessionProvider` -> a real resolved
 * `StaffSessionContext` -> an ACTIVE `OrganizationMembership` matched to it,
 * from the caller-supplied `grants` set, by `session.principal.principalId`
 * -> `resolveEffectiveOrganizationAccess` against the TARGET organization,
 * requiring READ). `currentPrincipalRef` is then ALWAYS
 * `context.session.principal.principalId` - never a request/body/header/model
 * payload value - so the identity bound to the switch is exactly the one the
 * session proved, never one the caller merely asserts. Domain code never
 * depends on `src/web/` (this repository's own established layering), so
 * `resolveSwitch`/`resolveControlledOrganizationSwitch` stay exactly as
 * Rev204 F2-R1 left them; this module is the thin web-layer composition a
 * real caller uses instead: authenticate the session and bind it to a
 * membership first, THEN hand the domain function the now-proven
 * `membership`/`currentPrincipalRef` for its own independent re-resolution
 * (project assignment, READ authority, organization/binding currentness)
 * immediately before granting switch access. A forged identity (no matching
 * session, or a membership that does not belong to the authenticated
 * principal in this tenant) fails inside `requireInternalOsAccess` itself,
 * before `resolveSwitch` is ever reached - zero forged-identity switch
 * grant, either way.
 */
export function resolveControlledOrganizationSwitchAsAuthenticatedStaff(input: {
  readonly store: FileDurableControlledOrganizationProvisioningStore;
  readonly tenantScope: TenantScope;
  readonly organizationId: string;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
}): OrganizationResourceBindingStatus {
  const current = input.store.getCurrentState(input.tenantScope, input.organizationId);
  if (current === undefined) {
    throw new InvalidControlledOrganizationProvisioningTransitionError(
      `organizationId "${input.organizationId}" has no provisioning history to switch into`,
    );
  }
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: current.organization,
    grants: input.grants,
  });
  return input.store.resolveSwitch({
    tenantScope: input.tenantScope,
    organizationId: input.organizationId,
    currentMembership: context.membership,
    currentPrincipalRef: context.session.principal.principalId,
    authority: context.grant.authority,
    assignments: context.grant.assignments,
  });
}
