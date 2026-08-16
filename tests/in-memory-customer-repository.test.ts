import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer, type Customer } from "../src/domain/customer.js";
import { InMemoryCustomerRepository } from "../src/application/in-memory-customer-repository.js";

test("T2: finds a saved customer by matching tenant and customerId", () => {
  const tenantA = createTenantScope("tenant-a");
  const customer = createCustomer({
    tenantScope: tenantA,
    customerId: "cust-1",
    displayName: "Acme Corp",
  });
  const repo = new InMemoryCustomerRepository();
  repo.save(customer);

  const found = repo.findByTenantAndId(tenantA, customer.customerId);
  assert.deepEqual(found, customer);
});

test("T2 / RG-01: cross-tenant lookup fails closed (same customerId, different tenant)", () => {
  const tenantA = createTenantScope("tenant-a");
  const tenantB = createTenantScope("tenant-b");
  const customer = createCustomer({
    tenantScope: tenantA,
    customerId: "cust-1",
    displayName: "Acme Corp",
  });
  const repo = new InMemoryCustomerRepository();
  repo.save(customer);

  const found = repo.findByTenantAndId(tenantB, customer.customerId);
  assert.equal(found, undefined);
});

test("returns undefined for an unknown customerId in a known tenant", () => {
  const tenantA = createTenantScope("tenant-a");
  const repo = new InMemoryCustomerRepository();

  const found = repo.findByTenantAndId(
    tenantA,
    "cust-does-not-exist" as Customer["customerId"],
  );
  assert.equal(found, undefined);
});
