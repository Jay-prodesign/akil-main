import type { TenantScope } from "./tenant-scope.js";

export class InvalidCustomerError extends Error {
  constructor(reason: string) {
    super(`Invalid Customer: ${reason}`);
    this.name = "InvalidCustomerError";
  }
}

type CustomerId = string & { readonly __brand: "CustomerId" };

/**
 * Customer belongs to exactly one TenantScope (AKI-BE-001 execution
 * record, "First-Slice Domain Semantics"). No unnecessary PII fields.
 */
export interface Customer {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: CustomerId;
  readonly displayName: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCustomerError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidCustomerError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidCustomerError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidCustomerError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createCustomer(input: {
  tenantScope: TenantScope;
  customerId: unknown;
  displayName: unknown;
}): Customer {
  const customerId = requireNonEmptyString(input.customerId, "customerId");
  const displayName = requireNonEmptyString(input.displayName, "displayName");
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: customerId as CustomerId,
    displayName,
  };
}
