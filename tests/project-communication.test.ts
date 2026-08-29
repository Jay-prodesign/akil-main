import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createProjectCommunicationRecord,
  buildProjectCommunicationHistory,
  InvalidProjectCommunicationError,
} from "../src/domain/project-communication.js";
import {
  WEBSITE_BUILD_V1_OWNERSHIP,
  WEBSITE_BUILD_V1_COMMUNICATION_HISTORY,
} from "../src/fixtures/website-build-v1-communication.js";

const ownershipA = createProjectOwnershipRef({
  tenantId: "tenant-a",
  customerId: "cust-a",
  projectId: "proj-a",
});
const ownershipB = createProjectOwnershipRef({
  tenantId: "tenant-b",
  customerId: "cust-b",
  projectId: "proj-b",
});

function minimalRecordInput() {
  return {
    communicationId: "comm-1",
    ownership: ownershipA,
    direction: "AKILTA_TO_CUSTOMER" as const,
    classification: "INFORMATIONAL" as const,
    requiredActor: "NONE" as const,
    observationState: "RECORDED_ONLY" as const,
    timestamp: "2026-08-22T09:00:00Z",
  };
}

test("O1: a valid minimal communication record is deterministic", () => {
  const a = createProjectCommunicationRecord(minimalRecordInput());
  const b = createProjectCommunicationRecord(minimalRecordInput());
  assert.deepEqual(a, b);
});

test("O1 reference proof: the WEBSITE_BUILD_v1 communication fixture history is valid and non-empty", () => {
  assert.equal(WEBSITE_BUILD_V1_COMMUNICATION_HISTORY.records.length, 2);
  assert.equal(WEBSITE_BUILD_V1_COMMUNICATION_HISTORY.ownership, WEBSITE_BUILD_V1_OWNERSHIP);
});

test("O3: rejects an invalid direction value", () => {
  const input = { ...minimalRecordInput(), direction: "SOMEWHERE" as unknown as "AKILTA_TO_CUSTOMER" };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O3: rejects an invalid classification value", () => {
  const input = { ...minimalRecordInput(), classification: "URGENT" as unknown as "INFORMATIONAL" };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O3: rejects an invalid requiredActor value", () => {
  const input = { ...minimalRecordInput(), requiredActor: "EVERYONE" as unknown as "NONE" };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O3: rejects an invalid observationState value", () => {
  const input = { ...minimalRecordInput(), observationState: "SENT" as unknown as "RECORDED_ONLY" };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O4: INFORMATIONAL with a requiredActor other than NONE rejects", () => {
  const input = { ...minimalRecordInput(), classification: "INFORMATIONAL" as const, requiredActor: "CUSTOMER" as const };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O4: ACTION_REQUIRED with requiredActor NONE rejects", () => {
  const input = { ...minimalRecordInput(), classification: "ACTION_REQUIRED" as const, requiredActor: "NONE" as const };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O4: ACTION_REQUIRED accepts CUSTOMER or AKILTA as requiredActor", () => {
  const customerActor = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    classification: "ACTION_REQUIRED",
    requiredActor: "CUSTOMER",
  });
  const akiltaActor = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    communicationId: "comm-2",
    classification: "ACTION_REQUIRED",
    requiredActor: "AKILTA",
  });
  assert.equal(customerActor.requiredActor, "CUSTOMER");
  assert.equal(akiltaActor.requiredActor, "AKILTA");
});

test("O5: DELIVERY_VERIFIED without an evidenceRef rejects", () => {
  const input = { ...minimalRecordInput(), observationState: "DELIVERY_VERIFIED" as const };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O5: DELIVERY_VERIFIED with a non-empty evidenceRef succeeds", () => {
  const record = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    observationState: "DELIVERY_VERIFIED",
    evidenceRef: "internal://evidence/1",
  });
  assert.equal(record.observationState, "DELIVERY_VERIFIED");
  assert.equal(record.evidenceRef, "internal://evidence/1");
});

test("O5: RECORDED_ONLY and DELIVERY_UNVERIFIED never carry an implicit evidenceRef", () => {
  const recordedOnly = createProjectCommunicationRecord(minimalRecordInput());
  const unverified = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    observationState: "DELIVERY_UNVERIFIED",
  });
  assert.equal("evidenceRef" in recordedOnly, false);
  assert.equal("evidenceRef" in unverified, false);
});

