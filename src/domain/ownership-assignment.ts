import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { OrganizationMembership } from "./organization-membership.js";

export class InvalidOwnershipAssignmentError extends Error {
  constructor(reason: string) {
    super(`Invalid OwnershipAssignment: ${reason}`);
    this.name = "InvalidOwnershipAssignmentError";
  }
}

type OwnershipAssignmentId = string & { readonly __brand: "OwnershipAssignmentId" };

/**
 * V3 Workstream B (§5), spine item C - depends directly on the
 * Workstream A foundation (V3-ORG-001: `OrganizationMembership`) landed
 * in the prior checkpoint. "LeadOwner, DealOwner, AccountOwner and
 * DeliveryOwner are independent assignments... one role never implies
 * another." Each `OwnershipAssignment` binds exactly one `OwnerRole` to
 * one membership for one ownership scope - a member holding multiple
 * owner roles (or the same role across multiple projects) is
 * represented by multiple distinct records, never a multi-value field,
 * so "one role never implies another" is structural, not a runtime
 * check.
 */
export type OwnerRole = "LEAD_OWNER" | "DEAL_OWNER" | "ACCOUNT_OWNER" | "DELIVERY_OWNER";

const OWNER_ROLE_VALUES: ReadonlySet<string> = new Set([
  "LEAD_OWNER",
  "DEAL_OWNER",
  "ACCOUNT_OWNER",
  "DELIVERY_OWNER",
]);

/**
 * §5: "ownership presentation cannot manufacture transition/approval
 * authority over ProjectPlan/OutcomeJob." This module imports no
 * create/transition/verify function from `outcome-job.ts` or
 * `project-plan.ts` (types only would not even be needed - it imports
 * neither), so an `OwnershipAssignment` cannot itself transition an
 * `OutcomeJob` or approve a `ProjectPlanVersion`; those remain solely
 * `outcome-job.ts`/`project-plan.ts`/`approval-reference.ts`'s concern.
 *
 * §5: "owner changes preserve provenance and do not erase prior
 * accountable history." A record is never mutated in place - no
 * function in this module accepts an existing `OwnershipAssignment` and
 * returns the same identity with changed fields; `reassignOwnership`
 * below returns two new values (a superseded copy of the old record
 * plus a new current record) and leaves the caller responsible for
 * persisting both, append-only (matching the existing repository
 * pattern of separating a pure domain type from its durable store, e.g.
 * `outcome-job.ts` vs. `durable-outcome-job-store.ts`).
 */
