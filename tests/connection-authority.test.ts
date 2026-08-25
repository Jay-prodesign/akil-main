import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSecretRef,
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  InvalidConnectionAuthorityError,
  InvalidConnectionTransitionError,
  type ConnectionRequirement,
} from "../src/domain/connection-authority.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import {
  WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT,
  WEBSITE_BUILD_V1_CONNECTION_BINDING,
} from "../src/fixtures/website-build-v1-connection.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";

function minimalRequirementInput() {
  return {
    connectionRequirementId: "conn-req-1",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    purpose: "test purpose",
    accountOwner: "CUSTOMER_OWNED" as const,
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  };
}

function minimalRequirement(): ConnectionRequirement {
  return createConnectionRequirement(minimalRequirementInput());
}

function minimalBindingInput(requirement: ConnectionRequirement) {
  return {
    connectionBindingId: "conn-binding-1",
    requirement,
    ownership: requirement.ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  };
}

test("C1: a valid minimal ConnectionRequirement + ConnectionBinding is deterministic and reuses the existing V2-CDO-003 ownership identity", () => {
  const a = createConnectionRequirement(minimalRequirementInput());
  const b = createConnectionRequirement(minimalRequirementInput());
  assert.deepEqual(a, b);
  assert.equal(a.ownership, WEBSITE_BUILD_V1_OWNERSHIP);

  const bindingA = createConnectionBinding(minimalBindingInput(a));
  const bindingB = createConnectionBinding(minimalBindingInput(b));
  assert.deepEqual(bindingA, bindingB);
});

test("C1 reference proof: the WEBSITE_BUILD_v1 connection fixture reuses required-access-connections and is VERIFIED", () => {
  assert.equal(WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT.requiredCapabilityRef, "required-access-connections");
  assert.equal(WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT.ownership, WEBSITE_BUILD_V1_OWNERSHIP);
  assert.equal(WEBSITE_BUILD_V1_CONNECTION_BINDING.connectionState, "VERIFIED");
});

test("C2: missing/empty connectionRequirementId rejects", () => {
  const input = { ...minimalRequirementInput(), connectionRequirementId: "" };
  assert.throws(() => createConnectionRequirement(input), InvalidConnectionAuthorityError);
});

test("C2: missing/empty requiredCapabilityRef rejects", () => {
  const input = { ...minimalRequirementInput(), requiredCapabilityRef: "" };
  assert.throws(() => createConnectionRequirement(input), InvalidConnectionAuthorityError);
});

test("C2: missing/empty providerRef/workspaceRef/integrationInstanceRef on a binding rejects", () => {
  const requirement = minimalRequirement();
  assert.throws(
    () => createConnectionBinding({ ...minimalBindingInput(requirement), providerRef: "" }),
    InvalidConnectionAuthorityError,
  );
  assert.throws(
    () => createConnectionBinding({ ...minimalBindingInput(requirement), workspaceRef: "" }),
    InvalidConnectionAuthorityError,
  );
  assert.throws(
    () => createConnectionBinding({ ...minimalBindingInput(requirement), integrationInstanceRef: "" }),
    InvalidConnectionAuthorityError,
  );
});

test("C2: empty secretRefId rejects", () => {
  assert.throws(() => createSecretRef({ secretRefId: "" }), InvalidConnectionAuthorityError);
});

test("C3: omitted accountOwner rejects and no default is inferred", () => {
  const input = { ...minimalRequirementInput() } as Record<string, unknown>;
  delete input["accountOwner"];
  assert.throws(() => createConnectionRequirement(input as never), InvalidConnectionAuthorityError);
});

test("C3: invalid accountOwner value rejects", () => {
  const input = { ...minimalRequirementInput(), accountOwner: "SOMEONE_ELSE" as unknown as "CUSTOMER_OWNED" };
  assert.throws(() => createConnectionRequirement(input), InvalidConnectionAuthorityError);
});

test("C3: accountOwner accepts CUSTOMER_OWNED and AKILTA_MANAGED explicitly", () => {
  const customerOwned = createConnectionRequirement({ ...minimalRequirementInput(), accountOwner: "CUSTOMER_OWNED" });
  const akiltaManaged = createConnectionRequirement({
    ...minimalRequirementInput(),
    connectionRequirementId: "conn-req-2",
    accountOwner: "AKILTA_MANAGED",
  });
  assert.equal(customerOwned.accountOwner, "CUSTOMER_OWNED");
  assert.equal(akiltaManaged.accountOwner, "AKILTA_MANAGED");
});

test("C4: a binding cannot rebind a requirement to a different tenant's ownership tuple", () => {
  const requirement = minimalRequirement();
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  assert.throws(
    () => createConnectionBinding({ ...minimalBindingInput(requirement), ownership: foreignOwnership }),
    InvalidConnectionAuthorityError,
  );
});

test("C4: a binding cannot rebind a requirement to a different project within the same tenant", () => {
  const requirement = minimalRequirement();
  const sameTenantDifferentProject = createProjectOwnershipRef({
    tenantId: requirement.ownership.tenantId,
    customerId: requirement.ownership.customerId,
    projectId: "some-other-project",
  });
  assert.throws(
    () =>
      createConnectionBinding({ ...minimalBindingInput(requirement), ownership: sameTenantDifferentProject }),
    InvalidConnectionAuthorityError,
  );
});

test("C5: empty delegatedScope rejects when the requirement declares a non-empty minimumProviderScope", () => {
  const requirement = minimalRequirement();
  assert.throws(
    () => createConnectionBinding({ ...minimalBindingInput(requirement), delegatedScope: [] }),
    InvalidConnectionAuthorityError,
  );
});

