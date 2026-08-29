import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../domain/project-ownership.js";
import {
  createProjectCommunicationRecord,
  buildProjectCommunicationHistory,
  type ProjectCommunicationHistory,
} from "../domain/project-communication.js";
import { buildWebsiteBuildV1Fixture } from "./website-build-v1.js";

/**
 * V2-CDO-003 "one canonical minimal fixture/example bound to existing
 * WEBSITE_BUILD_v1 / current ProjectPlan/OutcomeJob lineage" (IN SCOPE
 * #7). Reuses the existing `WebsiteBuildV1Fixture`'s tenant/customer/
 * project identity (`buildWebsiteBuildV1Fixture`, DEL-003) rather than
 * inventing a parallel ownership identity - the ownership ref below is
 * derived directly from that fixture's `project`.
 */
export const WEBSITE_BUILD_V1_OWNERSHIP: ProjectOwnershipRef = (() => {
  const { project } = buildWebsiteBuildV1Fixture();
  return createProjectOwnershipRef({
    tenantId: project.tenantId,
    customerId: project.customerId,
    projectId: project.projectId,
  });
})();

/**
 * One informational and one action-required communication, plus their
 * bounded history. Illustrates both classifications and both a
 * not-yet-verified and a verified observation state (O5).
 */
export const WEBSITE_BUILD_V1_COMMUNICATION_HISTORY: ProjectCommunicationHistory =
  buildProjectCommunicationHistory({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    records: [
      createProjectCommunicationRecord({
        communicationId: "comm-working-artifact-notice",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        direction: "AKILTA_TO_CUSTOMER",
        classification: "INFORMATIONAL",
        requiredActor: "NONE",
        observationState: "DELIVERY_VERIFIED",
        evidenceRef: "internal://reference-fixtures/website-build-v1/comm-working-artifact-notice-evidence",
        relatedArtifactRef: "artifact-checkpoint-evidence",
        timestamp: "2026-08-22T09:00:00Z",
      }),
      createProjectCommunicationRecord({
        communicationId: "comm-approval-request",
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        direction: "AKILTA_TO_CUSTOMER",
        classification: "ACTION_REQUIRED",
        requiredActor: "CUSTOMER",
        observationState: "DELIVERY_UNVERIFIED",
        timestamp: "2026-08-22T09:05:00Z",
      }),
    ],
  });
