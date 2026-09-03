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
  WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP_CURRENTNESS,
  WEBSITE_BUILD_V1_TEAM_ATTENTION_STATE,
} from "../src/fixtures/website-build-v1-team-attention.js";
import type { MembershipCurrentnessRecord } from "../src/domain/team-attention-projection.js";

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

test("Rev28 bounded correction (SUPERSEDED by Rev29): the prior structural-only 'OrganizationMembership has no status field, so it cannot be stale' argument is not accepted as proof of currentness - see the Rev29-tagged tests below for the corrected behavior", () => {
  // This test is kept only to document what changed and why: the field
  // set really is closed to these four keys (still true), but the ABSENCE
  // of a status field on the type never proved that a given value is
  // current - it only proved the type permits a stale and a current
  // membership to look byte-identical. Brain handoff Rev29 rejected the
  // old "tenant match alone is enough" behavior for exactly this reason.
  const membershipFieldNames = Object.keys(WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP).sort();
  assert.deepEqual(membershipFieldNames, ["membershipId", "principalRef", "role", "tenantId"]);
});

test("Rev29 bounded correction: viewerRole is emitted only when the viewer's membership is proven current via an authoritative currentness-directory record (not merely tenant-matched)", () => {
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
    viewerMembershipCurrentness: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP_CURRENTNESS,
  });
  assert.equal(projection.viewerRole, WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.role);
});

test("Rev29 bounded correction: unknown/unproven currentness (no currentness directory supplied at all) never emits viewerRole, even for the exact same membership value that IS current when proof is supplied", () => {
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
    // no viewerMembershipCurrentness at all - this is the exact scenario
    // Rev28's structural-proof test wrongly treated as safe.
  });
  assert.equal(projection.viewerRole, undefined);
  assert.equal(Object.hasOwn(projection, "viewerRole"), false);
});

test("Rev29 bounded correction: unknown/unproven currentness (a directory is supplied but has no record for this exact membershipId+tenantId) never emits viewerRole", () => {
  const unrelatedDirectory: ReadonlyArray<MembershipCurrentnessRecord> = [
    {
      membershipId: "member-someone-else" as typeof WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.membershipId,
      tenantId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId,
    },
  ];
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
    viewerMembershipCurrentness: unrelatedDirectory,
  });
  assert.equal(projection.viewerRole, undefined);
});

test("Rev29 bounded correction: a stale/superseded membership record (matching membershipId+tenantId, but carrying supersededAt) never emits viewerRole", () => {
  const staleDirectory: ReadonlyArray<MembershipCurrentnessRecord> = [
    {
      membershipId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.membershipId,
      tenantId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId,
      supersededAt: "2026-08-15T00:00:00.000Z",
    },
  ];
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
    viewerMembershipCurrentness: staleDirectory,
  });
  assert.equal(projection.viewerRole, undefined);
});

test("Rev29 bounded correction: a data-integrity ambiguity (two active/non-superseded records for the same membershipId+tenantId) fails closed to no viewerRole rather than guessing one", () => {
  const ambiguousDirectory: ReadonlyArray<MembershipCurrentnessRecord> = [
    { membershipId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.membershipId, tenantId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId },
    { membershipId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.membershipId, tenantId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId },
  ];
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
    viewerMembershipCurrentness: ambiguousDirectory,
  });
  assert.equal(projection.viewerRole, undefined);
});

test("Rev29 bounded correction: a currentness record for a different tenant than the viewer's own membership never counts as proof (no cross-tenant currentness laundering)", () => {
  const foreignTenantDirectory: ReadonlyArray<MembershipCurrentnessRecord> = [
    {
      membershipId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.membershipId,
      tenantId: "tenant-unrelated-other" as typeof WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId,
    },
  ];
  const projection = buildTeamAttentionProjection({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
    viewerMembershipCurrentness: foreignTenantDirectory,
  });
  assert.equal(projection.viewerRole, undefined);
});
