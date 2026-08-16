import type { Customer } from "../domain/customer.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import type { CustomerRepository } from "../ports/customer-repository.js";

function key(tenantId: string, customerId: string): string {
  return `${tenantId}::${customerId}`;
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
