import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer, InvalidCustomerError } from "../src/domain/customer.js";

const tenantScope = createTenantScope("tenant-acme");

test("creates a Customer scoped to the given tenant", () => {
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-1",
    displayName: "Acme Corp",
  });
  assert.equal(customer.tenantId, "tenant-acme");
  assert.equal(customer.customerId, "cust-1");
  assert.equal(customer.displayName, "Acme Corp");
});

test("rejects a missing customerId", () => {
  assert.throws(
    () =>
      createCustomer({ tenantScope, customerId: undefined, displayName: "Acme" }),
    InvalidCustomerError,
  );
});

test("rejects an empty displayName", () => {
  assert.throws(
    () => createCustomer({ tenantScope, customerId: "cust-1", displayName: "" }),
    InvalidCustomerError,
  );
});

test("rejects a whitespace-only customerId", () => {
  assert.throws(
    () =>
      createCustomer({ tenantScope, customerId: "   ", displayName: "Acme" }),
    InvalidCustomerError,
  );
});
