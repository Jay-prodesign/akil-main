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

test("CXP-001W: distinct (tenantId, customerId) tuples whose components straddle the raw `::` delimiter are stored independently, not collided into one record", () => {
  const tenantIdA = "a::b";
  const customerIdA = "c";
  const tenantIdB = "a";
  const customerIdB = "b::c";

  // Prove the defect this test guards against was real: the old
  // `${tenantId}::${customerId}` formula genuinely collides for this
  // exact pair of distinct tuples.
  const oldKey = (tenantId: string, customerId: string): string => `${tenantId}::${customerId}`;
  assert.equal(oldKey(tenantIdA, customerIdA), oldKey(tenantIdB, customerIdB));

  const tenantScopeA = createTenantScope(tenantIdA);
  const customerA = createCustomer({
    tenantScope: tenantScopeA,
    customerId: customerIdA,
    displayName: "Tuple A",
  });
  const tenantScopeB = createTenantScope(tenantIdB);
  const customerB = createCustomer({
    tenantScope: tenantScopeB,
    customerId: customerIdB,
    displayName: "Tuple B",
  });

  const repo = new InMemoryCustomerRepository();
  repo.save(customerA);
  repo.save(customerB);

  const foundA = repo.findByTenantAndId(tenantScopeA, customerA.customerId);
  const foundB = repo.findByTenantAndId(tenantScopeB, customerB.customerId);
  assert.deepEqual(foundA, customerA);
  assert.deepEqual(foundB, customerB);
  assert.equal(foundA?.displayName, "Tuple A");
  assert.equal(foundB?.displayName, "Tuple B");
});
