/**
 * TenantScope is the mandatory security/data-isolation partition carried by
 * every AKI-BE-001 record and application operation (AKI-BE-001 execution
 * record, "First-Slice Domain Semantics"). It is a boundary identifier, not
 * a full IAM/organization product.
 */

export class InvalidTenantScopeError extends Error {
  constructor(reason: string) {
    super(`Invalid TenantScope: ${reason}`);
    this.name = "InvalidTenantScopeError";
  }
}

type TenantId = string & { readonly __brand: "TenantId" };

export interface TenantScope {
  readonly tenantId: TenantId;
}

/**
 * T1: rejects invalid/missing tenant scope. Valid input is a non-empty
 * string with no leading/trailing whitespace.
 */
export function createTenantScope(tenantId: unknown): TenantScope {
  if (typeof tenantId !== "string") {
    throw new InvalidTenantScopeError("tenantId must be a string");
  }
  if (tenantId.length === 0) {
    throw new InvalidTenantScopeError("tenantId must not be empty");
  }
  if (tenantId.trim().length === 0) {
    throw new InvalidTenantScopeError("tenantId must not be whitespace-only");
  }
  if (tenantId.trim() !== tenantId) {
    throw new InvalidTenantScopeError(
      "tenantId must not contain leading or trailing whitespace",
    );
  }
  return { tenantId: tenantId as TenantId };
}
