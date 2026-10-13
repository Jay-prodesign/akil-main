import type { TenantScope } from "./tenant-scope.js";
import { createCustomer, type Customer } from "./customer.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";
import type { CustomerOffboardingRequest } from "./customer-offboarding.js";

/**
 * CUS-BACKUP-001 (AA-005 REV215 V2 floor slice continuation; canonical OS
 * blueprint V0 bullet 17: "Full customer-facing backup/export/offboarding
 * product UX remains V1/V2" — the V2 section's own "backup/restore,
 * export/delete/offboarding and retention verified" bullet). `CUS-
 * OFFBOARD-001`/`CUS-OFFBOARD-002` already closed "export" (a scope-limited
 * snapshot produced upon a COMPLETED offboarding decision) and
 * "offboarding" itself; nothing had yet closed "backup/restore" for
 * `Customer` the way `OS-V1-04`'s `organization-lifecycle-archive.ts`
 * already closed it for `Organization`.
 *
 * Mirrors `organization-lifecycle-archive.ts`'s own exact discipline:
 * `exportCustomerLifecycleSnapshot` is a pure, access-gated projection of
 * the `Customer` value's own already-public fields (nothing more exists to
 * export, by construction — `customer.ts`'s own doc comment: "No
 * unnecessary PII fields"); `restoreCustomerLifecycleFromSnapshot`
 * deterministically reconstructs a `Customer` by replaying the SAME
 * already-accepted `createCustomer` constructor with the snapshot's own
 * historical fields, never fabricating new state.
 *
 * Unlike `Organization`, `Customer` deliberately carries no lifecycle
 * `state` field (`customer-offboarding.ts`'s own explicit design decision:
 * "Deliberately NOT mirrored by adding a mandatory field to `Customer`
 * itself... widening its required input shape would be a disproportionate
 * blast radius"). This module honors that same restraint — it does NOT
 * widen `Customer`, and it does not invent a state field here either. The
 * "an offboarded customer can never be restored" discipline (mirroring
 * `restoreOrganizationLifecycleFromSnapshot`'s own "an OFFBOARDED snapshot
 * can never be restored" gate) is therefore expressed as an explicit,
 * OPTIONAL `relatedOffboardingRequest` parameter: when the caller supplies
 * a `CustomerOffboardingRequest` for the same `(tenantId, customerId)`
 * whose own `status` is already `"COMPLETED"`, restore is denied — closing
 * "deleted customer reappearance" exactly as the Organization-scoped
 * module does, without this module needing its own copy of, or any
 * mutation access to, `customer-offboarding.ts`'s own request store. A
 * caller who omits this parameter is asserting no completed offboarding
 * exists for this customer; this module never looks it up itself, exactly
 * as `restoreOrganizationLifecycleFromSnapshot` never re-derives anything
 * beyond what its own caller supplies.
 */

export class InvalidCustomerLifecycleSnapshotError extends Error {
  constructor(reason: string) {
    super(`Invalid CustomerLifecycleSnapshot: ${reason}`);
    this.name = "InvalidCustomerLifecycleSnapshotError";
  }
}

export class CustomerLifecycleRestoreDeniedError extends Error {
  constructor(reason: string) {
    super(`Customer lifecycle restore denied: ${reason}`);
    this.name = "CustomerLifecycleRestoreDeniedError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    throw new InvalidCustomerLifecycleSnapshotError(
      `${field} must be a non-empty string with no leading/trailing whitespace`,
    );
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new InvalidCustomerLifecycleSnapshotError(`${field} must be a valid ISO timestamp`);
  }
  return timestamp;
}

/**
 * Scope-limited, point-in-time projection of the customer's own already-
 * public fields ONLY, exactly mirroring `OrganizationLifecycleSnapshot`'s
 * own discipline — nothing here is a copy of mutable state beyond what
 * `Customer` itself already exposes.
 */
export interface CustomerLifecycleSnapshot {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly displayName: string;
  readonly learningEligibility: Customer["learningEligibility"];
  readonly exportedAt: string;
  readonly exportedByPrincipalRef: string;
}

/**
 * Pure projection: requires the caller's own current access to be GRANTED
 * and bound to the SAME tenant as the given `Customer` — an export is
 * itself a read of customer state, gated the same way `export
 * OrganizationLifecycleSnapshot` already is.
 */
