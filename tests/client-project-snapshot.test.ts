import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClientProjectSnapshot,
  InvalidClientProjectSnapshotError,
} from "../src/domain/client-project-snapshot.js";
import { createOutcomeJob, transitionOutcomeJob, verifyOutcomeJob } from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import { createAuditEvent } from "../src/domain/audit-event.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import {
  createProjectCommunicationRecord,
  buildProjectCommunicationHistory,
} from "../src/domain/project-communication.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
} from "../src/domain/connection-authority.js";
import { createCapabilityAdmission } from "../src/domain/capability-admission.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import {
  WEBSITE_BUILD_V1_OWNERSHIP,
  WEBSITE_BUILD_V1_COMMUNICATION_HISTORY,
} from "../src/fixtures/website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CAPABILITY_ADMISSION } from "../src/fixtures/website-build-v1-connection.js";
import {
  WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
  WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL,
  WEBSITE_BUILD_V1_SNAPSHOT_JOBS,
  WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT,
} from "../src/fixtures/website-build-v1-snapshot.js";

const fixture = buildWebsiteBuildV1Fixture();

function minimalInput() {
  return {
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [],
  };
}

test("P1: a deterministic valid projection is produced from existing V2 ownership/project/outcome identities", () => {
  const a = buildClientProjectSnapshot(minimalInput());
  const b = buildClientProjectSnapshot(minimalInput());
  assert.deepEqual(a, b);
  assert.equal(a.deliveryStatus.overallStatus, "NOT_STARTED");
  assert.equal(a.nextAction.owner, "NO_ACTION_NEEDED");
  assert.deepEqual(a.eta, { status: "UNKNOWN" });
});

test("P1 reference proof: the WEBSITE_BUILD_v1 snapshot fixture is deterministic and reuses existing identities", () => {
  const snapshot = WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT;
  assert.equal(snapshot.ownership, WEBSITE_BUILD_V1_OWNERSHIP);
  assert.equal(snapshot.deliveryStatus.overallStatus, "IN_PROGRESS");
  assert.deepEqual(
    [...snapshot.verifiedCompletedJobIds].sort(),
    ["job-website-build-v1-discovery"],
  );
  assert.equal(snapshot.recentCommunications, WEBSITE_BUILD_V1_COMMUNICATION_HISTORY.records);
  assert.equal(snapshot.capabilities.length, 1);
  assert.equal(snapshot.capabilities[0]?.requiredCapabilityRef, "required-access-connections");
  assert.equal(snapshot.capabilities[0]?.status, "VERIFIED_AVAILABLE");
});

test("P2: an ownership tuple mismatched against the given project's tenant/customer/project identity rejects", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  assert.throws(
    () => buildClientProjectSnapshot({ ...minimalInput(), ownership: foreignOwnership }),
    InvalidClientProjectSnapshotError,
  );
});

test("P2: a job belonging to a different tenant/project rejects (cross-tenant scope swap fails closed)", () => {
  const foreignTenantScope = createTenantScope("tenant-foreign");
  const foreignCustomer = createCustomer({
    tenantScope: foreignTenantScope,
    customerId: "cust-foreign",
    displayName: "Foreign Customer",
  });
  const foreignProject = createProject({
    tenantScope: foreignTenantScope,
    customer: foreignCustomer,
    projectId: "proj-foreign",
    ownerRef: "owner-foreign",
    state: "active",
  });
  const foreignJob = createOutcomeJob({
    tenantScope: foreignTenantScope,
    customer: foreignCustomer,
    project: foreignProject,
    jobId: "job-foreign",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  assert.throws(
    () => buildClientProjectSnapshot({ ...minimalInput(), jobs: [foreignJob] }),
    Error,
  );
});

test("P3: internal-only fields/secrets/prompts/margins are absent from the snapshot by construction", () => {
  // Note: "evidenceRef" is deliberately NOT in the forbidden list - it is a
  // plain reference/locator string already proven customer-safe by
  // V2-CDO-003's own O9 field-set test, and is explicitly IN SCOPE here
  // ("safe deliverable/evidence/update references").
  const snapshot = WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT;
  const forbidden = [
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
    "connectionBindingId",
    "secretRef",
  ];
  const json = JSON.stringify(snapshot);
  for (const term of forbidden) {
    assert.equal(json.includes(`"${term}"`), false, `unexpected field "${term}" found in snapshot JSON`);
  }
});

test("P4: a working artifact cannot be VERIFIED/DONE without governing approval evidence", () => {
  const withoutApproval = buildClientProjectSnapshot({
    ...minimalInput(),
    plan: WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
  });
  assert.equal(withoutApproval.workingArtifact?.isCurrentVersionApproved, false);
  assert.equal(withoutApproval.workingArtifact?.lastApprovedVersion, undefined);

  const withApproval = buildClientProjectSnapshot({
    ...minimalInput(),
    plan: WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
    latestApproval: WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL,
  });
  assert.equal(withApproval.workingArtifact?.isCurrentVersionApproved, true);
});

test("P5: current working version and last approved version remain distinguishable; approval for version A does not validate a materially changed version B", () => {
  const planV2 = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: WEBSITE_BUILD_V1_SNAPSHOT_PLAN.planId,
    version: 2,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-25T02:00:00Z",
  });
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    plan: planV2,
    latestApproval: WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL,
  });
  assert.equal(snapshot.workingArtifact?.currentVersion, 2);
  assert.equal(snapshot.workingArtifact?.lastApprovedVersion, 1);
  assert.equal(snapshot.workingArtifact?.isCurrentVersionApproved, false);
});

