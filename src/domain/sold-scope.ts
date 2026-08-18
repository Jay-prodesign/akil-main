import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidSoldScopeError extends Error {
  constructor(reason: string) {
    super(`Invalid SoldScope: ${reason}`);
    this.name = "InvalidSoldScopeError";
  }
}

type SoldScopeId = string & { readonly __brand: "SoldScopeId" };

/**
 * Bounded commercial scope/acceptance reference (DEL-003 "Input
 * contracts" #1). Declares, for CONDITIONAL blueprint requirements only,
 * which are explicitly sold-in or sold-out; REQUIRED requirements are
 * always in scope regardless of this declaration (see `compilePlan`).
 * `includedRequirementIds` and `excludedRequirementIds` are mutually
 * exclusive per requirementId - a requirement left out of both remains
 * UNKNOWN until an explicit scope decision is made (T4).
 */
export interface SoldScope {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: Project["projectId"];
  readonly soldScopeId: SoldScopeId;
  readonly outcomeContractRef: string;
  readonly includedRequirementIds: ReadonlyArray<RequirementId>;
  readonly excludedRequirementIds: ReadonlyArray<RequirementId>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidSoldScopeError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidSoldScopeError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidSoldScopeError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidSoldScopeError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireRequirementIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidSoldScopeError(`${field} must be an array`);
  }
  return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

export function createSoldScope(input: {
  tenantScope: TenantScope;
  project: Project;
  soldScopeId: unknown;
  outcomeContractRef: unknown;
  includedRequirementIds?: unknown;
  excludedRequirementIds?: unknown;
}): SoldScope {
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidSoldScopeError(
      "project does not belong to the given tenantScope",
    );
  }
  const soldScopeId = requireNonEmptyString(input.soldScopeId, "soldScopeId");
  const outcomeContractRef = requireNonEmptyString(
    input.outcomeContractRef,
    "outcomeContractRef",
  );
  const includedRequirementIds = requireRequirementIdArray(
    input.includedRequirementIds ?? [],
    "includedRequirementIds",
  );
  const excludedRequirementIds = requireRequirementIdArray(
    input.excludedRequirementIds ?? [],
    "excludedRequirementIds",
  );
  const overlap = includedRequirementIds.filter((id) =>
    excludedRequirementIds.includes(id),
  );
  if (overlap.length > 0) {
    throw new InvalidSoldScopeError(
      `requirementId(s) cannot be both included and excluded: ${overlap.join(", ")}`,
    );
  }
  return {
    tenantId: input.tenantScope.tenantId,
    projectId: input.project.projectId,
    soldScopeId: soldScopeId as SoldScopeId,
    outcomeContractRef,
    includedRequirementIds: includedRequirementIds.map((id) => id as RequirementId),
    excludedRequirementIds: excludedRequirementIds.map((id) => id as RequirementId),
  };
}