export function exportCustomerLifecycleSnapshot(input: {
  customer: Customer;
  currentAccess: EffectiveAccessResolution;
  exportedAt: unknown;
}): CustomerLifecycleSnapshot {
  if (input.currentAccess.decision !== "GRANTED") {
    throw new InvalidCustomerLifecycleSnapshotError(
      "currentAccess must be a GRANTED EffectiveAccessResolution to export a customer lifecycle snapshot",
    );
  }
  if (input.currentAccess.tenantId !== input.customer.tenantId) {
    throw new InvalidCustomerLifecycleSnapshotError(
      "currentAccess does not belong to the given customer's own tenant",
    );
  }
  if (input.currentAccess.membershipId === undefined) {
    throw new InvalidCustomerLifecycleSnapshotError(
      "currentAccess must be bound to a real OrganizationMembership (a current authenticated principal) to export",
    );
  }
  const exportedAt = requireValidTimestamp(input.exportedAt, "exportedAt");
  return {
    tenantId: input.customer.tenantId,
    customerId: input.customer.customerId,
    displayName: input.customer.displayName,
    learningEligibility: input.customer.learningEligibility,
    exportedAt,
    exportedByPrincipalRef: input.currentAccess.membershipId,
  };
}

export interface CustomerLifecycleRestoreResult {
  readonly customer: Customer;
  readonly migratedFrom?: {
    readonly tenantId: TenantScope["tenantId"];
    readonly customerId: Customer["customerId"];
  };
}

/**
 * Deterministically reconstructs a `Customer` value by replaying the SAME
 * already-accepted `createCustomer` constructor with the snapshot's own
 * historical fields, verbatim — never fabricating new state. Calling this
 * twice with identical inputs is a pure function producing a deep-equal
 * result.
 *
 * Fail-closed gates, in order:
 * 1. `currentAccess` must be GRANTED and `canPerformProtectedActions` —
 *    restore is a protected action, re-resolved fresh by the caller
 *    immediately before this call, mirroring `restoreOrganizationLifecycle
 *    FromSnapshot`'s own discipline exactly.
 * 2. `currentAccess.tenantId` must exactly equal `targetTenantScope.tenantId`
 *    AND `snapshot.tenantId` — restore never crosses a tenant boundary.
 * 3. If `relatedOffboardingRequest` is supplied, it must point at the exact
 *    same `(tenantId, customerId)` as the snapshot, AND its own `status`
 *    must not be `"COMPLETED"` — an already-offboarded customer can never
 *    be restored, mirroring `restoreOrganizationLifecycleFromSnapshot`'s
 *    own "an OFFBOARDED snapshot can never be restored" gate.
 */
export function restoreCustomerLifecycleFromSnapshot(input: {
  snapshot: CustomerLifecycleSnapshot;
  targetTenantScope: TenantScope;
  targetCustomerId: unknown;
  currentAccess: EffectiveAccessResolution;
  relatedOffboardingRequest?: CustomerOffboardingRequest;
}): CustomerLifecycleRestoreResult {
  if (input.currentAccess.decision !== "GRANTED") {
    throw new CustomerLifecycleRestoreDeniedError(
      "currentAccess must be a GRANTED EffectiveAccessResolution - a caller whose own current access is not GRANTED can never restore, regardless of the snapshot's own content",
    );
  }
  if (!input.currentAccess.canPerformProtectedActions) {
    throw new CustomerLifecycleRestoreDeniedError(
      "restoring a customer lifecycle snapshot is a protected action - canPerformProtectedActions must be true",
    );
  }
  if (input.currentAccess.tenantId !== input.targetTenantScope.tenantId) {
    throw new CustomerLifecycleRestoreDeniedError(
      "currentAccess does not belong to the given targetTenantScope's own tenant",
    );
  }
  if (input.snapshot.tenantId !== input.targetTenantScope.tenantId) {
    throw new CustomerLifecycleRestoreDeniedError(
      "restore never crosses a tenant boundary - the snapshot's own tenantId must exactly match targetTenantScope",
    );
  }
  if (input.relatedOffboardingRequest !== undefined) {
    const request = input.relatedOffboardingRequest;
    if (request.tenantId !== input.snapshot.tenantId || request.customerId !== input.snapshot.customerId) {
      throw new CustomerLifecycleRestoreDeniedError(
        "relatedOffboardingRequest does not point at the exact (tenantId, customerId) this snapshot was made for",
      );
    }
    if (request.status === "COMPLETED") {
      throw new CustomerLifecycleRestoreDeniedError(
        "the related offboarding request already reached COMPLETED - an already-offboarded customer can never be restored, deleted data must never reappear",
      );
    }
  }

  const targetCustomerId = requireNonEmptyString(input.targetCustomerId, "targetCustomerId");
  const customer = createCustomer({
    tenantScope: input.targetTenantScope,
    customerId: targetCustomerId,
    displayName: input.snapshot.displayName,
  });

  const migratedFrom =
    targetCustomerId !== input.snapshot.customerId
      ? { tenantId: input.snapshot.tenantId, customerId: input.snapshot.customerId }
      : undefined;

  return { customer, ...(migratedFrom !== undefined ? { migratedFrom } : {}) };
}
