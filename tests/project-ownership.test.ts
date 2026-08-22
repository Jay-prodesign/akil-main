import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, InvalidProjectOwnershipRefError } from "../src/domain/project-ownership.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";

test("O1: a valid minimal ownership ref is deterministic", () => {
  const a = createProjectOwnershipRef({
    tenantId: "tenant-1",
    customerId: "cust-1",
    projectId: "proj-1",
  });
  const b = createProjectOwnershipRef({
    tenantId: "tenant-1",
    customerId: "cust-1",
    projectId: "proj-1",
  });
  assert.deepEqual(a, b);
});

test("O1: an ownership ref with an explicit serviceRef preserves it", () => {
  const ref = createProjectOwnershipRef({
    tenantId: "tenant-1",
    customerId: "cust-1",
    projectId: "proj-1",
    serviceRef: "svc-hosting",
  });
  assert.equal(ref.serviceRef, "svc-hosting");
});

test("O1: omitting serviceRef never produces the key at all", () => {
  const ref = createProjectOwnershipRef({
    tenantId: "tenant-1",
    customerId: "cust-1",
    projectId: "proj-1",
  });
  assert.equal("serviceRef" in ref, false);
});

test("O1 reference proof: the WEBSITE_BUILD_v1 communication fixture's ownership reuses the existing DEL-003 fixture's project identity", () => {
  const { project } = buildWebsiteBuildV1Fixture();
  assert.equal(WEBSITE_BUILD_V1_OWNERSHIP.tenantId, project.tenantId);
  assert.equal(WEBSITE_BUILD_V1_OWNERSHIP.customerId, project.customerId);
  assert.equal(WEBSITE_BUILD_V1_OWNERSHIP.projectId, project.projectId);
});

test("O2: rejects a missing tenantId", () => {
  assert.throws(
    () => createProjectOwnershipRef({ tenantId: undefined, customerId: "c", projectId: "p" }),
    InvalidProjectOwnershipRefError,
  );
});

test("O2: rejects an empty-string customerId", () => {
  assert.throws(
    () => createProjectOwnershipRef({ tenantId: "t", customerId: "", projectId: "p" }),
    InvalidProjectOwnershipRefError,
  );
});

test("O2: rejects a whitespace-only projectId", () => {
  assert.throws(
    () => createProjectOwnershipRef({ tenantId: "t", customerId: "c", projectId: "   " }),
    InvalidProjectOwnershipRefError,
  );
});

test("O2: rejects an explicit empty-string serviceRef (must be absent, not empty, to omit it)", () => {
  assert.throws(
    () => createProjectOwnershipRef({ tenantId: "t", customerId: "c", projectId: "p", serviceRef: "" }),
    InvalidProjectOwnershipRefError,
  );
});
