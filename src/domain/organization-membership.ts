import type { TenantScope } from "./tenant-scope.js";

export class InvalidOrganizationMembershipError extends Error {
  constructor(reason: string) {
    super(`Invalid OrganizationMembership: ${reason}`);
    this.name = "InvalidOrganizationMembershipError";
  }
}

export class InvalidAssignmentReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid AssignmentReference: ${reason}`);
    this.name = "InvalidAssignmentReferenceError";
  }
}

type MembershipId = string & { readonly __brand: "MembershipId" };
type AssignmentId = string & { readonly __brand: "AssignmentId" };

/**
 * V3 Workstream A (organization/role/assignment authority foundation),
 * §4 required semantics: "Staff, junior, student and client-associate
 * roles are representable without implying ownership or commercial
 * authority." Deliberately excludes any "Owner" role - LeadOwner/
 * DealOwner/AccountOwner/DeliveryOwner are a distinct, later concept
 * (Workstream B, not built here) that would be derived from
 * `AssignmentReference` below, never from this enum, so a membership's
 * role can never itself grant ownership.
 */
export type OrganizationRole = "STAFF" | "JUNIOR" | "STUDENT" | "CLIENT_ASSOCIATE";

const ORGANIZATION_ROLE_VALUES: ReadonlySet<string> = new Set([
  "STAFF",
  "JUNIOR",
  "STUDENT",
  "CLIENT_ASSOCIATE",
]);

/**
 * §4: "Identity/Principal, organization membership, role, ownership
 * assignment and action authority remain distinct." A membership carries
 * no `AuthorityContext`/permission field, and this module imports
 * nothing from `authority.ts` - a role can never itself grant READ/
 * WRITE/EXECUTE or protected-action authority; that remains solely
 * `authority.ts`'s concern. `principalRef` reuses the string identity of
 * the existing V2-APP-001 `AuthenticatedPrincipal.principalId` by shape,
 * not by import: `src/domain/` depends on nothing else in `src/` (see
 * `docs/architecture/DEPENDENCY_MAP.md`), so a web-layer type cannot be
 * imported here. A caller in `src/web/`/`src/application/` passes
 * `session.principal.principalId` directly - a branded string is a
 * structural subtype of `string`, so no adapter is needed at the call
 * site.
 */
export interface OrganizationMembership {
  readonly membershipId: MembershipId;
  readonly tenantId: TenantScope["tenantId"];
  readonly principalRef: string;
  readonly role: OrganizationRole;
}

/**
 * §4: "UNKNOWN / UNASSIGNED / NOT_APPLICABLE / UNAVAILABLE remain
 * first-class states." `ASSIGNED` is the only status `createAssignmentReference`
 * can ever produce as a stored value; the other four are returned only
 * by `resolveAssignmentStatus` below, never written onto a stored
 * reference, so a membership can never be silently "half-assigned."
 * `NOT_APPLICABLE`/`UNKNOWN` are declared but not produced by this
 * bounded foundation slice - `resolveAssignmentStatus` is given a
 * concrete assignment list and a concrete membership, so it always has
 * enough information to return `ASSIGNED`/`UNASSIGNED`/`UNAVAILABLE`;
 * reserved for a future caller context that genuinely cannot resolve an
 * answer (e.g. the assignment data source itself is unreachable) - same
 * "declared, not yet producible in this slice" discipline already
 * established by `NextActionOwner.EXTERNAL_WAIT` in
 * `client-project-snapshot.ts`.
 */
export type AssignmentStatus =
  | "ASSIGNED"
  | "UNASSIGNED"
  | "NOT_APPLICABLE"
  | "UNAVAILABLE"
  | "UNKNOWN";

/**
 * A generic organization-member -> customer/project assignment
 * reference (Workstream A foundation only). This deliberately does NOT
 * distinguish LeadOwner/DealOwner/AccountOwner/DeliveryOwner
 * (Workstream B, not built here) - it only proves *that* a member is
 * assigned to a given tenant-scoped customer/project context, never
 * *what kind* of ownership that assignment carries. `customerId`/
 * `projectId` are plain string identity, deliberately not importing
 * `ProjectOwnershipRef` (V2-CDO-003) - this foundation module does not
 * yet couple to that exact constructor surface; a later Workstream B/C
 * slice may tighten this once the real ownership-assignment shape is
 * live-resolved.
 */
export interface AssignmentReference {
  readonly assignmentId: AssignmentId;
  readonly tenantId: TenantScope["tenantId"];
  readonly membershipId: MembershipId;
  readonly customerId: string;
  readonly projectId?: string;
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

/**
 * Construction-time validation, matching the repository's existing
 * pattern (reject malformed/empty identifiers at construction, not at
 * later consumption). Immutable: a role change is a new
 * `OrganizationMembership` value, never an in-place mutation - no
 * mutation function is implemented or exposed.
 */
export function createOrganizationMembership(input: {
  membershipId: unknown;
  tenantScope: TenantScope;
  principalRef: unknown;
  role: unknown;
}): OrganizationMembership {
  const membershipId = requireNonEmptyString(
    input.membershipId,
    "membershipId",
    InvalidOrganizationMembershipError,
  );
  const principalRef = requireNonEmptyString(
    input.principalRef,
    "principalRef",
    InvalidOrganizationMembershipError,
  );
  if (typeof input.role !== "string" || !ORGANIZATION_ROLE_VALUES.has(input.role)) {
    throw new InvalidOrganizationMembershipError(
      `role must be one of ${Array.from(ORGANIZATION_ROLE_VALUES).join(", ")}`,
    );
  }
  return {
    membershipId: membershipId as MembershipId,
    tenantId: input.tenantScope.tenantId,
    principalRef,
    role: input.role as OrganizationRole,
  };
}

/**
 * §4 acceptance direction: "no cross-tenant membership leakage" - an
 * assignment's `tenantId` is always taken from the given `membership`
 * itself (never a separately supplied value), so an assignment can
 * never be constructed against a tenant its own membership does not
 * belong to.
 */
export function createAssignmentReference(input: {
  assignmentId: unknown;
  membership: OrganizationMembership;
  customerId: unknown;
  projectId?: unknown;
}): AssignmentReference {
  const assignmentId = requireNonEmptyString(
    input.assignmentId,
    "assignmentId",
    InvalidAssignmentReferenceError,
  );
  const customerId = requireNonEmptyString(
    input.customerId,
    "customerId",
    InvalidAssignmentReferenceError,
  );
  if (input.projectId === undefined) {
    return {
      assignmentId: assignmentId as AssignmentId,
      tenantId: input.membership.tenantId,
      membershipId: input.membership.membershipId,
      customerId,
    };
  }
  const projectId = requireNonEmptyString(
    input.projectId,
    "projectId",
    InvalidAssignmentReferenceError,
  );
  return {
    assignmentId: assignmentId as AssignmentId,
    tenantId: input.membership.tenantId,
    membershipId: input.membership.membershipId,
    customerId,
    projectId,
  };
}

/**
 * §4 acceptance direction: "unauthorized organization/client identifiers
 * reject" + "stale role/membership state cannot grant access." Fail-
 * closed resolution: an assignment only reads as `ASSIGNED` when its
 * `tenantId` AND `membershipId` both exactly match the given
 * `membership` - a same-`membershipId`-different-tenant collision
 * (adversarial cross-tenant membership-id reuse) resolves to
 * `UNAVAILABLE`, never silently to `ASSIGNED`. No matching assignment at
 * all resolves to `UNASSIGNED`. This function performs no mutation and
 * consults only its own arguments - it cannot grant access itself; a
 * caller must still separately pass an `authority.ts` permission check
 * before performing any protected action.
 */
export function resolveAssignmentStatus(input: {
  membership: OrganizationMembership;
  assignments: ReadonlyArray<AssignmentReference>;
  customerId: string;
  projectId?: string;
}): AssignmentStatus {
  const match = input.assignments.find((assignment) => {
    if (assignment.membershipId !== input.membership.membershipId) {
      return false;
    }
    if (assignment.tenantId !== input.membership.tenantId) {
      return false;
    }
    if (assignment.customerId !== input.customerId) {
      return false;
    }
    if (input.projectId !== undefined && assignment.projectId !== input.projectId) {
      return false;
    }
    return true;
  });
  if (match !== undefined) {
    return "ASSIGNED";
  }

  const crossTenantCollision = input.assignments.some(
    (assignment) =>
      assignment.membershipId === input.membership.membershipId &&
      assignment.tenantId !== input.membership.tenantId,
  );
  if (crossTenantCollision) {
    return "UNAVAILABLE";
  }

  return "UNASSIGNED";
}
