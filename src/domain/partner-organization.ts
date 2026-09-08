import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";

export class InvalidPartnerOrganizationError extends Error {
  constructor(reason: string) {
    super(`Invalid PartnerOrganization: ${reason}`);
    this.name = "InvalidPartnerOrganizationError";
  }
}

export class InvalidPartnerEmployeeMembershipError extends Error {
  constructor(reason: string) {
    super(`Invalid PartnerEmployeeMembership: ${reason}`);
    this.name = "InvalidPartnerEmployeeMembershipError";
  }
}

export class InvalidPartnerClientAssignmentError extends Error {
  constructor(reason: string) {
    super(`Invalid PartnerClientAssignment: ${reason}`);
    this.name = "InvalidPartnerClientAssignmentError";
  }
}

type PartnerOrganizationId = string & { readonly __brand: "PartnerOrganizationId" };
type PartnerEmployeeMembershipId = string & {
  readonly __brand: "PartnerEmployeeMembershipId";
};
type PartnerClientAssignmentId = string & {
  readonly __brand: "PartnerClientAssignmentId";
};

/**
 * V3 Workstream C (§6), spine item D. "Reseller/co-brand/wholesale
 * relationship state is representable but does not grant customer-
 * binding rights by presence." Representable only - no function in this
 * module reads `relationshipType` to derive any authority/access
 * decision (verified by a functional test scanning `resolvePartnerClientAccess`'s
 * only inputs), so no relationship type can imply implicit sell/
 * right-to-represent AKILTA.
 */
export type PartnerRelationshipType = "AGENCY" | "RESELLER" | "CO_BRAND" | "WHOLESALE";

const PARTNER_RELATIONSHIP_TYPE_VALUES: ReadonlySet<string> = new Set([
  "AGENCY",
  "RESELLER",
  "CO_BRAND",
  "WHOLESALE",
]);

/**
 * §6: "partner/agency organization identity is distinct from AKILTA/
 * customer organizations." A `PartnerOrganization` is tenant-scoped (it
 * operates under exactly one AKILTA tenant, reusing the existing
 * `TenantScope` reference) but is never itself a `Customer` or a second
 * `TenantScope` - this module imports `TenantScope` only as a reference
 * type and defines no parallel tenant/customer/project lifecycle.
 */
export interface PartnerOrganization {
  readonly partnerOrganizationId: PartnerOrganizationId;
  readonly tenantId: TenantScope["tenantId"];
  readonly relationshipType: PartnerRelationshipType;
}

/**
 * §6: "agency employee membership is not enough for client visibility."
 * Deliberately NOT `OrganizationMembership` (V3-ORG-001): that type's
 * `tenantId` represents AKILTA-internal staff membership, and reusing it
 * for an agency employee would imply the employee is a member of the
 * AKILTA tenant's own org chart - exactly what §6 requires to remain
 * distinct. `PartnerEmployeeMembership` is scoped to a
 * `PartnerOrganization` instead; its `tenantId` is always derived from
 * that `partnerOrganization` (never separately supplied), so a
 * membership can never claim a tenant its own partner organization does
 * not belong to. `principalRef` reuses the same by-shape convention as
 * `OrganizationMembership.principalRef` (V3-ORG-001) for the same
 * reason documented there: `src/domain/` cannot import `src/web/`'s
 * `AuthenticatedPrincipal`.
 */
export interface PartnerEmployeeMembership {
  readonly partnerEmployeeMembershipId: PartnerEmployeeMembershipId;
  readonly partnerOrganizationId: PartnerOrganization["partnerOrganizationId"];
  readonly tenantId: TenantScope["tenantId"];
  readonly principalRef: string;
}

export type PartnerClientAssignmentStatus = "ACTIVE" | "REVOKED";

/**
 * §6: "explicit agency employee -> client/account assignment is the
 * minimum access relationship" + "revoked assignment removes access
 * deterministically" + partner-projection acceptance direction (no
 * internal margins/notes/prompts/secrets/unrelated customer data). This
 * type carries only a `ProjectOwnershipRef` (an identifier tuple, not
 * projected customer content) and a status/timestamp - there is no
 * field capable of holding customer data, so it cannot itself leak
 * anything beyond which project a partner employee may access.
 * Immutable: `revokePartnerClientAssignment` returns a new value: the
 * original grant is never mutated or deleted, preserving provenance the
 * same way `reassignOwnership` (V3-OWN-001) does.
 */