test("C5: delegatedScope widening beyond minimumProviderScope rejects (silent authority widening)", () => {
  const requirement = minimalRequirement();
  assert.throws(
    () =>
      createConnectionBinding({
        ...minimalBindingInput(requirement),
        delegatedScope: ["catalog:read", "orders:write"],
      }),
    InvalidConnectionAuthorityError,
  );
});

test("C5: delegatedScope that is a subset of minimumProviderScope is accepted (least-privilege narrowing)", () => {
  const requirement = createConnectionRequirement({
    ...minimalRequirementInput(),
    minimumProviderScope: ["catalog:read", "orders:read"],
  });
  const binding = createConnectionBinding({
    ...minimalBindingInput(requirement),
    delegatedScope: ["catalog:read"],
  });
  assert.deepEqual(binding.delegatedScope, ["catalog:read"]);
});

test("C5: an empty minimumProviderScope on the requirement permits an empty delegatedScope", () => {
  const requirement = createConnectionRequirement({ ...minimalRequirementInput(), minimumProviderScope: [] });
  const binding = createConnectionBinding({ ...minimalBindingInput(requirement), delegatedScope: [] });
  assert.deepEqual(binding.delegatedScope, []);
});

test("C6: construction alone never produces a VERIFIED binding - it always starts REQUESTED", () => {
  const requirement = minimalRequirement();
  const binding = createConnectionBinding(minimalBindingInput(requirement));
  assert.equal(binding.connectionState, "REQUESTED");
});

test("C6: verifyConnectionBinding rejects from REQUESTED (must pass through CONNECTED_UNVERIFIED first)", () => {
  const requirement = minimalRequirement();
  const binding = createConnectionBinding(minimalBindingInput(requirement));
  assert.throws(
    () => verifyConnectionBinding(binding, "internal://evidence/1"),
    InvalidConnectionTransitionError,
  );
});

test("C6: verifyConnectionBinding rejects without a non-empty evidenceRef", () => {
  const requirement = minimalRequirement();
  const requested = createConnectionBinding(minimalBindingInput(requirement));
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  assert.throws(() => verifyConnectionBinding(connected, undefined), InvalidConnectionAuthorityError);
  assert.throws(() => verifyConnectionBinding(connected, ""), InvalidConnectionAuthorityError);
});

test("C6: verifyConnectionBinding succeeds from CONNECTED_UNVERIFIED with a non-empty evidenceRef", () => {
  const requirement = minimalRequirement();
  const requested = createConnectionBinding(minimalBindingInput(requirement));
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectionBinding(connected, "internal://evidence/1");
  assert.equal(verified.connectionState, "VERIFIED");
  assert.equal(verified.verificationEvidenceRef, "internal://evidence/1");
});

test("C6: verifyConnectionBinding also succeeds from DEGRADED (re-verification)", () => {
  const requirement = minimalRequirement();
  const requested = createConnectionBinding(minimalBindingInput(requirement));
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const verifiedOnce = verifyConnectionBinding(connected, "internal://evidence/1");
  const degraded = transitionConnectionBinding(verifiedOnce, "DEGRADED");
  const reverified = verifyConnectionBinding(degraded, "internal://evidence/2");
  assert.equal(reverified.connectionState, "VERIFIED");
});

test("C6: transitionConnectionBinding never accepts VERIFIED as a target from any state", () => {
  const requirement = minimalRequirement();
  const requested = createConnectionBinding(minimalBindingInput(requirement));
  assert.throws(
    () => transitionConnectionBinding(requested, "VERIFIED" as never),
    InvalidConnectionTransitionError,
  );
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  assert.throws(
    () => transitionConnectionBinding(connected, "VERIFIED" as never),
    InvalidConnectionTransitionError,
  );
});

test("C7: SecretRef only carries an opaque id field - no secret/credential payload field exists on the type", () => {
  const ref = createSecretRef({ secretRefId: "secret-ref-1" });
  assert.deepEqual(Object.keys(ref), ["secretRefId"]);
});

test("C7: a ConnectionBinding's secretRef field, when present, is only the opaque SecretRef id string", () => {
  const requirement = minimalRequirement();
  const secretRef = createSecretRef({ secretRefId: "secret-ref-1" });
  const binding = createConnectionBinding({ ...minimalBindingInput(requirement), secretRef });
  assert.equal(binding.secretRef, "secret-ref-1");
});

test("C10: REVOKED and HANDOVER_COMPLETE are reachable state transitions with no other field mutated", () => {
  const requirement = minimalRequirement();
  const requested = createConnectionBinding(minimalBindingInput(requirement));
  const revoked = transitionConnectionBinding(requested, "REVOKED");
  assert.equal(revoked.connectionState, "REVOKED");
  assert.equal(revoked.providerRef, requested.providerRef);
  assert.equal(revoked.ownership, requested.ownership);

  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectionBinding(connected, "internal://evidence/1");
  const handedOver = transitionConnectionBinding(verified, "HANDOVER_COMPLETE");
  assert.equal(handedOver.connectionState, "HANDOVER_COMPLETE");
});

test("C10: REVOKED is terminal - no further transition is accepted", () => {
  const requirement = minimalRequirement();
  const requested = createConnectionBinding(minimalBindingInput(requirement));
  const revoked = transitionConnectionBinding(requested, "REVOKED");
  assert.throws(
    () => transitionConnectionBinding(revoked, "CONNECTED_UNVERIFIED"),
    InvalidConnectionTransitionError,
  );
});
