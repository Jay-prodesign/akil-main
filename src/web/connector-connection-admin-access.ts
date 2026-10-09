import { requireInternalOsAccess, type StaffAccessGrant } from "./internal-os-access.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { Organization } from "../domain/organization.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import { mutateConnectorConnectionStateAsAdmin } from "../domain/connector-connection-admin-mutation.js";
import type { DurableConnectorConnectionStore, StoredConnectorConnection } from "../domain/durable-connector-connection-store.js";
import type { ConnectorConnectionInstance } from "../domain/integration-connector-catalog.js";
import type { ConnectionState } from "../domain/connection-authority.js";

/**
 * Rev188 F2 (authenticated admin ingress): `mutateConnectorConnectionStateAsAdmin`
 * (`connector-connection-admin-mutation.ts`) re-resolves `EffectiveAccessResolution`
 * fresh immediately before mutation (Rev187 F2), but `resolveEffectiveOrganizationAccess`'s
 * own doc comment is explicit that it never authenticates `currentPrincipalRef`
 * itself - it only proves the supplied membership belongs to the identity the
 * caller currently ASSERTS, assuming an application boundary already
 * authenticated that assertion. A caller could therefore still pass an
 * arbitrary, unauthenticated `currentPrincipalRef`/`membership` pair straight
 * into the domain function.
 *
 * This is that missing application boundary - the one this repository already
 * has for exactly this purpose (`requireInternalOsAccess`, OS-V0-08's staff
 * ingress chain: `StaffSessionProvider` -> a real resolved `StaffSessionContext`
 * -> an ACTIVE `OrganizationMembership` matched to it -> `resolveEffectiveOrganizationAccess`).
 * Domain code never depends on `src/web/` (this repository's own established
 * layering - see every other `src/domain/*.ts` file), so the mutation itself
 * stays exactly as Rev187 F2 left it; this module is the thin web-layer
 * composition a real caller uses instead: authenticate the session first,
 * THEN hand the domain function the now-proven `membership`/`currentPrincipalRef`
 * for its own independent re-resolution immediately before the mutation. A
 * forged identity (no matching session) fails inside `requireInternalOsAccess`
 * itself, before the domain function is ever reached; a stale role or a
 * membership revoked since an earlier resolution fails inside the domain
 * function's own re-resolution (Rev187 F2, unchanged) - either way, zero
 * store mutation.
 */
export function mutateConnectorConnectionStateAsAuthenticatedAdmin(input: {
  readonly tenantScope: TenantScope;
  readonly organization: Organization;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly store: DurableConnectorConnectionStore;
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly to: ConnectionState;
  /** OS-V1-02: optional, purely additive - see `requireStaffSession`'s own doc comment. */
  readonly now?: string;
}): StoredConnectorConnection {
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: input.organization,
    grants: input.grants,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return mutateConnectorConnectionStateAsAdmin({
    tenantScope: input.tenantScope,
    authority: context.grant.authority,
    organization: input.organization,
    membership: context.membership,
    currentPrincipalRef: context.session.principal.principalId,
    ...(context.grant.roleContext !== undefined ? { roleContext: context.grant.roleContext } : {}),
    store: input.store,
    connectionBindingId: input.connectionBindingId,
    to: input.to,
  });
}
