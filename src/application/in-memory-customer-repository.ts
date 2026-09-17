import type { Customer } from "../domain/customer.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import type { CustomerRepository } from "../ports/customer-repository.js";

/**
 * Bounded scan correction (same class as Brain Rev44 F1/F2, CXP-001K/L/R/U/V):
 * `tenantId`/`customerId` are validated only as non-empty trimmed
 * strings, never as delimiter-free, so raw `::`-delimited concatenation
 * is not actually collision-safe - two distinct (tenantId, customerId)
 * tuples with a component containing `::` could resolve to the same map
 * key. This is a write-path defect: `save()` would silently let one
 * tenant/customer's Customer record overwrite another's, and
 * `findByTenantAndId()` would return the wrong tenant's customer data for
 * a colliding lookup. `JSON.stringify` of the identity tuple as an array
 * is injective for this purpose: JSON string escaping means two distinct
 * tuples can never serialize to the same string.
 */
function key(tenantId: string, customerId: string): string {
  return JSON.stringify([tenantId, customerId]);
}

/**
 * In-memory test adapter only (AKI-BE-001 Runtime/Persistence Boundary).
 * Production storage selection is deferred.
 */
export class InMemoryCustomerRepository implements CustomerRepository {
  #records = new Map<string, Customer>();

  save(customer: Customer): void {
    this.#records.set(key(customer.tenantId, customer.customerId), customer);
  }

  findByTenantAndId(
    tenantScope: TenantScope,
    customerId: Customer["customerId"],
  ): Customer | undefined {
    return this.#records.get(key(tenantScope.tenantId, customerId));
  }
}
