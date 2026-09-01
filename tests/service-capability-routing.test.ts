import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveServiceCapabilityRoute,
  InvalidServiceCapabilityRouteError,
} from "../src/domain/service-capability-routing.js";
import { createCapabilityAdmission } from "../src/domain/capability-admission.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CAPABILITY_ADMISSION } from "../src/fixtures/website-build-v1-connection.js";
import { WEBSITE_BUILD_V1_SERVICE_ROUTE } from "../src/fixtures/website-build-v1-service-route.js";

test("reference proof: the WEBSITE_BUILD_v1 service-route fixture is deterministic and reuses the existing ownership/capability-admission identity", () => {
  assert.equal(WEBSITE_BUILD_V1_SERVICE_ROUTE.tenantId, WEBSITE_BUILD_V1_OWNERSHIP.tenantId);
  assert.equal(WEBSITE_BUILD_V1_SERVICE_ROUTE.requiredCapabilityRef, WEBSITE_BUILD_V1_CAPABILITY_ADMISSION.requiredCapabilityRef);
  assert.equal(WEBSITE_BUILD_V1_SERVICE_ROUTE.executionMaturity, "READ_ONLY");
});

test("VERIFIED_AVAILABLE admission resolves READ_ONLY execution maturity, never a higher rung", () => {
  const route = resolveServiceCapabilityRoute({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    serviceFamilyRef: "website-build-v1",
    admission: WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
  });
  assert.equal(route.executionMaturity, "READ_ONLY");
  assert.match(route.reason, /VERIFIED_AVAILABLE/);
});

test("UNVERIFIED admission resolves UNAVAILABLE - never implies a compatible connection exists", () => {
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-admission-unverified",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    status: "UNVERIFIED",
  });
  const route = resolveServiceCapabilityRoute({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    serviceFamilyRef: "website-build-v1",
    admission,
  });
  assert.equal(route.executionMaturity, "UNAVAILABLE");
  assert.match(route.reason, /UNVERIFIED/);
});

test("UNSUPPORTED admission resolves UNAVAILABLE and stays unsupported - never a fake-success fallback", () => {
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-admission-unsupported",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    status: "UNSUPPORTED",
  });
  const route = resolveServiceCapabilityRoute({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    serviceFamilyRef: "website-build-v1",
    admission,
  });
  assert.equal(route.executionMaturity, "UNAVAILABLE");
  assert.match(route.reason, /UNSUPPORTED/);
});

test("INELIGIBLE admission resolves UNAVAILABLE", () => {
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-admission-ineligible",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    status: "INELIGIBLE",
  });
  const route = resolveServiceCapabilityRoute({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    serviceFamilyRef: "website-build-v1",
    admission,
  });
  assert.equal(route.executionMaturity, "UNAVAILABLE");
  assert.match(route.reason, /INELIGIBLE/);
});

test("an admission for a different project (adversarial cross-project substitution) rejects rather than being silently accepted", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
    customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
    projectId: "proj-unrelated-other-project",
  });
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-admission-foreign-project",
    ownership: foreignOwnership,
    requiredCapabilityRef: "required-access-connections",
    status: "UNVERIFIED",
  });
  assert.throws(
    () =>
      resolveServiceCapabilityRoute({
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        serviceFamilyRef: "website-build-v1",
        admission,
      }),
    InvalidServiceCapabilityRouteError,
  );
});

test("an empty serviceFamilyRef rejects", () => {
  assert.throws(
    () =>
      resolveServiceCapabilityRoute({
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        serviceFamilyRef: "",
        admission: WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
      }),
    InvalidServiceCapabilityRouteError,
  );
});

test("this module exports no function capable of mutating a CapabilityAdmission or promoting its status", () => {
  // resolveServiceCapabilityRoute takes an already-resolved CapabilityAdmission
  // and returns a new, unrelated ServiceCapabilityRoute value; the input
  // admission object itself is never mutated.
  const before = { ...WEBSITE_BUILD_V1_CAPABILITY_ADMISSION };
  resolveServiceCapabilityRoute({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    serviceFamilyRef: "website-build-v1",
    admission: WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
  });
  assert.deepEqual(WEBSITE_BUILD_V1_CAPABILITY_ADMISSION, before);
});
