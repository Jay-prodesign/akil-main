import type { TenantScope } from "./tenant-scope.js";
import {
  createOrganization,
  activateOrganization,
  suspendOrganization,
  type Organization,
  type OrganizationLifecycleState,
} from "./organization.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";

export class InvalidOrganizationLifecycleSnapshotError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationLifecycleSnapshot: ${reason}`);
    this.name = "InvalidOrganizationLifecycleSnapshotError";
  }
}

export class OrganizationLifecycleRestoreDeniedError extends Error {
  constructor(reason: string) {
    super(`Organization lifecycle restore denied: ${reason}`);
    this.name = "OrganizationLifecycleRestoreDeniedError";
  }
}

/**
 * OS-V1-04 ("Data Lifecycle / Backup / Restore / Migration"): a
 * `backup`/`export` is a scope-limited, point-in-time projection of an
 * `Organization`'s own lifecycle record ONLY - never a copy of its
 * membership/connection/config/resource-binding mutable state, mirroring
 * `controlled-organization-provisioning.ts`'s own Rev203 F3 discipline
 * ("the snapshot now stores ONLY the opaque founderMembershipId/
 * founderPrincipalRef refs... there is structurally nothing left to expose
 * as stale"). This snapshot carries nothing a restore could use to
 * resurrect a membership, connection, or authority grant - those remain
 * entirely `organization-membership.ts`/`durable-connector-connection-
 * store.ts`/`authority.ts`'s own separate, always-fresh-re-derived concern,
 * exactly as `resolveOrganizationResourceBindingStatus` already requires
 * fresh `currentMemberships`/`currentConnections`/etc. on every call,
 * never a cached/restored value.
 */
export interface OrganizationLifecycleSnapshot {
  readonly tenantId: TenantScope["tenantId"];
  readonly organizationId: Organization["organizationId"];
  readonly displayName: string;
  readonly state: OrganizationLifecycleState;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly suspendedAt?: string;
  readonly offboardedAt?: string;
  readonly exportedAt: string;
  readonly exportedByPrincipalRef: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    throw new InvalidOrganizationLifecycleSnapshotError(`${field} must be a non-empty string with no leading/trailing whitespace`);
  }
  return value;
}

/**
 * Pure projection: requires the caller's own current access to be GRANTED
 * (an export is itself a read of organization state, so it is gated the
 * same way every other internal OS view already is) and simply copies the
 * `Organization` value's own public lifecycle fields verbatim - nothing
 * more exists to export, by construction.
 */
export function exportOrganizationLifecycleSnapshot(input: {
  organization: Organization;
  currentAccess: EffectiveAccessResolution;
  exportedAt: unknown;
}): OrganizationLifecycleSnapshot {
  if (input.currentAccess.decision !== "GRANTED") {
    throw new InvalidOrganizationLifecycleSnapshotError(
      "currentAccess must be a GRANTED EffectiveAccessResolution to export an organization lifecycle snapshot",
    );
  }
  if (input.currentAccess.tenantId !== input.organization.tenantId) {
    throw new InvalidOrganizationLifecycleSnapshotError(
      "currentAccess does not belong to the given organization's own tenant",
    );
  }
  if (input.currentAccess.membershipId === undefined) {
    throw new InvalidOrganizationLifecycleSnapshotError(
      "currentAccess must be bound to a real OrganizationMembership (a current authenticated principal) to export",
    );
  }
  const exportedAt = requireNonEmptyString(input.exportedAt, "exportedAt");
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw new InvalidOrganizationLifecycleSnapshotError("exportedAt must be a valid ISO timestamp");
  }
  return {
    tenantId: input.organization.tenantId,
    organizationId: input.organization.organizationId,
    displayName: input.organization.displayName,
    state: input.organization.state,
    createdAt: input.organization.createdAt,
    ...(input.organization.activatedAt !== undefined ? { activatedAt: input.organization.activatedAt } : {}),
    ...(input.organization.suspendedAt !== undefined ? { suspendedAt: input.organization.suspendedAt } : {}),
    ...(input.organization.offboardedAt !== undefined ? { offboardedAt: input.organization.offboardedAt } : {}),
    exportedAt,
    exportedByPrincipalRef: input.currentAccess.membershipId,
  };
}

export interface OrganizationLifecycleRestoreResult {
  readonly organization: Organization;
  readonly migratedFrom?: {
    readonly tenantId: TenantScope["tenantId"];
    readonly organizationId: Organization["organizationId"];
  };
}

/**
 * Deterministically reconstructs an `Organization` value by replaying the
 * SAME already-accepted transition functions (`createOrganization` ->
 * `activateOrganization` -> `suspendOrganization`) with the snapshot's own
 * historical timestamps, verbatim - never fabricating a new timeline. This
 * closes "restart/replay is idempotent" for free: calling this twice with
 * identical inputs is a pure function producing a deep-equal result.
 *
 * Fail-closed gates, in order:
 * 1. `currentAccess` must be GRANTED and `canPerformProtectedActions` -
 *    restore/migration is a protected action, and (the load-bearing fix for
 *    "restore cannot resurrect revoked access") this is re-resolved FRESH
 *    by the caller immediately before this call, exactly like every other
 *    "re-resolve fresh immediately before granting" primitive in this
 *    repository. A caller whose own membership was revoked since they last
 *    had access is denied here, regardless of what the snapshot itself
 *    says - the snapshot's own currentness is irrelevant if the ACTOR
 *    performing the restore is no longer currently authorized.
 * 2. `currentAccess.tenantId` must exactly equal `targetTenantScope.tenantId`
 *    AND `snapshot.tenantId` - restore/migration never crosses a tenant
 *    boundary (closes "foreign export/restore": a tenant B caller can never
 *    restore a tenant A snapshot, and a tenant A snapshot can never be
 *    restored into tenant B).
 * 3. `snapshot.state` must not be `"OFFBOARDED"` - an offboarded (deleted)
 *    organization can never be restored (closes "deleted-data
 *    reappearance" structurally, not merely by convention: there is no
 *    branch below that can produce an `OFFBOARDED`-state result from this
 *    function at all).
 *
 * `targetOrganizationId` may equal `snapshot.organizationId` (an ordinary
 * restore) or differ from it (a same-tenant migration/rekey) - either way
 * the result is deterministic from the snapshot's own historical
 * timestamps. When it differs, `migratedFrom` names the snapshot's own
 * original identity, preserving provenance rather than silently discarding
 * it.
 */
export function restoreOrganizationLifecycleFromSnapshot(input: {
  snapshot: OrganizationLifecycleSnapshot;
  targetTenantScope: TenantScope;
  targetOrganizationId: unknown;
  currentAccess: EffectiveAccessResolution;
}): OrganizationLifecycleRestoreResult {
  if (input.currentAccess.decision !== "GRANTED") {
    throw new OrganizationLifecycleRestoreDeniedError(
      "currentAccess must be a GRANTED EffectiveAccessResolution - a caller whose own current access is not GRANTED can never restore, regardless of the snapshot's own content",
    );
  }
  if (!input.currentAccess.canPerformProtectedActions) {
    throw new OrganizationLifecycleRestoreDeniedError(
      "restoring/migrating an organization lifecycle snapshot is a protected action - canPerformProtectedActions must be true",
    );
  }
  if (input.currentAccess.tenantId !== input.targetTenantScope.tenantId) {
    throw new OrganizationLifecycleRestoreDeniedError(
      "currentAccess does not belong to the given targetTenantScope's own tenant",
    );
  }
  if (input.snapshot.tenantId !== input.targetTenantScope.tenantId) {
    throw new OrganizationLifecycleRestoreDeniedError(
      "restore/migration never crosses a tenant boundary - the snapshot's own tenantId must exactly match targetTenantScope",
    );
  }
  if (input.snapshot.state === "OFFBOARDED") {
    throw new OrganizationLifecycleRestoreDeniedError(
      "an OFFBOARDED (deleted) organization snapshot can never be restored - deleted data must never reappear",
    );
  }

  const targetOrganizationId = requireNonEmptyString(input.targetOrganizationId, "targetOrganizationId");

  let organization = createOrganization({
    organizationId: targetOrganizationId,
    tenantScope: input.targetTenantScope,
    displayName: input.snapshot.displayName,
    createdAt: input.snapshot.createdAt,
  });
  if (input.snapshot.activatedAt !== undefined) {
    organization = activateOrganization({ organization, activatedAt: input.snapshot.activatedAt });
  }
  if (input.snapshot.suspendedAt !== undefined) {
    organization = suspendOrganization({ organization, suspendedAt: input.snapshot.suspendedAt });
  }

  const migratedFrom =
    targetOrganizationId !== input.snapshot.organizationId
      ? { tenantId: input.snapshot.tenantId, organizationId: input.snapshot.organizationId }
      : undefined;

  return { organization, ...(migratedFrom !== undefined ? { migratedFrom } : {}) };
}
