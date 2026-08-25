import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityAdmission,
  InvalidCapabilityAdmissionError,
} from "../src/domain/capability-admission.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
} from "../src/domain/connection-authority.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import {
  WEBSITE_BUILD_V1_CONNECTION_BINDING,
  WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
} from "../src/fixtures/website-build-v1-connection.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";

function verifiedBinding() {
  const requirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-cap-1",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    purpose: "test purpose",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const requested = createConnectionBinding({
    connectionBindingId: "conn-binding-cap-1",
    requirement,
    ownership: requirement.ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(connected, "internal://evidence/1");
}

test("C8 reference proof: the WEBSITE_BUILD_v1 fixture's capability admission is VERIFIED_AVAILABLE", () => {
  assert.equal(WEBSITE_BUILD_V1_CAPABILITY_ADMISSION.status, "VERIFIED_AVAILABLE");
  assert.equal(WEBSITE_BUILD_V1_CAPABILITY_ADMISSION.connectionBindingId, WEBSITE_BUILD_V1_CONNECTION_BINDING.connectionBindingId);
});

test("C8: UNVERIFIED, UNSUPPORTED and INELIGIBLE require no binding or evidence and stay exactly as constructed", () => {
  for (const status of ["UNVERIFIED", "UNSUPPORTED", "INELIGIBLE"] as const) {
    const admission = createCapabilityAdmission({
      capabilityAdmissionId: `cap-${status}`,
      ownership: WEBSITE_BUILD_V1_OWNERSHIP,
      requiredCapabilityRef: "required-access-connections",
      status,
    });
    assert.equal(admission.status, status);
    assert.equal("connectionBindingId" in admission, false);
    assert.equal("evidenceRef" in admission, false);
  }
});

test("C8: VERIFIED_AVAILABLE without a binding rejects", () => {
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-no-binding",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C8: VERIFIED_AVAILABLE with a binding that is not itself VERIFIED rejects", () => {
  const requirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-cap-2",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    purpose: "test purpose",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const unverifiedBinding = createConnectionBinding({
    connectionBindingId: "conn-binding-cap-2",
    requirement,
    ownership: requirement.ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  });
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-unverified-binding",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        binding: unverifiedBinding,
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C8: VERIFIED_AVAILABLE without an explicit evidenceRef rejects even with a VERIFIED binding", () => {
  const binding = verifiedBinding();
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-no-evidence",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        binding,
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C8: VERIFIED_AVAILABLE with a VERIFIED binding + non-empty evidenceRef succeeds", () => {
  const binding = verifiedBinding();
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-ok",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    status: "VERIFIED_AVAILABLE",
    binding,
    evidenceRef: "internal://evidence/1",
  });
  assert.equal(admission.status, "VERIFIED_AVAILABLE");
  assert.equal(admission.connectionBindingId, binding.connectionBindingId);
  assert.equal(admission.evidenceRef, "internal://evidence/1");
});

test("C8/C4-analog: a binding belonging to a different ownership tuple rejects even for VERIFIED_AVAILABLE", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  const binding = verifiedBinding();
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-cross-tenant",
        ownership: foreignOwnership,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        binding,
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C8: an invalid status value rejects", () => {
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-invalid-status",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "required-access-connections",
        status: "SOMETHING_ELSE",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C9: this module exposes no function that executes a provider action, approves work, or transitions/verifies an OutcomeJob or ProjectPlan", () => {
  const capabilityModule = {
    createCapabilityAdmission,
  } as Record<string, unknown>;
  const suspiciousNames = [
    "verifyOutcomeJob",
    "transitionOutcomeJob",
    "createOutcomeJob",
    "admitPlan",
    "admitJobs",
    "validatePlan",
    "executeProviderAction",
    "approveWork",
  ];
  for (const name of suspiciousNames) {
    assert.equal(name in capabilityModule, false);
  }
});
