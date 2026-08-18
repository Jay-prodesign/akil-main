import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject, InvalidProjectError } from "../src/domain/project.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");
const customerInA = createCustomer({
  tenantScope: tenantA,
  customerId: "cust-1",
  displayName: "Acme Corp",
});

test("creates a Project for a customer in the same tenant", () => {
  const project = createProject({
    tenantScope: tenantA,
    customer: customerInA,
    projectId: "proj-1",
    ownerRef: "owner-1",
    state: "active",
  });
  assert.equal(project.tenantId, "tenant-a");
  assert.equal(project.customerId, "cust-1");
  assert.equal(project.projectId, "proj-1");
});

test("RG-01: rejects a tenant-scope swap (customer from tenant A, tenantScope B)", () => {
  assert.throws(
    () =>
      createProject({
        tenantScope: tenantB,
        customer: customerInA,
        projectId: "proj-1",
        ownerRef: "owner-1",
        state: "active",
      }),
    InvalidProjectError,
  );
});

test("rejects a missing projectId", () => {
  assert.throws(
    () =>
      createProject({
        tenantScope: tenantA,
        customer: customerInA,
        projectId: undefined,
        ownerRef: "owner-1",
        state: "active",
      }),
    InvalidProjectError,
  );
});

test("rejects a missing state", () => {
  assert.throws(
    () =>
      createProject({
        tenantScope: tenantA,
        customer: customerInA,
        projectId: "proj-1",
        ownerRef: "owner-1",
        state: "",
      }),
    InvalidProjectError,
  );
});
