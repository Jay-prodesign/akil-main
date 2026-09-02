import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import { buildWebsiteBuildV1Fixture } from "./website-build-v1.js";
import { createOrganizationMembership, type OrganizationMembership } from "../domain/organization-membership.js";
import { createOwnershipAssignment, type OwnershipAssignment } from "../domain/ownership-assignment.js";
import { createOutcomeJob, enterExceptionState } from "../domain/outcome-job.js";
import { buildAttentionState, type AttentionState } from "../domain/attention-state.js";
import {
  buildTeamAttentionProjection,
  type TeamAttentionProjection,
  type MembershipCurrentnessRecord,
} from "../domain/team-attention-projection.js";

const fixture = buildWebsiteBuildV1Fixture();

/**
 * One canonical WEBSITE_BUILD_v1 team-attention fixture, reusing the
 * existing `WEBSITE_BUILD_V1_OWNERSHIP` tuple verbatim (V2-CDO-003) - no
 * parallel ownership identity created for this slice. All four owner
 * roles are populated with distinct memberships (V3-ORG-001/V3-OWN-001)
 * and the project is placed into a real `BLOCKED` exception state
 * (V3-SLA-001) so the reference fixture exercises every field this
 * projection can produce, not just the empty/absent branches.
 */
export const WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP: OrganizationMembership = createOrganizationMembership({
  membershipId: "member-team-attention-viewer",
  tenantScope: fixture.tenantScope,
  principalRef: "principal-team-attention-viewer",
  role: "STAFF",
});

function ownerAssignment(role: "LEAD_OWNER" | "DEAL_OWNER" | "ACCOUNT_OWNER" | "DELIVERY_OWNER"): OwnershipAssignment {
  const membership = createOrganizationMembership({
    membershipId: `member-team-attention-${role.toLowerCase()}`,
    tenantScope: fixture.tenantScope,
    principalRef: `principal-team-attention-${role.toLowerCase()}`,
    role: "STAFF",
  });
  return createOwnershipAssignment({
    ownershipAssignmentId: `own-team-attention-${role.toLowerCase()}`,
    membership,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    ownerRole: role,
    assignedAt: "2026-08-01T00:00:00.000Z",
  });
}

export const WEBSITE_BUILD_V1_OWNER_HISTORY: ReadonlyArray<OwnershipAssignment> = [
  ownerAssignment("LEAD_OWNER"),
  ownerAssignment("DEAL_OWNER"),
  ownerAssignment("ACCOUNT_OWNER"),
  ownerAssignment("DELIVERY_OWNER"),
];

const attentionJob = createOutcomeJob({
  tenantScope: fixture.tenantScope,
  customer: fixture.customer,
  project: fixture.project,
  jobId: "job-team-attention-v1",
  jobFamily: "website-build-v1",
  businessObjective: "team-attention reference fixture",
});
const { job: blockedAttentionJob, auditEvent: attentionAuditEvent } = enterExceptionState({
  job: attentionJob,
  to: "BLOCKED",
  eventId: "evt-team-attention-1",
  actorRef: "system",
  timestamp: "2026-08-29T00:00:00.000Z",
  reason: "awaiting external dependency",
});

export const WEBSITE_BUILD_V1_TEAM_ATTENTION_STATE: AttentionState = buildAttentionState({
  job: blockedAttentionJob,
  latestExceptionEvent: attentionAuditEvent,
  ownershipHistory: WEBSITE_BUILD_V1_OWNER_HISTORY,
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
});

/**
 * Rev29 bounded correction: the authoritative currentness proof for
 * `WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP`. A real membership-directory
 * boundary would populate this; the reference fixture supplies exactly
 * one active (non-superseded) record so the fixture's own `viewerRole`
 * remains genuinely proven current, not merely tenant-matched.
 */
export const WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP_CURRENTNESS: ReadonlyArray<MembershipCurrentnessRecord> = [
  {
    membershipId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.membershipId,
    tenantId: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP.tenantId,
  },
];

export const WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION: TeamAttentionProjection = buildTeamAttentionProjection({
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  viewerMembership: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP,
  viewerMembershipCurrentness: WEBSITE_BUILD_V1_VIEWER_MEMBERSHIP_CURRENTNESS,
  ownerHistory: WEBSITE_BUILD_V1_OWNER_HISTORY,
  attentionState: WEBSITE_BUILD_V1_TEAM_ATTENTION_STATE,
});
