import type { TenantScope } from "./tenant-scope.js";
import { requireSameTenant, requirePermission, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";
import { resolveEffectiveOrganizationAccess } from "./effective-organization-access.js";
import type { Organization } from "./organization.js";
import type { OrganizationMembership } from "./organization-membership.js";
import type { OrganizationAccessRoleContext } from "./organization-access-role.js";
import { transitionConnectorConnection, type ConnectorConnectionInstance } from "./integration-connector-catalog.js";
import type { ConnectionState } from "./connection-authority.js";
import type { DurableConnectorConnectionStore, StoredConnectorConnection } from "./durable-connector-connection-store.js";

export class ConnectorConnectionAdminMutationNotAuthorizedError extends Error {
  constructor(reason: string) {
    super(`Connector connection admin mutation not authorized: ${reason}`);
    this.name = "ConnectorConnectionAdminMutationNotAuthorizedError";
  }
}

/**
 * OS-V0-10 Rev186 F2: Golden B's durable DEGRADED/REVOKED mutation must
 * pass through an admitted authority/admin boundary, not a raw
 * `transitionConnectorConnection` + `store.save` call with no authenticated
 * staff/service-principal binding, effective access, or protected-action
 * authority. This is the minimum such boundary this exact consumer needs -
 * reusing `effective-organization-access.ts`'s own `EffectiveAccessResolution`
 * and `authority.ts`'s existing protected-action gate, never a new IAM/admin
 * product. The resulting `access.role` must be `OWNER` or `ADMIN` - an
 * ordinary `MEMBER` resolution, however currently GRANTED, cannot mutate a
 * connection's own lifecycle state through this boundary.
 *
 * Rev187 F2 (stale-access residual): `resolveEffectiveOrganizationAccess`'s
 * own doc comment states that re-invoking it with CURRENT inputs is the
 * only way to obtain a current answer - it cannot itself preserve a stale
 * decision. A caller-supplied, already-computed `EffectiveAccessResolution`
 * is therefore never trusted here; this function instead takes the raw
 * `organization`/`membership`/`currentPrincipalRef`/`roleContext` ingredients
 * and calls `resolveEffectiveOrganizationAccess` itself, IMMEDIATELY before
 * the mutation - so a membership revoked (or a role context withdrawn)
 * between an earlier resolution and this call is caught here, not silently
 * honored from a stale cached grant.
 *
 * The mutated connection is always re-read fresh from `store` immediately
 * before the transition (never the caller's own possibly-stale instance),
 * and the resulting `save` is version-guarded against that same fresh read
 * - a concurrent admin mutation racing this one fails closed via the
 * store's own existing optimistic-concurrency check rather than silently
 * overwriting it.
 */
export function mutateConnectorConnectionStateAsAdmin(input: {
  readonly tenantScope: TenantScope;
  readonly authority: AuthorityContext;
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
  readonly currentPrincipalRef: string;
  readonly roleContext?: OrganizationAccessRoleContext;
  readonly store: DurableConnectorConnectionStore;
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly to: ConnectionState;
}): StoredConnectorConnection {
  requireSameTenant(input.authority, input.tenantScope.tenantId);
  const access = resolveEffectiveOrganizationAccess({
    organization: input.organization,
    membership: input.membership,
    currentPrincipalRef: input.currentPrincipalRef,
    authority: input.authority,
    ...(input.roleContext !== undefined ? { roleContext: input.roleContext } : {}),
  });
  if (access.decision !== "GRANTED") {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      `current access must resolve GRANTED to mutate a connection's lifecycle state (reasons: ${access.reasons.join("; ")})`,
    );
  }
  if (access.tenantId !== input.tenantScope.tenantId) {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      "access does not belong to the given tenantScope",
    );
  }
  if (access.role !== "OWNER" && access.role !== "ADMIN") {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      `admin mutation requires an OWNER or ADMIN access role (got "${String(access.role)}")`,
    );
  }
  requirePermission(input.authority, "EXECUTE");
  requireProtectedActionAuthorization(input.authority, "mutateConnectorConnectionStateAsAdmin");

  const current = input.store.get(input.tenantScope.tenantId, input.connectionBindingId);
  if (current === undefined) {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      `no current connection exists for connectionBindingId "${input.connectionBindingId}"`,
    );
  }
  const mutated = transitionConnectorConnection(current.instance, input.to);
  return input.store.save(mutated, current.version);
}