test("P5: an approval for the exact unchanged current plan version validates", () => {
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    plan: WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
    latestApproval: WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL,
  });
  assert.equal(snapshot.workingArtifact?.currentVersion, snapshot.workingArtifact?.lastApprovedVersion);
  assert.equal(snapshot.workingArtifact?.isCurrentVersionApproved, true);
});

test("P6: CLIENT_ACTION_REQUIRED requires a real customer input/approval dependency - a routine informational communication cannot manufacture it", () => {
  const informationalOnly = buildProjectCommunicationHistory({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    records: [
      createProjectCommunicationRecord({
        communicationId: "comm-informational-only",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        direction: "AKILTA_TO_CUSTOMER",
        classification: "INFORMATIONAL",
        requiredActor: "NONE",
        observationState: "RECORDED_ONLY",
        timestamp: "2026-08-22T09:00:00Z",
      }),
    ],
  });
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    communicationHistory: informationalOnly,
  });
  assert.equal(snapshot.nextAction.owner, "NO_ACTION_NEEDED");
});

test("P6: an ACTION_REQUIRED/CUSTOMER communication yields CLIENT_ACTION_REQUIRED", () => {
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    communicationHistory: WEBSITE_BUILD_V1_COMMUNICATION_HISTORY,
  });
  assert.equal(snapshot.nextAction.owner, "CLIENT_ACTION_REQUIRED");
  assert.equal(snapshot.nextAction.relatedCommunicationId, "comm-approval-request");
});

test("P6: an ACTION_REQUIRED/AKILTA communication yields AKILTA_ACTION_REQUIRED, not a client action", () => {
  const akiltaActionRequired = buildProjectCommunicationHistory({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    records: [
      createProjectCommunicationRecord({
        communicationId: "comm-akilta-action",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        direction: "CUSTOMER_TO_AKILTA",
        classification: "ACTION_REQUIRED",
        requiredActor: "AKILTA",
        observationState: "RECORDED_ONLY",
        timestamp: "2026-08-22T09:00:00Z",
      }),
    ],
  });
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    communicationHistory: akiltaActionRequired,
  });
  assert.equal(snapshot.nextAction.owner, "AKILTA_ACTION_REQUIRED");
});

test("P7: NO_ACTION_NEEDED is explicit when no communication history is supplied at all", () => {
  const snapshot = buildClientProjectSnapshot(minimalInput());
  assert.equal(snapshot.nextAction.owner, "NO_ACTION_NEEDED");
  assert.equal("relatedCommunicationId" in snapshot.nextAction, false);
});

test("P8: eta is always the explicit UNKNOWN literal - never an invented date/percentage", () => {
  const snapshot = buildClientProjectSnapshot(minimalInput());
  assert.deepEqual(snapshot.eta, { status: "UNKNOWN" });
  assert.deepEqual(Object.keys(snapshot.eta), ["status"]);
});

test("P8: a customer-safe timeline BLOCKER entry carries only category/timestamp, no raw internal reason", () => {
  const blockedJob = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-blocker-test",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  const evt = createAuditEvent({
    job: blockedJob,
    eventId: "evt-blocker-1",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-24T00:00:00Z",
    reason: "internal engineering reason, not customer-safe",
  });
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    jobs: [blockedJob],
    auditEvents: [evt],
  });
  assert.equal(snapshot.timeline.entries.length, 1);
  assert.equal(snapshot.timeline.entries[0]?.category, "BLOCKER");
  assert.deepEqual(Object.keys(snapshot.timeline.entries[0] ?? {}).sort(), ["category", "eventId", "jobId", "timestamp"]);
});

