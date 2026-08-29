import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createCustomerEvidenceItem,
  InvalidCustomerEvidenceError,
} from "../src/domain/customer-evidence.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

test("creates a CustomerEvidenceItem with a related requirementId", () => {
  const item = createCustomerEvidenceItem({
    tenantScope,
    project,
    evidenceRef: "ev-1",
    kind: "FACT",
    subject: "Customer has an existing logo",
    sourceLocator: "internal://tests/evidence-1",
    relatedRequirementId: "discovery-evidence-intake",
  });
  assert.equal(item.kind, "FACT");
  assert.equal(item.relatedRequirementId, "discovery-evidence-intake");
});

test("creates a CustomerEvidenceItem without a related requirementId", () => {
  const item = createCustomerEvidenceItem({
    tenantScope,
    project,
    evidenceRef: "ev-1",
    kind: "UNKNOWN",
    subject: "Unclear whether customer wants a blog",
    sourceLocator: "internal://tests/evidence-2",
  });
  assert.equal(item.relatedRequirementId, undefined);
});

test("rejects an invalid kind", () => {
  assert.throws(
    () =>
      createCustomerEvidenceItem({
        tenantScope,
        project,
        evidenceRef: "ev-1",
        kind: "GUESS",
        subject: "x",
        sourceLocator: "internal://tests",
      }),
    InvalidCustomerEvidenceError,
  );
});

test("rejects a project that does not belong to the given tenantScope", () => {
  const otherTenantScope = createTenantScope("tenant-b");
  assert.throws(
    () =>
      createCustomerEvidenceItem({
        tenantScope: otherTenantScope,
        project,
        evidenceRef: "ev-1",
        kind: "FACT",
        subject: "x",
        sourceLocator: "internal://tests",
      }),
    InvalidCustomerEvidenceError,
  );
});