export interface PartnerClientAssignment {
  readonly partnerClientAssignmentId: PartnerClientAssignmentId;
  readonly tenantId: TenantScope["tenantId"];
  readonly partnerEmployeeMembershipId: PartnerEmployeeMembership["partnerEmployeeMembershipId"];
  readonly ownership: ProjectOwnershipRef;
  readonly status: PartnerClientAssignmentStatus;
  readonly grantedAt: string;
  readonly revokedAt?: string;
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

export function createPartnerOrganization(input: {
  partnerOrganizationId: unknown;
  tenantScope: TenantScope;
  relationshipType: unknown;
}): PartnerOrganization {
  const partnerOrganizationId = requireNonEmptyString(
    input.partnerOrganizationId,
    "partnerOrganizationId",
    InvalidPartnerOrganizationError,
  );
  if (
    typeof input.relationshipType !== "string" ||
    !PARTNER_RELATIONSHIP_TYPE_VALUES.has(input.relationshipType)
  ) {
    throw new InvalidPartnerOrganizationError(
      `relationshipType must be one of ${Array.from(PARTNER_RELATIONSHIP_TYPE_VALUES).join(", ")}`,
    );
  }
  return {
    partnerOrganizationId: partnerOrganizationId as PartnerOrganizationId,
    tenantId: input.tenantScope.tenantId,
    relationshipType: input.relationshipType as PartnerRelationshipType,
  };
}

/**
 * `tenantId` is always taken from the given `partnerOrganization`
 * itself, never a separately supplied value - a membership can never be
 * constructed against a tenant its own partner organization does not
 * belong to (mirrors the same fail-closed-by-construction pattern as
 * `AssignmentReference` in V3-ORG-001).
 */
export function createPartnerEmployeeMembership(input: {
  partnerEmployeeMembershipId: unknown;
  partnerOrganization: PartnerOrganization;
  principalRef: unknown;
}): PartnerEmployeeMembership {
  const partnerEmployeeMembershipId = requireNonEmptyString(
    input.partnerEmployeeMembershipId,
    "partnerEmployeeMembershipId",
    InvalidPartnerEmployeeMembershipError,
  );
  const principalRef = requireNonEmptyString(
    input.principalRef,
    "principalRef",
    InvalidPartnerEmployeeMembershipError,
  );
  return {
    partnerEmployeeMembershipId: partnerEmployeeMembershipId as PartnerEmployeeMembershipId,
    partnerOrganizationId: input.partnerOrganization.partnerOrganizationId,
    tenantId: input.partnerOrganization.tenantId,
    principalRef,
  };
}

/**
 * §6 acceptance direction (implicit): a grant fails closed if the given
 * membership's tenant does not match the given ownership scope's
 * tenant - a partner employee cannot be granted access into a project
 * scope outside its own partner organization's tenant.
 */
export function createPartnerClientAssignment(input: {
  partnerClientAssignmentId: unknown;
  partnerEmployeeMembership: PartnerEmployeeMembership;
  ownership: ProjectOwnershipRef;
  grantedAt: unknown;
}): PartnerClientAssignment {
  if (input.partnerEmployeeMembership.tenantId !== input.ownership.tenantId) {
    throw new InvalidPartnerClientAssignmentError(
      "partner employee membership tenant does not match the given ownership scope's tenant",
    );
  }
  const partnerClientAssignmentId = requireNonEmptyString(
    input.partnerClientAssignmentId,
    "partnerClientAssignmentId",
    InvalidPartnerClientAssignmentError,
  );
  const grantedAt = requireNonEmptyString(
    input.grantedAt,
    "grantedAt",
    InvalidPartnerClientAssignmentError,
  );
  return {
    partnerClientAssignmentId: partnerClientAssignmentId as PartnerClientAssignmentId,
    tenantId: input.partnerEmployeeMembership.tenantId,
    partnerEmployeeMembershipId: input.partnerEmployeeMembership.partnerEmployeeMembershipId,
    ownership: input.ownership,
    status: "ACTIVE",
    grantedAt,
  };
}

/**
 * §6: "revoked assignment removes access deterministically." Returns a
 * new value - the original grant is never mutated in place. Rejects
 * revoking an already-revoked assignment (same stale-state protection
 * as `reassignOwnership`'s already-superseded rejection in V3-OWN-001).
 */
export function revokePartnerClientAssignment(input: {
  assignment: PartnerClientAssignment;
  revokedAt: unknown;
}): PartnerClientAssignment {
  if (input.assignment.status === "REVOKED") {
    throw new InvalidPartnerClientAssignmentError(
      "assignment is already revoked and cannot be revoked again",
    );
  }
  const revokedAt = requireNonEmptyString(
    input.revokedAt,
    "revokedAt",
    InvalidPartnerClientAssignmentError,
  );
  return { ...input.assignment, status: "REVOKED", revokedAt };
}

export type PartnerClientAccessStatus = "AUTHORIZED" | "REVOKED" | "UNAUTHORIZED";

/**
 * §6 acceptance direction: "cross-client substitution/adversarial
 * access tests" + "revoked assignment removes access deterministically."
 * This is the one function partner-facing deep links, search, filters,
 * counters, notifications, recent-items and multi-client context
 * switching must all resolve access through (§6: "use effective
 * authorized context") - a future presentation-layer slice (Workstream
 * F) would call this rather than re-deriving access itself, the same
 * way V2-CDO-008's `renderAdvisorSection` called `buildAdvisorResult`
 * rather than re-deriving delivery state. No UI/session-clearing
 * behavior is implemented in this domain-only checkpoint; that remains
 * Workstream F's concern.
 *
 * Fail-closed: a `PartnerEmployeeMembership`'s mere existence is never
 * consulted here - only an `ACTIVE` `PartnerClientAssignment` matching
 * the exact membership id AND the full `ownership` (tenant/customer/
 * project/serviceRef) tuple resolves `AUTHORIZED`. A matching but
 * `REVOKED` assignment resolves `REVOKED` (distinct from `UNAUTHORIZED`,
 * i.e. never granted at all) so a caller can tell "access was removed"
 * from "access never existed" - neither is ever treated as `AUTHORIZED`.
 *
 * Rev62 AUD-V3-01 correction: `revokePartnerClientAssignment` preserves
 * provenance by returning a *new* value (same `partnerClientAssignmentId`,
 * status `REVOKED`) rather than mutating the original - so a truthful
 * immutable history can legitimately contain both the original `ACTIVE`
 * record and its `REVOKED` successor for the exact same assignment
 * identity. Resolution is therefore done per assignment identity first:
 * for any `partnerClientAssignmentId` that appears with a `REVOKED`
 * status anywhere in the matches, that identity's effective state is
 * `REVOKED` regardless of array order or an also-present `ACTIVE` record
 * for the same id - a revocation successor always dominates the prior
 * grant it revoked. Only a genuinely distinct assignment identity (a new
 * grant, e.g. a fresh `createPartnerClientAssignment` call - which always
 * mints a new id) with no `REVOKED` record of its own can resolve
 * `AUTHORIZED`.
 *
 * Rev62 AUD-V3-02 correction: `ProjectOwnershipRef.serviceRef` is part of
 * ownership identity whenever service context is explicit (§6 "explicit
 * agency employee -> client/account assignment"), but this resolver
 * previously matched only tenantId/customerId/projectId. `serviceRef` is
 * now matched exactly (including the absent-vs-present case, since
 * `undefined === undefined` is true but `undefined !== "svc-x"`), so an
 * assignment scoped to Service A can never authorize Service B, and an
 * assignment with no service scope can never authorize a service-scoped
 * request or vice versa.
 */
export function resolvePartnerClientAccess(input: {
  partnerEmployeeMembershipId: PartnerEmployeeMembership["partnerEmployeeMembershipId"];
  assignments: ReadonlyArray<PartnerClientAssignment>;
  ownership: ProjectOwnershipRef;
}): PartnerClientAccessStatus {
  const matches = input.assignments.filter(
    (assignment) =>
      assignment.partnerEmployeeMembershipId === input.partnerEmployeeMembershipId &&
      assignment.ownership.tenantId === input.ownership.tenantId &&
      assignment.ownership.customerId === input.ownership.customerId &&
      assignment.ownership.projectId === input.ownership.projectId &&
      assignment.ownership.serviceRef === input.ownership.serviceRef,
  );

  const revokedAssignmentIds = new Set(
    matches
      .filter((assignment) => assignment.status === "REVOKED")
      .map((assignment) => assignment.partnerClientAssignmentId),
  );

  const hasAuthorized = matches.some(
    (assignment) =>
      assignment.status === "ACTIVE" &&
      !revokedAssignmentIds.has(assignment.partnerClientAssignmentId),
  );
  if (hasAuthorized) {
    return "AUTHORIZED";
  }
  if (revokedAssignmentIds.size > 0) {
    return "REVOKED";
  }
  return "UNAUTHORIZED";
}
