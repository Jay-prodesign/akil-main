import type { TenantScope } from "./tenant-scope.js";
import { requireSameTenant, requirePermission, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";
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
 * (an already-GRANTED resolution against a current, active membership) and
 * `authority.ts`'s existing protected-action gate, never a new IAM/admin
 * product. `access.role` must be `OWNER` or `ADMIN` - an ordinary `MEMBER`
 * resolution, however currently GRANTED, cannot mutate a connection's own
 * lifecycle state through this boundary.
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
  readonly access: EffectiveAccessResolution;
  readonly store: DurableConnectorConnectionStore;
  readonly connectionBindingId: ConnectorConnectionInstance["binding"]["connectionBindingId"];
  readonly to: ConnectionState;
}): StoredConnectorConnection {
  requireSameTenant(input.authority, input.tenantScope.tenantId);
  if (input.access.decision !== "GRANTED") {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      "access must be a GRANTED EffectiveAccessResolution to mutate a connection's lifecycle state",
    );
  }
  if (input.access.tenantId !== input.tenantScope.tenantId) {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      "access does not belong to the given tenantScope",
    );
  }
  if (input.access.role !== "OWNER" && input.access.role !== "ADMIN") {
    throw new ConnectorConnectionAdminMutationNotAuthorizedError(
      `admin mutation requires an OWNER or ADMIN access role (got "${String(input.access.role)}")`,
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