export interface OwnershipAssignment {
  readonly ownershipAssignmentId: OwnershipAssignmentId;
  readonly tenantId: TenantScope["tenantId"];
  readonly ownership: ProjectOwnershipRef;
  readonly membershipId: OrganizationMembership["membershipId"];
  readonly ownerRole: OwnerRole;
  readonly assignedAt: string;
  readonly supersededAt?: string;
  readonly supersededByAssignmentId?: OwnershipAssignmentId;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOwnershipAssignmentError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidOwnershipAssignmentError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOwnershipAssignmentError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * §5 acceptance direction: "invalid/foreign owner reference fails
 * closed" - the given `membership`'s tenant must exactly match the
 * given `ownership`'s tenant, or construction rejects. A membership from
 * a different tenant than the ownership scope it is being assigned to
 * is contamination, not silently accepted.
 */
export function createOwnershipAssignment(input: {
  ownershipAssignmentId: unknown;
  membership: OrganizationMembership;
  ownership: ProjectOwnershipRef;
  ownerRole: unknown;
  assignedAt: unknown;
}): OwnershipAssignment {
  if (input.membership.tenantId !== input.ownership.tenantId) {
    throw new InvalidOwnershipAssignmentError(
      "membership tenant does not match the given ownership scope's tenant",
    );
  }
  const ownershipAssignmentId = requireNonEmptyString(
    input.ownershipAssignmentId,
    "ownershipAssignmentId",
  );
  if (typeof input.ownerRole !== "string" || !OWNER_ROLE_VALUES.has(input.ownerRole)) {
    throw new InvalidOwnershipAssignmentError(
      `ownerRole must be one of ${Array.from(OWNER_ROLE_VALUES).join(", ")}`,
    );
  }
  const assignedAt = requireNonEmptyString(input.assignedAt, "assignedAt");
  return {
    ownershipAssignmentId: ownershipAssignmentId as OwnershipAssignmentId,
    tenantId: input.membership.tenantId,
    ownership: input.ownership,
    membershipId: input.membership.membershipId,
    ownerRole: input.ownerRole as OwnerRole,
    assignedAt,
  };
}

/**
 * §5 acceptance direction: "reassignment preserves exact scope and
 * cannot cross tenant/client boundary." The returned `next` record
 * reuses `priorAssignment.ownership`/`ownerRole` verbatim - only the
 * assignee (`membershipId`) and `assignedAt` change - and construction
 * rejects if `newMembership` belongs to a different tenant than the
 * prior assignment. The prior record is returned as a `superseded` copy
 * (original fields plus `supersededAt`/`supersededByAssignmentId`), not
 * mutated or discarded - the caller must persist both to preserve
 * provenance; this function has no store and cannot delete anything
 * itself.
 */
export function reassignOwnership(input: {
  priorAssignment: OwnershipAssignment;
  newOwnershipAssignmentId: unknown;
  newMembership: OrganizationMembership;
  reassignedAt: unknown;
}): { superseded: OwnershipAssignment; next: OwnershipAssignment } {
  if (input.newMembership.tenantId !== input.priorAssignment.tenantId) {
    throw new InvalidOwnershipAssignmentError(
      "reassignment cannot cross tenant boundary: newMembership belongs to a different tenant than the prior assignment",
    );
  }
  if (input.priorAssignment.supersededAt !== undefined) {
    throw new InvalidOwnershipAssignmentError(
      "priorAssignment has already been superseded and cannot be reassigned again",
    );
  }
  const newOwnershipAssignmentId = requireNonEmptyString(
    input.newOwnershipAssignmentId,
    "newOwnershipAssignmentId",
  );
  const reassignedAt = requireNonEmptyString(input.reassignedAt, "reassignedAt");

  const next: OwnershipAssignment = {
    ownershipAssignmentId: newOwnershipAssignmentId as OwnershipAssignmentId,
    tenantId: input.priorAssignment.tenantId,
    ownership: input.priorAssignment.ownership,
    membershipId: input.newMembership.membershipId,
    ownerRole: input.priorAssignment.ownerRole,
    assignedAt: reassignedAt,
  };
  const superseded: OwnershipAssignment = {
    ...input.priorAssignment,
    supersededAt: reassignedAt,
    supersededByAssignmentId: next.ownershipAssignmentId,
  };
  return { superseded, next };
}

/**
 * §5 acceptance direction: "owner-specific views use canonical state
 * rather than UI defaults." Returns `undefined` when no active
 * (non-superseded) record exists for the given scope/role - a
 * legitimate first-class "no current owner" state, never guessed or
 * defaulted. If more than one active record exists for the same exact
 * scope/role (a data-integrity violation no correct caller should ever
 * produce), this function fails closed by throwing rather than silently
 * picking one - presenting an arbitrary guess as "the" canonical owner
 * would itself violate this same acceptance direction.
 */
export function resolveCurrentOwner(input: {
  history: ReadonlyArray<OwnershipAssignment>;
  ownership: ProjectOwnershipRef;
  ownerRole: OwnerRole;
}): OwnershipAssignment | undefined {
  const active = input.history.filter(
    (assignment) =>
      assignment.supersededAt === undefined &&
      assignment.ownerRole === input.ownerRole &&
      assignment.ownership.tenantId === input.ownership.tenantId &&
      assignment.ownership.customerId === input.ownership.customerId &&
      assignment.ownership.projectId === input.ownership.projectId,
  );
  if (active.length > 1) {
    throw new InvalidOwnershipAssignmentError(
      `data integrity violation: ${active.length} active ${input.ownerRole} assignments found for the same ownership scope`,
    );
  }
  return active[0];
}
