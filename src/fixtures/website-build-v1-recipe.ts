import { createDeliveryRecipe, type DeliveryRecipe } from "../domain/delivery-recipe.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "./website-build-v1.js";

/**
 * V2-CDO-002 "one canonical WEBSITE_BUILD_v1 fixture". `jobFamily` reuses
 * the existing canonical job-family identifier this repository already
 * has - `WEBSITE_BUILD_V1_BLUEPRINT.blueprintId` ("website-build-v1", see
 * `website-build-v1.ts`) - rather than inventing a second family, per the
 * V2-CDO-002 task head's explicit "if the live repo has a conflicting
 * canonical job-family identifier, use that existing identifier and
 * record the mapping" instruction. This is a step-level "how" definition;
 * the DEL-003 blueprint above remains the "what" (scope/requirements)
 * authority. This recipe only defines steps/gates/evidence - it does not
 * execute anything, dispatch a worker, or touch OutcomeJob state.
 */
export const WEBSITE_BUILD_V1_RECIPE: DeliveryRecipe = createDeliveryRecipe({
  recipeId: "website-build-v1-recipe",
  version: 1,
  jobFamily: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
  requiredCapabilityRefs: ["capability:site-content-authoring", "capability:site-build"],
  requiredContextRefs: ["context:customer-brand-guidelines"],
  policyRefs: ["policy:no-production-publish-without-approval"],
  gates: [
    { gateId: "customer-approval-gate", type: "CUSTOMER_APPROVAL" },
    { gateId: "verification-review-gate", type: "HUMAN_REVIEW" },
  ],
  evidenceRequirements: [
    {
      requirementId: "artifact-checkpoint-evidence",
      evidenceClass: "WORKING_ARTIFACT",
      description: "Reference to the published working-artifact checkpoint for review",
    },
    {
      requirementId: "handover-evidence",
      evidenceClass: "HANDOVER_RECORD",
      description: "Reference to the handover record for the approved, QA-passed site",
    },
    {
      requirementId: "verification-evidence",
      evidenceClass: "VERIFICATION_RECORD",
      description: "Reference to the independent verification result for the handed-over deliverable",
    },
  ],
  steps: [
    {
      stepId: "discovery-intake",
      dependsOn: [],
      allowedWorkerRefs: ["worker:discovery-intake"],
      prohibitedActions: [],
      requiredGateRefs: [],
      requiredEvidenceRefs: [],
      recovery: "NO_EXTERNAL_EFFECT",
    },
    {
      stepId: "content-ia",
      dependsOn: ["discovery-intake"],
      allowedWorkerRefs: ["worker:content-ia"],
      prohibitedActions: [],
      requiredGateRefs: [],
      requiredEvidenceRefs: [],
      recovery: "NO_EXTERNAL_EFFECT",
    },
    {
      stepId: "design-build",
      dependsOn: ["content-ia"],
      allowedWorkerRefs: ["worker:site-build"],
      prohibitedActions: ["DEPLOY_PRODUCTION", "PUBLISH"],
      requiredGateRefs: [],
      requiredEvidenceRefs: [],
      recovery: "COMPENSATABLE",
    },
    {
      stepId: "seo-runtime-qa",
      dependsOn: ["design-build"],
      allowedWorkerRefs: ["worker:seo-runtime-qa"],
      prohibitedActions: ["DEPLOY_PRODUCTION", "PUBLISH"],
      requiredGateRefs: [],
      requiredEvidenceRefs: [],
      recovery: "IDEMPOTENT_RETRY",
    },
    {
      stepId: "working-artifact-checkpoint",
      dependsOn: ["design-build"],
      allowedWorkerRefs: ["worker:working-artifact-publisher"],
      prohibitedActions: ["DEPLOY_PRODUCTION", "PUBLISH"],
      requiredGateRefs: [],
      requiredEvidenceRefs: ["artifact-checkpoint-evidence"],
      recovery: "NO_EXTERNAL_EFFECT",
    },
    {
      stepId: "approval-lineage-capture",
      dependsOn: ["working-artifact-checkpoint"],
      allowedWorkerRefs: [],
      prohibitedActions: ["DEPLOY_PRODUCTION", "PUBLISH"],
      requiredGateRefs: ["customer-approval-gate"],
      requiredEvidenceRefs: [],
      recovery: "NO_EXTERNAL_EFFECT",
    },
    {
      stepId: "handover",
      dependsOn: ["approval-lineage-capture", "seo-runtime-qa"],
      allowedWorkerRefs: ["worker:handover"],
      prohibitedActions: ["DEPLOY_PRODUCTION", "PUBLISH"],
      requiredGateRefs: [],
      requiredEvidenceRefs: ["handover-evidence"],
      recovery: "IRREVERSIBLE_MANUAL_RECONCILIATION",
    },
    {
      stepId: "verification",
      dependsOn: ["handover"],
      allowedWorkerRefs: ["worker:verification"],
      prohibitedActions: ["DEPLOY_PRODUCTION", "PUBLISH"],
      requiredGateRefs: ["verification-review-gate"],
      requiredEvidenceRefs: ["verification-evidence"],
      recovery: "UNKNOWN_BLOCKED",
    },
  ],
  completionRequirements: [
    "artifact-checkpoint-evidence",
    "handover-evidence",
    "verification-evidence",
  ],
});
