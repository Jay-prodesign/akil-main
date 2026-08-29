import type { Customer } from "../domain/customer.js";
import type { TenantScope } from "../domain/tenant-scope.js";

/**
 * Structural tenant scope (Engineering Invariant 4 / RG-02): every lookup
 * method requires a TenantScope. No bare findById(id)-style accessor is
 * exposed by this port, by construction of the interface itself.
 */
export interface CustomerRepository {
  save(customer: Customer): void;
  findByTenantAndId(
    tenantScope: TenantScope,
    customerId: Customer["customerId"],
  ): Customer | undefined;
}
