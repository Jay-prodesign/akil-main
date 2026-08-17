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

test("T11: defaults to LearningEligibility NONE", () => {
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-1",
    displayName: "Acme Corp",
  });
  assert.equal(customer.learningEligibility, "NONE");
});

test("RG-07: extra input fields cannot silently promote learning eligibility", () => {
  // createCustomer's input type has no learningEligibility parameter at
  // all; `as any` simulates a caller (or a loosely-typed integration)
  // trying to smuggle one in anyway. It must have zero effect.
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-1",
    displayName: "Acme Corp",
    learningEligibility: "ACTIVE",
  } as unknown as Parameters<typeof createCustomer>[0]);
  assert.equal(customer.learningEligibility, "NONE");
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
