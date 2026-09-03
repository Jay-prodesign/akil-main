import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommercialAuthoritySnapshot } from "../src/domain/commercial-authority.js";
import { createOwnershipAssignment } from "../src/domain/ownership-assignment.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_COMMERCIAL_AUTHORITY_SNAPSHOT } from "../src/fixtures/website-build-v1-commercial-authority.js";

const fixture = buildWebsiteBuildV1Fixture();

test("reference proof: the WEBSITE_BUILD_v1 commercial-authority fixture is deterministic and reuses the existing ownership identity", () => {
  assert.equal(WEBSITE_BUILD_V1_COMMERCIAL_AUTHORITY_SNAPSHOT.tenantId, WEBSITE_BUILD_V1_OWNERSHIP.tenantId);
  assert.equal(WEBSITE_BUILD_V1_COMMERCIAL_AUTHORITY_SNAPSHOT.customerId, WEBSITE_BUILD_V1_OWNERSHIP.customerId);
  assert.equal(WEBSITE_BUILD_V1_COMMERCIAL_AUTHORITY_SNAPSHOT.projectId, WEBSITE_BUILD_V1_OWNERSHIP.projectId);
});

test("commissionLedgerStatus is always UNKNOWN - there is no real commission/billing/settlement system in this repository", () => {
  const snapshot = buildCommercialAuthoritySnapshot({ ownership: WEBSITE_BUILD_V1_OWNERSHIP });
  assert.equal(snapshot.commissionLedgerStatus, "UNKNOWN");
});

test("discountAuthorityLevel is always APPROVAL_REQUIRED - no authoritative DEC-146 pricing-policy source is integrated in this repository", () => {
  const snapshot = buildCommercialAuthoritySnapshot({ ownership: WEBSITE_BUILD_V1_OWNERSHIP });
  assert.equal(snapshot.discountAuthorityLevel, "APPROVAL_REQUIRED");
});

test("with no dealOwnerHistory supplied, dealOwnerMembershipId is absent (not guessed)", () => {
  const snapshot = buildCommercialAuthoritySnapshot({ ownership: WEBSITE_BUILD_V1_OWNERSHIP });
  assert.equal(snapshot.dealOwnerMembershipId, undefined);
  assert.equal(Object.hasOwn(snapshot, "dealOwnerMembershipId"), false);
});

test("with a real active DEAL_OWNER assignment for the exact ownership scope, dealOwnerMembershipId resolves to it", () => {
  const membership = createOrganizationMembership({
    membershipId: "member-deal-owner-1",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-deal-owner-1",
    role: "STAFF",
  });
  const assignment = createOwnershipAssignment({
    ownershipAssignmentId: "own-deal-1",
    membership,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerRole: "DEAL_OWNER",
    assignedAt: "2026-08-01T00:00:00.000Z",
  });
  const snapshot = buildCommercialAuthoritySnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    dealOwnerHistory: [assignment],
  });
  assert.equal(snapshot.dealOwnerMembershipId, membership.membershipId);
});

test("a DEAL_OWNER assignment for a different project (adversarial cross-project substitution) is never surfaced as this project's deal owner", () => {
  const membership = createOrganizationMembership({
    membershipId: "member-deal-owner-2",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-deal-owner-2",
    role: "STAFF",
  });
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: fixture.tenantScope.tenantId,
    customerId: fixture.customer.customerId,
    projectId: "proj-unrelated-other-project",
  });
  const assignment = createOwnershipAssignment({
    ownershipAssignmentId: "own-deal-2",
    membership,
    ownership: foreignOwnership,
    ownerRole: "DEAL_OWNER",
    assignedAt: "2026-08-01T00:00:00.000Z",
  });
  const snapshot = buildCommercialAuthoritySnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    dealOwnerHistory: [assignment],
  });
  assert.equal(snapshot.dealOwnerMembershipId, undefined);
});

test("an assignment with a different owner role (e.g. LEAD_OWNER, not DEAL_OWNER) is never surfaced as dealOwnerMembershipId", () => {
  const membership = createOrganizationMembership({
    membershipId: "member-lead-owner-1",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-lead-owner-1",
    role: "STAFF",
  });
  const assignment = createOwnershipAssignment({
    ownershipAssignmentId: "own-lead-1",
    membership,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerRole: "LEAD_OWNER",
    assignedAt: "2026-08-01T00:00:00.000Z",
  });
  const snapshot = buildCommercialAuthoritySnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    dealOwnerHistory: [assignment],
  });
  assert.equal(snapshot.dealOwnerMembershipId, undefined);
});

test("a superseded (stale) DEAL_OWNER assignment is never surfaced as the current deal owner", () => {
  const membershipOld = createOrganizationMembership({
    membershipId: "member-deal-owner-old",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-deal-owner-old",
    role: "STAFF",
  });
  const membershipNew = createOrganizationMembership({
    membershipId: "member-deal-owner-new",
    tenantScope: fixture.tenantScope,
    principalRef: "principal-deal-owner-new",
    role: "STAFF",
  });
  const original = createOwnershipAssignment({
    ownershipAssignmentId: "own-deal-old",
    membership: membershipOld,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerRole: "DEAL_OWNER",
    assignedAt: "2026-07-01T00:00:00.000Z",
  });
  const next = createOwnershipAssignment({
    ownershipAssignmentId: "own-deal-new",
    membership: membershipNew,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerRole: "DEAL_OWNER",
    assignedAt: "2026-08-01T00:00:00.000Z",
  });
  const superseded = {
    ...original,
    supersededAt: "2026-08-01T00:00:00.000Z",
    supersededByAssignmentId: next.ownershipAssignmentId,
  };
  const snapshot = buildCommercialAuthoritySnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    dealOwnerHistory: [superseded, next],
  });
  assert.equal(snapshot.dealOwnerMembershipId, membershipNew.membershipId);
});
