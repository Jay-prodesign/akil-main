import { buildWebsiteBuildV1Fixture } from "./website-build-v1.js";
import { WEBSITE_BUILD_V1_OWNERSHIP, WEBSITE_BUILD_V1_COMMUNICATION_HISTORY } from "./website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CAPABILITY_ADMISSION } from "./website-build-v1-connection.js";
import { compilePlan, type ProjectPlanVersion } from "../domain/project-plan.js";
import { createApprovalReference, type ApprovalReference } from "../domain/approval-reference.js";
import { createOutcomeJob, transitionOutcomeJob, verifyOutcomeJob, type OutcomeJob } from "../domain/outcome-job.js";
import { createEvidenceReference } from "../domain/evidence.js";
import { createVerificationResult } from "../domain/verification-result.js";
import { buildClientProjectSnapshot, type ClientProjectSnapshot } from "../domain/client-project-snapshot.js";

const fixture = buildWebsiteBuildV1Fixture();

/**
 * One deterministic compiled plan (DEL-003 `compilePlan`) reused as the
 * "current working artifact" for the snapshot's `workingArtifact` field.
 */
export const WEBSITE_BUILD_V1_SNAPSHOT_PLAN: ProjectPlanVersion = compilePlan({
  tenantScope: fixture.tenantScope,
  project: fixture.project,
  planId: "plan-website-build-v1-snapshot",
  blueprint: fixture.blueprint,
  soldScope: fixture.soldScope,
  evidence: fixture.evidence,
  now: "2026-08-25T00:00:00Z",
});

/**
 * An approval bound to the exact plan above (DEL-003 T10) - illustrates
 * `isCurrentVersionApproved: true` in the reference-proof snapshot.
 */
export const WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL: ApprovalReference = createApprovalReference({
  plan: WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
  approvalId: "approval-website-build-v1-snapshot",
  approvedAt: "2026-08-25T01:00:00Z",
  approverRef: "customer-approver-1",
});

/**
 * One fully verified/closed job (discovery evidence intake) - contributes
 * to `verifiedCompletedJobIds` - and one still-executing job (design/
 * build), so the reference-proof snapshot's `deliveryStatus.overallStatus`
 * is `IN_PROGRESS`, not trivially `COMPLETE` or `NOT_STARTED`.
 */
const closedJob: OutcomeJob = (() => {
  const draft = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-website-build-v1-discovery",
    jobFamily: "website-build-v1",
    businessObjective: "Capture and classify discovery evidence",
  });
  const ready = transitionOutcomeJob(transitionOutcomeJob(draft, "QUALIFIED"), "READY");
  const verifying = transitionOutcomeJob(transitionOutcomeJob(ready, "EXECUTING"), "VERIFYING");
  const evidence = createEvidenceReference({
    job: verifying,
    evidenceId: "evidence-website-build-v1-discovery",
    evidenceType: "discovery-evidence-review",
    sourceLocator: "internal://reference-fixtures/website-build-v1/discovery-evidence-review",
    capturedAt: "2026-08-24T00:00:00Z",
  });
  const verificationResult = createVerificationResult({
    verificationId: "verification-website-build-v1-discovery",
    job: verifying,
    evidence,
    verificationRequirementRef: "discovery-evidence-intake",
    status: "PASSED",
  });
  const verified = verifyOutcomeJob(verifying, verificationResult);
  return transitionOutcomeJob(verified, "CLOSED");
})();

const inProgressJob: OutcomeJob = (() => {
  const draft = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-website-build-v1-design-build",
    jobFamily: "website-build-v1",
    businessObjective: "Design and build the site against the approved information architecture",
  });
  const ready = transitionOutcomeJob(transitionOutcomeJob(draft, "QUALIFIED"), "READY");
  return transitionOutcomeJob(ready, "EXECUTING");
})();

export const WEBSITE_BUILD_V1_SNAPSHOT_JOBS: ReadonlyArray<OutcomeJob> = [closedJob, inProgressJob];

/**
 * V2-CDO-005 "one deterministic customer-safe snapshot from existing
 * repository identities" reference proof. Reuses `WEBSITE_BUILD_V1_
 * OWNERSHIP`/`WEBSITE_BUILD_V1_COMMUNICATION_HISTORY` (V2-CDO-003) and
 * `WEBSITE_BUILD_V1_CAPABILITY_ADMISSION` (V2-CDO-004) directly.
 */
export const WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT: ClientProjectSnapshot = buildClientProjectSnapshot({
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  project: fixture.project,
  jobs: WEBSITE_BUILD_V1_SNAPSHOT_JOBS,
  plan: WEBSITE_BUILD_V1_SNAPSHOT_PLAN,
  latestApproval: WEBSITE_BUILD_V1_SNAPSHOT_APPROVAL,
  communicationHistory: WEBSITE_BUILD_V1_COMMUNICATION_HISTORY,
  capabilityAdmissions: [WEBSITE_BUILD_V1_CAPABILITY_ADMISSION],
});
