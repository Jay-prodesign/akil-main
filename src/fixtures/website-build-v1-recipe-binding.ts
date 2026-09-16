import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../domain/project-ownership.js";
import { admitServiceCatalogEntry, type ServiceCatalogAdmission } from "../domain/service-catalog-admission.js";
import type { AdmittedWorker } from "../domain/worker-routing-policy.js";
import { deriveOutcomeJobSpecs, type OutcomeJobSpec } from "../domain/outcome-job-spec.js";
import { bindAdmittedRecipeToPlan, type DeliveryRecipePlanBinding } from "../domain/delivery-recipe-plan-binding.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import { createApprovalReference, type ApprovalReference } from "../domain/approval-reference.js";
import { createCustomerEvidenceItem } from "../domain/customer-evidence.js";
import type { EvidenceReadinessAssertion } from "../domain/admission-readiness.js";
import {
  admitPlan,
  admitJobs,
  type PlanAdmissionResult,
  type JobAdmissionResult,
} from "../domain/plan-admission.js";
import { wireAdmittedOutcomeJobs } from "../domain/outcome-job-wiring.js";
import { buildClientProjectSnapshot, type ClientProjectSnapshot } from "../domain/client-project-snapshot.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  type ConnectionRequirement,
  type ConnectionBinding,
} from "../domain/connection-authority.js";
import { createCapabilityAdmission, type CapabilityAdmission } from "../domain/capability-admission.js";
import {
  buildWebsiteBuildV1ColdStartFixture,
  WEBSITE_BUILD_V1_SERVICE_CATALOG,
} from "./website-build-v1-commercial-order.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "./website-build-v1.js";
import { WEBSITE_BUILD_V1_RECIPE } from "./website-build-v1-recipe.js";

/**
 * CXP-001A: the one genuine end-to-end WEBSITE_BUILD_v1 chain proving a
 * real `DeliveryRecipePlanBinding` (AI-004A) - not a coincidental
 * blueprint-level `jobFamily` string match - is what makes a recipe
 * "applicable" to a project's real jobs. Uses
 * `buildWebsiteBuildV1ColdStartFixture()` (not the separate, older
 * `website-build-v1-snapshot.ts`/`website-build-v1.ts` fixtures) so every
 * plan/spec/job identity below is genuinely derived from one compiled
 * plan, exactly as AA-005 Rev21 requires.
 */
const coldStart = buildWebsiteBuildV1ColdStartFixture();
export { coldStart as WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START };

export const WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP: ProjectOwnershipRef = createProjectOwnershipRef({
  tenantId: coldStart.project.tenantId,
  customerId: coldStart.project.customerId,
  projectId: coldStart.project.projectId,
});

function elevatedWorker(): AdmittedWorker {
  return {
    workerId: "authority-website-build-v1-recipe-binding",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:website-build-v1-recipe-binding-worker-eval",
  };
}

const catalogEntry = WEBSITE_BUILD_V1_SERVICE_CATALOG.find(
  (entry) => entry.serviceRef === "service:website-build",
);
if (catalogEntry === undefined) {
  throw new Error("expected WEBSITE_BUILD_V1_SERVICE_CATALOG to contain a service:website-build entry");
}

export const WEBSITE_BUILD_V1_RECIPE_ADMISSION: ServiceCatalogAdmission = admitServiceCatalogEntry({
  catalogEntry,
  recipe: WEBSITE_BUILD_V1_RECIPE,
  authorizingWorker: elevatedWorker(),
  evidenceRef: "evidence:website-build-v1-recipe-binding-catalog-review",
  admittedAt: "2026-09-09T00:00:00.000Z",
});

export const WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS: ReadonlyArray<OutcomeJobSpec> = deriveOutcomeJobSpecs(
  coldStart.plan,
);

export const WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING: DeliveryRecipePlanBinding = bindAdmittedRecipeToPlan({
  admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
  recipe: WEBSITE_BUILD_V1_RECIPE,
  plan: coldStart.plan,
  specs: WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS,
});

/**
 * Brain PR #66 F1 correction: jobs must be proven through the real
 * admitted/wired lineage (`admitPlan` -> `admitJobs` -> `wireAdmittedOutcomeJobs`,
 * the same pattern `tests/commercial-order-cold-start-admission.test.ts`
 * already proves end to end) rather than manually reconstructed via a bare
 * `createOutcomeJob()` map - a hand-built substitute can carry the same
 * field values by construction but does not demonstrate this repository's
 * actual admission/wiring semantics.
 */
