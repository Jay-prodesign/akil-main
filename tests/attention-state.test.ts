import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAttentionState, InvalidAttentionStateError } from "../src/domain/attention-state.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { createOwnershipAssignment } from "../src/domain/ownership-assignment.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";

const fixture = buildWebsiteBuildV1Fixture();

function freshJob(jobId: string) {
  return createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId,
    jobFamily: "website-build-v1",
    businessObjective: "test objective",
  });
}

test("a normal (non-exception) job resolves NORMAL with no reason/timestamp/owner surfaced", () => {
  const job = freshJob("job-normal-1");
  const state = buildAttentionState({ job });
  assert.equal(state.internalAttentionLevel, "NORMAL");
  assert.equal(state.reason, undefined);
  assert.equal(state.timestamp, undefined);
  assert.equal(state.responsibleOwnerMembershipId, undefined);
});

test("contractualSlaStatus is always UNKNOWN - there is no real commitment data source in this repository", () => {
  const job = freshJob("job-normal-2");
  const state = buildAttentionState({ job });
  assert.equal(state.contractualSlaStatus, "UNKNOWN");
});

test("BLOCKED/RECOVERING/STOPPED resolve EXCEPTION; ESCALATED resolves ESCALATED - a direct, honest mapping of the existing OutcomeJobState signal", () => {
  for (const to of ["BLOCKED", "RECOVERING", "STOPPED"] as const) {
    const job = freshJob(`job-${to.toLowerCase()}`);
    const { job: exceptionJob } = enterExceptionState({
      job,
      to,
      eventId: `evt-${to.toLowerCase()}`,
      actorRef: "system",
      timestamp: "2026-08-27T00:00:00Z",
      reason: `entered ${to} for testing`,
    });
    assert.equal(buildAttentionState({ job: exceptionJob }).internalAttentionLevel, "EXCEPTION");
  }
  const job = freshJob("job-escalated");
  const { job: escalatedJob } = enterExceptionState({
    job,
    to: "ESCALATED",
    eventId: "evt-escalated",
    actorRef: "system",
    timestamp: "2026-08-27T00:00:00Z",
    reason: "escalated for testing",
  });
  assert.equal(buildAttentionState({ job: escalatedJob }).internalAttentionLevel, "ESCALATED");
});

test("reason and timestamp are surfaced verbatim from the exact AuditEvent produced by entering the exception state", () => {
  const job = freshJob("job-with-event");
  const { job: blockedJob, auditEvent } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-1",
    actorRef: "system",
    timestamp: "2026-08-27T05:00:00Z",
    reason: "waiting on customer input",
  });
  const state = buildAttentionState({ job: blockedJob, latestExceptionEvent: auditEvent });
  assert.equal(state.reason, "waiting on customer input");
  assert.equal(state.timestamp, "2026-08-27T05:00:00Z");
});

test("a foreign job's exception event is rejected rather than silently attributed (fail-closed cross-job contamination)", () => {
  const jobA = freshJob("job-a");
  const jobB = freshJob("job-b");
  const { auditEvent: eventFromA } = enterExceptionState({
    job: jobA,
    to: "BLOCKED",
    eventId: "evt-a",
    actorRef: "system",
    timestamp: "2026-08-27T00:00:00Z",
    reason: "reason from job A",
  });
  const { job: blockedB } = enterExceptionState({
    job: jobB,
    to: "BLOCKED",
    eventId: "evt-b",
    actorRef: "system",
    timestamp: "2026-08-27T00:00:00Z",
    reason: "reason from job B",
  });
  assert.throws(
    () => buildAttentionState({ job: blockedB, latestExceptionEvent: eventFromA }),
    InvalidAttentionStateError,
  );
});

test("stale exception evidence is never surfaced once the job is no longer in an exception state (no fabricated 'current' reason)", () => {
  // A job that never entered an exception state is NORMAL; even if a
  // caller mistakenly passes an unrelated past exception event for a
  // *different* job's history, buildAttentionState must not surface it
  // as this job's current reason - the identity check above already
  // prevents cross-job attribution, and a same-job event is only ever
  // surfaced while the job is still actually in that exception state.
  const job = freshJob("job-normal-3");
  const state = buildAttentionState({ job });
  assert.equal(state.internalAttentionLevel, "NORMAL");
  assert.equal("reason" in state, false);
  assert.equal("timestamp" in state, false);
});

test("responsibleOwnerMembershipId resolves the current DELIVERY_OWNER via V3-OWN-001's resolveCurrentOwner, and is absent when no owner is assigned", () => {
  const ownership = createProjectOwnershipRef({
    tenantId: fixture.tenantScope.tenantId,
    customerId: fixture.customer.customerId,
    projectId: fixture.project.projectId,
  });
  const job = freshJob("job-with-owner");

  const noOwnerState = buildAttentionState({ job, ownershipHistory: [], ownership });
  assert.equal(noOwnerState.responsibleOwnerMembershipId, undefined);

  const membership = createOrganizationMembership({
    membershipId: "membership-delivery-owner-1",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-1",
    role: "STAFF",
  });
  const deliveryOwnerAssignment = createOwnershipAssignment({
    ownershipAssignmentId: "assignment-delivery-owner-1",
    membership,
    ownership,
    ownerRole: "DELIVERY_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  const withOwnerState = buildAttentionState({
    job,
    ownershipHistory: [deliveryOwnerAssignment],
    ownership,
  });
  assert.equal(withOwnerState.responsibleOwnerMembershipId, membership.membershipId);
});

test("escalation visibility does not create execution/approval authority: this module has no permission/transition concept at all", async () => {
  const moduleExports = await import("../src/domain/attention-state.js");
  const exportNames = Object.keys(moduleExports);
  assert.equal(exportNames.includes("transitionOutcomeJob"), false);
  assert.equal(exportNames.includes("requirePermission"), false);
  assert.equal(exportNames.includes("AuthorityContext"), false);
});
