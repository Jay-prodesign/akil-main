import type { TenantScope } from "./tenant-scope.js";

export class InvalidOrganizationServicePrincipalError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationServicePrincipal: ${reason}`);
    this.name = "InvalidOrganizationServicePrincipalError";
  }
}

export class InvalidOrganizationServicePrincipalTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationServicePrincipal transition: ${reason}`);
    this.name = "InvalidOrganizationServicePrincipalTransitionError";
  }
}

type ServicePrincipalId = string & { readonly __brand: "ServicePrincipalId" };

/**
 * OS-V0-02 final convergence (Rev136): the minimum V0 lifecycle floor for a
 * non-human Organization identity, mirroring `OrganizationMembership`'s own
 * `ACTIVE`/`REVOKED` floor (Phase C, Rev131) exactly - `ACTIVE` is the only
 * usable state, `REVOKED` is a one-way terminal stop. No expiry, renewal,
 * suspension, or reactivation is representable here: the roadmap's
 * "revoked/inactive/expired/malformed" requirement is satisfied by this one
 * ACTIVE/REVOKED bit plus ordinary structural-coherence validation, not by
 * inventing an unrequested time-based expiry concept this task's own
 * acceptance list does not ask for.
 */
export type OrganizationServicePrincipalLifecycleState = "ACTIVE" | "REVOKED";

/**
 * A distinct, non-human Organization identity family - deliberately NOT an
 * `OrganizationMembership` (no `principalRef`/`role`/curated-role
 * eligibility of any kind: see `organization-access-role.ts`'s own human-
 * membership-bound contract, unchanged) and NOT an alias for
 * `AdmittedWorker` (`worker-routing-policy.ts`, untouched, unimported here).
 * `workerRef` is an opaque, repo-native string reference to a worker
 * identity (the same shape as `AdmittedWorker.workerId`, reused by
 * structural convention, never by import - this module has no dependency
 * on `worker-routing-policy.ts` at all, so it structurally cannot read
 * `trustStatus`/`availability`/`capability`/`cost` and therefore cannot
 * derive Organization authority from any of them). `tenantId` is always
 * taken from a supplied `TenantScope`, never a separately supplied value -
 * a service principal can never be constructed detached from a real tenant
 * partition, mirroring every other domain identity in this repository.
 */
export interface OrganizationServicePrincipal {
  readonly servicePrincipalId: ServicePrincipalId;
  readonly tenantId: TenantScope["tenantId"];
  readonly workerRef: string;
  readonly state: OrganizationServicePrincipalLifecycleState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  ErrorClass: new (reason: string) => Error,
): string {
  if (typeof value !== "string") {
    throw new ErrorClass(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new ErrorClass(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new ErrorClass(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireValidRevocationTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field, InvalidOrganizationServicePrincipalTransitionError);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidOrganizationServicePrincipalTransitionError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/**
 * Always produces a coherent `ACTIVE` record with no revocation metadata -
 * `tenantId` is taken from `tenantScope`, `workerRef` is validated
 * structurally (non-empty, non-whitespace) but never interpreted or
 * cross-checked against a worker registry (this module keeps no registry
 * of its own and reuses none - "do not create a second worker registry").
 */
export function createOrganizationServicePrincipal(input: {
  servicePrincipalId: unknown;
  tenantScope: TenantScope;
  workerRef: unknown;
}): OrganizationServicePrincipal {
  const servicePrincipalId = requireNonEmptyString(
    input.servicePrincipalId,
    "servicePrincipalId",
    InvalidOrganizationServicePrincipalError,
  );
  const workerRef = requireNonEmptyString(
    input.workerRef,
    "workerRef",
    InvalidOrganizationServicePrincipalError,
  );
  return {
    servicePrincipalId: servicePrincipalId as ServicePrincipalId,
    tenantId: input.tenantScope.tenantId,
    workerRef,
    state: "ACTIVE",
  };
}

/**
 * The single reusable currentness/coherence predicate - mirrors
 * `organization-membership.ts`'s `isOrganizationMembershipActive` exactly
 * (same ACTIVE/REVOKED shape, same factory-bypass discipline): returns
 * `true` only for a coherent `ACTIVE` record (no `revokedAt`/`revokedReason`
 * present), and `false` for `REVOKED` (coherent or not), an unknown/
 * malformed `state`, or an `ACTIVE` record already carrying stale
 * revocation metadata.
 */
export function isOrganizationServicePrincipalActive(
  servicePrincipal: OrganizationServicePrincipal,
): boolean {
  if (servicePrincipal.state !== "ACTIVE") {
    return false;
  }
  return servicePrincipal.revokedAt === undefined && servicePrincipal.revokedReason === undefined;
}

/**
 * The single one-way `ACTIVE -> REVOKED` transition. No reactivation
 * function is implemented or exposed. Revalidates the FULL pre-existing
 * record via `isOrganizationServicePrincipalActive` before consuming it -
 * a hand-built `ACTIVE` record already carrying stale revocation metadata,
 * an already-`REVOKED` record (double revoke), or any other incoherent
 * shape is rejected before the new `revokedAt`/`revokedReason` are even
 * validated.
 */
export function revokeOrganizationServicePrincipal(input: {
  servicePrincipal: OrganizationServicePrincipal;
  revokedAt: unknown;
  revokedReason: unknown;
}): OrganizationServicePrincipal {
  if (!isOrganizationServicePrincipalActive(input.servicePrincipal)) {
    throw new InvalidOrganizationServicePrincipalTransitionError(
      "service principal must be a coherent ACTIVE record (no existing revocation metadata) to revoke",
    );
  }
  const revokedAt = requireValidRevocationTimestamp(input.revokedAt, "revokedAt");
  const revokedReason = requireNonEmptyString(
    input.revokedReason,
    "revokedReason",
    InvalidOrganizationServicePrincipalTransitionError,
  );
  return {
    ...input.servicePrincipal,
    state: "REVOKED",
    revokedAt,
    revokedReason,
  };
}