export const WEBSITE_BUILD_V1_RECIPE_BINDING_READINESS_ASSERTIONS: ReadonlyArray<EvidenceReadinessAssertion> =
  coldStart.plan.nodes
    .filter((node) => node.disposition === "REQUIRED")
    .map((node) => ({
      evidence: createCustomerEvidenceItem({
        tenantScope: coldStart.tenantScope,
        project: coldStart.project,
        evidenceRef: `ev-readiness-website-build-v1-recipe-binding-${node.requirementId}`,
        kind: "FACT",
        subject: `Readiness confirmed for ${node.requirementId}`,
        sourceLocator: `internal://reference-fixtures/website-build-v1-recipe-binding/readiness/${node.requirementId}`,
        relatedRequirementId: node.requirementId,
      }),
      assertedForPlanVersion: coldStart.plan.version,
      readinessOutcome: "SATISFIED" as const,
    }));

export const WEBSITE_BUILD_V1_RECIPE_BINDING_APPROVAL: ApprovalReference = createApprovalReference({
  plan: coldStart.plan,
  approvalId: "approval-website-build-v1-recipe-binding",
  approvedAt: "2026-09-09T00:00:00.000Z",
  approverRef: "owner:founder",
});

export const WEBSITE_BUILD_V1_RECIPE_BINDING_PLAN_ADMISSION: PlanAdmissionResult = admitPlan({
  plan: coldStart.plan,
  blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
  readinessAssertions: WEBSITE_BUILD_V1_RECIPE_BINDING_READINESS_ASSERTIONS,
  approval: WEBSITE_BUILD_V1_RECIPE_BINDING_APPROVAL,
});

export const WEBSITE_BUILD_V1_RECIPE_BINDING_JOB_ADMISSIONS: ReadonlyArray<JobAdmissionResult> = admitJobs(
  WEBSITE_BUILD_V1_RECIPE_BINDING_PLAN_ADMISSION,
  WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS,
);

/**
 * Real per-requirement wired DRAFT jobs (`jobId === spec.specId`,
 * `jobFamily === spec.requirementId`) produced by the actual
 * `wireAdmittedOutcomeJobs` primitive - not hand-picked blueprint-level
 * `jobFamily` strings and not a manually reconstructed substitute. This is
 * what makes `binding.boundJobs[].specId === job.jobId` a genuine,
 * non-coincidental provenance proof against this repository's real
 * admission/wiring semantics.
 */
export const WEBSITE_BUILD_V1_BOUND_JOBS: ReadonlyArray<OutcomeJob> = wireAdmittedOutcomeJobs({
  tenantScope: coldStart.tenantScope,
  customer: coldStart.customer,
  project: coldStart.project,
  planAdmission: WEBSITE_BUILD_V1_RECIPE_BINDING_PLAN_ADMISSION,
  jobAdmissions: WEBSITE_BUILD_V1_RECIPE_BINDING_JOB_ADMISSIONS,
  specs: WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS,
});

/**
 * One VERIFIED_AVAILABLE capability, scoped to this fixture's own
 * ownership tuple, so the composed advisor result below reaches
 * L1_RECOMMEND/RECOMMENDATIONS_AVAILABLE with the bound recipe cited on
 * its recommendation - mirrors `website-build-v1-connection.ts`'s
 * established construction pattern exactly, just re-scoped to the
 * cold-start fixture's ownership rather than the older
 * `website-build-v1.ts` fixture's.
 */
export const WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_REQUIREMENT: ConnectionRequirement =
  createConnectionRequirement({
    connectionRequirementId: "conn-req-website-build-v1-recipe-binding",
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    purpose: "Read-only storefront catalog access needed to complete the optional e-commerce integration slice",
    requiredByRef: "optional-ecommerce-integration",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider-reported connection health check",
  });

export const WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_BINDING: ConnectionBinding = (() => {
  const requested = createConnectionBinding({
    connectionBindingId: "conn-binding-website-build-v1-recipe-binding",
    requirement: WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_REQUIREMENT,
    ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
    providerRef: "reference-storefront-provider",
    workspaceRef: "reference-storefront-workspace",
    integrationInstanceRef: "reference-storefront-instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connectedUnverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(
    connectedUnverified,
    "internal://reference-fixtures/website-build-v1-recipe-binding/connection-health-check",
  );
})();

export const WEBSITE_BUILD_V1_RECIPE_BINDING_CAPABILITY_ADMISSION: CapabilityAdmission = createCapabilityAdmission({
  capabilityAdmissionId: "cap-admission-website-build-v1-recipe-binding",
  ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  requiredCapabilityRef: "required-access-connections",
  status: "VERIFIED_AVAILABLE",
  binding: WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_BINDING,
  requirement: WEBSITE_BUILD_V1_RECIPE_BINDING_CONNECTION_REQUIREMENT,
  evidenceRef: "internal://reference-fixtures/website-build-v1-recipe-binding/capability-admission-evidence",
});

export const WEBSITE_BUILD_V1_BOUND_CLIENT_PROJECT_SNAPSHOT: ClientProjectSnapshot = buildClientProjectSnapshot({
  ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  project: coldStart.project,
  jobs: WEBSITE_BUILD_V1_BOUND_JOBS,
  plan: coldStart.plan,
  capabilityAdmissions: [WEBSITE_BUILD_V1_RECIPE_BINDING_CAPABILITY_ADMISSION],
});
