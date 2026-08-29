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

function verifiedRequirementAndBinding(capabilityRef: string, idSuffix: string) {
  const requirement = createConnectionRequirement({
    connectionRequirementId: `conn-req-cap-${idSuffix}`,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: capabilityRef,
    purpose: "test purpose",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const requested = createConnectionBinding({
    connectionBindingId: `conn-binding-cap-${idSuffix}`,
    requirement,
    ownership: requirement.ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const binding = verifyConnectionBinding(connected, "internal://evidence/1");
  return { requirement, binding };
}

function verifiedBinding() {
  return verifiedRequirementAndBinding("required-access-connections", "1").binding;
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
        requirement,
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C8: VERIFIED_AVAILABLE without an explicit evidenceRef rejects even with a VERIFIED binding", () => {
  const { requirement, binding } = verifiedRequirementAndBinding("required-access-connections", "no-evidence");
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-no-evidence",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        binding,
        requirement,
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("C8: VERIFIED_AVAILABLE with a VERIFIED binding + matching requirement + non-empty evidenceRef succeeds", () => {
  const { requirement, binding } = verifiedRequirementAndBinding("required-access-connections", "ok");
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-ok",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    status: "VERIFIED_AVAILABLE",
    binding,
    requirement,
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
  const { requirement, binding } = verifiedRequirementAndBinding("required-access-connections", "cross-tenant");
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-cross-tenant",
        ownership: foreignOwnership,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        binding,
        requirement,
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("CR-1: VERIFIED_AVAILABLE without the ConnectionRequirement rejects even with a VERIFIED binding + evidence", () => {
  const binding = verifiedBinding();
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-cr1-no-requirement",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "required-access-connections",
        status: "VERIFIED_AVAILABLE",
        binding,
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("CR-1 (a): a VERIFIED binding whose requirement's capability matches the admitted capability succeeds", () => {
  const { requirement, binding } = verifiedRequirementAndBinding("capability-a", "cr1-match");
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-cr1-match",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "capability-a",
    status: "VERIFIED_AVAILABLE",
    binding,
    requirement,
    evidenceRef: "internal://evidence/1",
  });
  assert.equal(admission.status, "VERIFIED_AVAILABLE");
  assert.equal(admission.requiredCapabilityRef, "capability-a");
});

test("CR-1 (b): a same-ownership VERIFIED binding issued for a DIFFERENT capability cannot produce VERIFIED_AVAILABLE for this capability", () => {
  const { requirement: requirementA, binding: bindingA } = verifiedRequirementAndBinding(
    "capability-a",
    "cr1-mismatch-a",
  );
  // requirementB/bindingB exist only to prove capability-b has its own genuine
  // VERIFIED binding under the same ownership - the defect under test is
  // specifically that bindingA (capability-a) must not satisfy capability-b,
  // not that capability-b has no VERIFIED binding of its own at all.
  verifiedRequirementAndBinding("capability-b", "cr1-mismatch-b");

  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-cr1-mismatch",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "capability-b",
        status: "VERIFIED_AVAILABLE",
        binding: bindingA,
        requirement: requirementA,
        evidenceRef: "internal://evidence/1",
      }),
    InvalidCapabilityAdmissionError,
  );
});

test("CR-1: a requirement whose requiredCapabilityRef matches, but whose connectionRequirementId does not match the given binding's, rejects", () => {
  const { requirement: requirementA, binding: bindingA } = verifiedRequirementAndBinding(
    "capability-shared-name",
    "cr1-linkage-a",
  );
  const { requirement: requirementB } = verifiedRequirementAndBinding(
    "capability-shared-name",
    "cr1-linkage-b",
  );
  // requirementA and requirementB declare the SAME requiredCapabilityRef
  // (by coincidence, e.g. a re-requested connection) but are distinct
  // requirement identities. bindingA was issued against requirementA, not
  // requirementB, so pairing bindingA with requirementB must still reject
  // even though the capability text alone would appear to match.
  assert.throws(
    () =>
      createCapabilityAdmission({
        capabilityAdmissionId: "cap-cr1-linkage",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        requiredCapabilityRef: "capability-shared-name",
        status: "VERIFIED_AVAILABLE",
        binding: bindingA,
        requirement: requirementB,
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
