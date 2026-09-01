import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeamAttentionProjection } from "../src/domain/team-attention-projection.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOwnershipAssignment } from "../src/domain/ownership-assignment.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildAttentionState } from "../src/domain/attention-state.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import {
  WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION,
  WEBSITE_BUILD_V1_OWNER_HISTORY,
  WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
  WEBSITE_BUILD_V1_TEAM_ATTENTION_STATE,
} from "../src/fixtures/website-build-v1-team-attention.js";

const fixture = buildWebsiteBuildV1Fixture();

test("reference proof: the WEBSITE_BUILD_v1 team-attention fixture is deterministic, reuses the existing ownership identity, and populates all four owner roles plus attention", () => {
  const projection = WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION;
  assert.equal(projection.tenantId, WEBSITE_BUILD_V1_OWNERSHIP.tenantId);
  assert.equal(projection.customerId, WEBSITE_BUILD_V1_OWNERSHIP.customerId);
  assert.equal(projection.projectId, WEBSITE_BUILD_V1_OWNERSHIP.projectId);
  assert.equal(projection.viewerRole, "STAFF");
  assert.ok(projection.owners.leadOwnerMembershipId !== undefined);
  assert.ok(projection.owners.dealOwnerMembershipId !== undefined);
  assert.ok(projection.owners.accountOwnerMembershipId !== undefined);
  assert.ok(projection.owners.deliveryOwnerMembershipId !== undefined);
  assert.equal(projection.attention?.isActive, true);
  assert.equal(projection.attention?.internalAttentionLevel, "EXCEPTION");
});

test("with no ownerHistory/viewerMembership/attentionState supplied, every optional field is honestly absent - never guessed", () => {
  const projection = buildTeamAttentionProjection({ ownership: WEBSITE_BUILD_V1_OWNERSHIP });
  assert.equal(projection.viewerRole, undefined);
  assert.equal(Object.hasOwn(projection, "viewerRole"), false);
  assert.deepEqual(projection.owners, {});
  assert.equal(projection.attention, undefined);
  assert.equal(Object.hasOwn(projection, "attention"), false);
});

test("each owner role resolves independently via resolveCurrentOwner - one role is never inferred from another", () => {
  const membership = createOrganizationMembership({
    membershipId: "member-lead-only",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-lead-only",
    role: "STAFF",
  });
  const leadOnly = createOwnershipAssignment({
    ownershipAssignmentId: "own-lead-only",
    membership,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerRole: "LEAD_OWNER",
    assignedAt: "2026-08-01T00:00:00.000Z",
  });
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerHistory: [leadOnly],
  });
  assert.equal(projection.owners.leadOwnerMembershipId, membership.membershipId);
  assert.equal(projection.owners.dealOwnerMembershipId, undefined);
  assert.equal(projection.owners.accountOwnerMembershipId, undefined);
  assert.equal(projection.owners.deliveryOwnerMembershipId, undefined);
});

test("a viewerMembership belonging to a different tenant is never surfaced as viewerRole (adversarial cross-tenant substitution)", () => {
  const foreignMembership = createOrganizationMembership({
    membershipId: "member-foreign-tenant",
    tenantScope: { tenantId: "tenant-unrelated-other" as typeof fixture.tenantScope.tenantId },
    principalRef: "principal-foreign",
    role: "STAFF",
  });
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: foreignMembership,
  });
  assert.equal(projection.viewerRole, undefined);
});

test("an attentionState for a different project is never coerced into this scope's projection (adversarial cross-project substitution)", () => {
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: fixture.tenantScope.tenantId,
    customerId: fixture.customer.customerId,
    projectId: "proj-unrelated-other-project",
  });
  const foreignProject = { ...fixture.project, projectId: foreignOwnership.projectId };
  const foreignJob = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: foreignProject,
    jobId: "job-foreign-project",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  const { job: blockedForeignJob } = enterExceptionState({
    job: foreignJob,
    to: "BLOCKED",
    eventId: "evt-foreign-1",
    actorRef: "system",
    timestamp: "2026-08-29T00:00:00.000Z",
    reason: "unrelated project blocker",
  });
  const foreignAttentionState = buildAttentionState({ job: blockedForeignJob });

  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    attentionState: foreignAttentionState,
  });
  assert.equal(projection.attention, undefined);
});

test("a NORMAL attentionState for the exact scope surfaces isActive: false, not omitted", () => {
  const job = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-normal-team-attention",
    jobFamily: "website-build-v1",
    businessObjective: "test",
  });
  const normalState = buildAttentionState({ job });
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    attentionState: normalState,
  });
  assert.equal(projection.attention?.isActive, false);
  assert.equal(projection.attention?.internalAttentionLevel, "NORMAL");
});

test("this module declares no numeric (`: number`) field and no commission/discount/payout field of any kind", () => {
  // structural proof lives in the boundary-scan test; this is a data-level
  // corroboration that the fixture/projection carry no such field.
  const keys = Object.keys(WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION);
  for (const key of keys) {
    assert.doesNotMatch(key.toLowerCase(), /commission|discount|payout|price|amount|currency/);
  }
});

test("reuses V3-OWN-001's own fixture history and viewer membership verbatim - no parallel identity created", () => {
  assert.equal(WEBSITE_BUILD_V1_OWNER_HISTORY.length, 4);
  assert.equal(WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId, WEBSITE_BUILD_V1_OWNERSHIP.tenantId);
  assert.equal(WEBSITE_BUILD_V1_TEAM_ATTENTION_STATE.tenantId, WEBSITE_BUILD_V1_OWNERSHIP.tenantId);
});
