import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";

export class InvalidProjectOwnershipRefError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectOwnershipRef: ${reason}`);
    this.name = "InvalidProjectOwnershipRefError";
  }
}

/**
 * V2-CDO-003 "CustomerProjectOwnershipRef" (IN SCOPE #1). A stable
 * reference tuple only - it does not create a second customer/project
 * lifecycle. `tenantId` maps onto the pre-existing organizational
 * boundary identifier this repository already has (`TenantScope.tenantId`
 * - see `tenant-scope.ts`'s own doc comment: "a boundary identifier, not
 * a full IAM/organization product"); there is no separate `Organization`
 * type in this repository to reuse instead, so this mapping is recorded
 * here per the V2-CDO-003 task head's explicit reuse instruction rather
 * than inventing a parallel organization identity. `customerId` and
 * `projectId` reuse `Customer.customerId` / `Project.projectId` directly.
 * `serviceRef` is the one genuinely new, optional field - this repository
 * has no existing "service" identity to reuse.
 */
export interface ProjectOwnershipRef {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly serviceRef?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidProjectOwnershipRefError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidProjectOwnershipRefError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidProjectOwnershipRefError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidProjectOwnershipRefError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * O2: rejects an empty/missing customer, organization (tenantId) or
 * project ref. `serviceRef`, when supplied, must be an explicit non-empty
 * string (task head invariant: "service context is explicit when
 * present") - `undefined` (absent) is the only accepted way to omit it.
 */
export function createProjectOwnershipRef(input: {
  tenantId: unknown;
  customerId: unknown;
  projectId: unknown;
  serviceRef?: unknown;
}): ProjectOwnershipRef {
  const tenantId = requireNonEmptyString(input.tenantId, "tenantId");
  const customerId = requireNonEmptyString(input.customerId, "customerId");
  const projectId = requireNonEmptyString(input.projectId, "projectId");
  if (input.serviceRef === undefined) {
    return {
      tenantId: tenantId as TenantScope["tenantId"],
      customerId: customerId as Customer["customerId"],
      projectId: projectId as Project["projectId"],
    };
  }
  const serviceRef = requireNonEmptyString(input.serviceRef, "serviceRef");
  return {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as Customer["customerId"],
    projectId: projectId as Project["projectId"],
    serviceRef,
  };
}
