import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";

export class InvalidProjectError extends Error {
  constructor(reason: string) {
    super(`Invalid Project: ${reason}`);
    this.name = "InvalidProjectError";
  }
}

type ProjectId = string & { readonly __brand: "ProjectId" };

/**
 * Project belongs to exactly one tenantId + customerId (AKI-BE-001
 * execution record, "First-Slice Domain Semantics"). `state` is a
 * free-form non-empty label: the source packet defines a canonical
 * lifecycle only for OutcomeJob, not for Project, so no Project state
 * enum is invented here.
 */
export interface Project {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: ProjectId;
  readonly ownerRef: string;
  readonly state: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidProjectError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidProjectError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidProjectError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidProjectError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * T2 / RG-01 (tenant scope swap) at construction time: a Project cannot
 * be built by combining a Customer from one tenant with a different
 * tenantScope. Valid ID shape never substitutes for matching TenantScope.
 */
export function createProject(input: {
  tenantScope: TenantScope;
  customer: Customer;
  projectId: unknown;
  ownerRef: unknown;
  state: unknown;
}): Project {
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProjectError(
      "customer does not belong to the given tenantScope",
    );
  }
  const projectId = requireNonEmptyString(input.projectId, "projectId");
  const ownerRef = requireNonEmptyString(input.ownerRef, "ownerRef");
  const state = requireNonEmptyString(input.state, "state");
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: projectId as ProjectId,
    ownerRef,
    state,
  };
}