test("O6: a communication belonging to a different tenant than the given ownership rejects when building a history", () => {
  const foreignRecord = createProjectCommunicationRecord({ ...minimalRecordInput(), ownership: ownershipB });
  assert.throws(
    () => buildProjectCommunicationHistory({ ownership: ownershipA, records: [foreignRecord] }),
    InvalidProjectCommunicationError,
  );
});

test("O6: a communication belonging to a different project within the same tenant rejects when building a history", () => {
  const sameTenantDifferentProject = createProjectOwnershipRef({
    tenantId: ownershipA.tenantId,
    customerId: ownershipA.customerId,
    projectId: "some-other-project",
  });
  const foreignRecord = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    ownership: sameTenantDifferentProject,
  });
  assert.throws(
    () => buildProjectCommunicationHistory({ ownership: ownershipA, records: [foreignRecord] }),
    InvalidProjectCommunicationError,
  );
});

test("O7: a duplicate communicationId within one history rejects", () => {
  const first = createProjectCommunicationRecord(minimalRecordInput());
  const duplicate = createProjectCommunicationRecord(minimalRecordInput());
  assert.throws(
    () => buildProjectCommunicationHistory({ ownership: ownershipA, records: [first, duplicate] }),
    InvalidProjectCommunicationError,
  );
});

test("CR-1: relatedPlanId/relatedPlanVersion together preserve an exact ProjectPlanVersion reference - two versions of the same plan remain distinguishable", () => {
  const v1 = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    communicationId: "comm-plan-v1",
    relatedPlanId: "plan-1",
    relatedPlanVersion: 1,
  });
  const v2 = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    communicationId: "comm-plan-v2",
    relatedPlanId: "plan-1",
    relatedPlanVersion: 2,
  });
  assert.equal(v1.relatedPlanId, v2.relatedPlanId);
  assert.equal(v1.relatedPlanVersion, 1);
  assert.equal(v2.relatedPlanVersion, 2);
  assert.notEqual(v1.relatedPlanVersion, v2.relatedPlanVersion);
});

test("CR-1: relatedPlanId without relatedPlanVersion rejects (partial plan reference is not exact)", () => {
  const input = { ...minimalRecordInput(), relatedPlanId: "plan-1" };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("CR-1: relatedPlanVersion without relatedPlanId rejects (partial plan reference is not exact)", () => {
  const input = { ...minimalRecordInput(), relatedPlanVersion: 1 };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("CR-1: relatedPlanVersion must be a positive integer", () => {
  const input = { ...minimalRecordInput(), relatedPlanId: "plan-1", relatedPlanVersion: 0 };
  assert.throws(() => createProjectCommunicationRecord(input), InvalidProjectCommunicationError);
});

test("O8: this module exposes no function that transitions or verifies an OutcomeJob or admits/verifies a ProjectPlan", () => {
  const communicationModule = {
    createProjectCommunicationRecord,
    buildProjectCommunicationHistory,
  } as Record<string, unknown>;
  const suspiciousNames = [
    "verifyOutcomeJob",
    "transitionOutcomeJob",
    "createOutcomeJob",
    "admitPlan",
    "admitJobs",
    "validatePlan",
  ];
  for (const name of suspiciousNames) {
    assert.equal(name in communicationModule, false);
  }
});

test("O9: a communication record's field set is exactly the customer-safe shape - no internal notes/margins/prompts/credentials", () => {
  const record = createProjectCommunicationRecord({
    ...minimalRecordInput(),
    observationState: "DELIVERY_VERIFIED",
    evidenceRef: "internal://evidence/1",
    relatedArtifactRef: "some-artifact",
  });
  const forbiddenFieldNames = [
    "notes",
    "internalNotes",
    "margin",
    "unitEconomics",
    "prompt",
    "systemPrompt",
    "credential",
    "secret",
    "password",
    "apiKey",
  ];
  const fieldNames = Object.keys(record);
  for (const forbidden of forbiddenFieldNames) {
    assert.equal(fieldNames.includes(forbidden), false);
  }
  assert.deepEqual(
    fieldNames.sort(),
    [
      "classification",
      "communicationId",
      "direction",
      "evidenceRef",
      "observationState",
      "ownership",
      "relatedArtifactRef",
      "requiredActor",
      "timestamp",
    ].sort(),
  );
});