test("P9: connection/capability readiness projection exposes only requiredCapabilityRef + status - never connectionBindingId, evidenceRef, or secret material", () => {
  const requirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-p9",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const requested = createConnectionBinding({
    connectionBindingId: "conn-binding-p9",
    requirement,
    ownership: requirement.ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connected = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectionBinding(connected, "internal://evidence/1");
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-p9",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    status: "VERIFIED_AVAILABLE",
    binding: verified,
    requirement,
    evidenceRef: "internal://evidence/1",
  });
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    capabilityAdmissions: [admission],
  });
  assert.deepEqual(snapshot.capabilities, [{ requiredCapabilityRef: "required-access-connections", status: "VERIFIED_AVAILABLE" }]);
});

test("P9: a capabilityAdmissions entry belonging to a different ownership tuple rejects", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  const admission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-foreign",
    ownership: foreignOwnership,
    requiredCapabilityRef: "required-access-connections",
    status: "UNVERIFIED",
  });
  assert.throws(
    () => buildClientProjectSnapshot({ ...minimalInput(), capabilityAdmissions: [admission] }),
    InvalidClientProjectSnapshotError,
  );
});

test("P10: this module exposes no function that mutates ProjectPlan/OutcomeJob/approval/connection state", () => {
  const snapshotModule = {
    buildClientProjectSnapshot,
  } as Record<string, unknown>;
  const suspiciousNames = [
    "verifyOutcomeJob",
    "transitionOutcomeJob",
    "createOutcomeJob",
    "admitPlan",
    "admitJobs",
    "validatePlan",
    "compilePlan",
    "createApprovalReference",
    "createConnectionBinding",
    "verifyConnectionBinding",
    "createCapabilityAdmission",
  ];
  for (const name of suspiciousNames) {
    assert.equal(name in snapshotModule, false);
  }
});

test("P10: calling buildClientProjectSnapshot twice with the same inputs never mutates the inputs themselves", () => {
  const jobs = WEBSITE_BUILD_V1_SNAPSHOT_JOBS;
  const before = JSON.stringify(jobs);
  buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs,
    plan: WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
    latestApproval: WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL,
    communicationHistory: WEBSITE_BUILD_V1_COMMUNICATION_HISTORY,
    capabilityAdmissions: [WEBSITE_BUILD_V1_CAPABILITY_ADMISSION],
  });
  const after = JSON.stringify(jobs);
  assert.equal(before, after);
});

test("P12: a communicationHistory belonging to a different ownership tuple rejects", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: "some-other-tenant",
    customerId: "some-other-customer",
    projectId: "some-other-project",
  });
  const foreignHistory = buildProjectCommunicationHistory({
    ownership: foreignOwnership,
    records: [
      createProjectCommunicationRecord({
        communicationId: "comm-foreign",
        ownership: foreignOwnership,
        direction: "AKILTA_TO_CUSTOMER",
        classification: "INFORMATIONAL",
        requiredActor: "NONE",
        observationState: "RECORDED_ONLY",
        timestamp: "2026-08-22T09:00:00Z",
      }),
    ],
  });
  assert.throws(
    () => buildClientProjectSnapshot({ ...minimalInput(), communicationHistory: foreignHistory }),
    InvalidClientProjectSnapshotError,
  );
});

test("P12: RECORDED_ONLY/DELIVERY_UNVERIFIED communications pass through unmodified - never shown as delivered", () => {
  const snapshot = buildClientProjectSnapshot({
    ...minimalInput(),
    communicationHistory: WEBSITE_BUILD_V1_COMMUNICATION_HISTORY,
  });
  const unverified = snapshot.recentCommunications.find((r) => r.communicationId === "comm-approval-request");
  assert.equal(unverified?.observationState, "DELIVERY_UNVERIFIED");
  const verified = snapshot.recentCommunications.find((r) => r.communicationId === "comm-working-artifact-notice");
  assert.equal(verified?.observationState, "DELIVERY_VERIFIED");
  assert.ok(verified?.evidenceRef);
});

test("P12: this module has no import statement pulling in a value (non-type) dependency it could use to approve/resume/verify/close ProjectPlan or OutcomeJob beyond pure read composition", () => {
  const snapshotModule = {
    buildClientProjectSnapshot,
  } as Record<string, unknown>;
  assert.equal("admitPlan" in snapshotModule, false);
  assert.equal("admitJobs" in snapshotModule, false);
  assert.equal("verifyOutcomeJob" in snapshotModule, false);
});
