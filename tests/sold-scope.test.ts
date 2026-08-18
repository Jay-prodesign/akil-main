import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createSoldScope, InvalidSoldScopeError } from "../src/domain/sold-scope.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

test("creates a SoldScope with included and excluded requirementIds", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["a"],
    excludedRequirementIds: ["b"],
  });
  assert.deepEqual(soldScope.includedRequirementIds, ["a"]);
  assert.deepEqual(soldScope.excludedRequirementIds, ["b"]);
});

test("defaults included/excludedRequirementIds to empty arrays", () => {
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  assert.deepEqual(soldScope.includedRequirementIds, []);
  assert.deepEqual(soldScope.excludedRequirementIds, []);
});

test("rejects a project that does not belong to the given tenantScope", () => {
  const otherTenantScope = createTenantScope("tenant-b");
  assert.throws(
    () =>
      createSoldScope({
        tenantScope: otherTenantScope,
        project,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidSoldScopeError,
  );
});

test("rejects a requirementId that is both included and excluded", () => {
  assert.throws(
    () =>
      createSoldScope({
        tenantScope,
        project,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
        includedRequirementIds: ["a"],
        excludedRequirementIds: ["a"],
      }),
    InvalidSoldScopeError,
  );
});
