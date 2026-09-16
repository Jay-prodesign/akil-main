import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../domain/project-ownership.js";
import { admitServiceCatalogEntry, type ServiceCatalogAdmission } from "../domain/service-catalog-admission.js";
import type { AdmittedWorker } from "../domain/worker-routing-policy.js";
import { deriveOutcomeJobSpecs, type OutcomeJobSpec } from "../domain/outcome-job-spec.js";
import { bindAdmittedRecipeToPlan, type DeliveryRecipePlanBinding } from "../domain/delivery-recipe-plan-binding.js";
import { createOutcomeJob, type OutcomeJob } from "../domain/outcome-job.js";
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
 * Real per-requirement wired jobs (`jobId === spec.specId`, `jobFamily ===
 * spec.requirementId`, mirroring `wireAdmittedOutcomeJobs`'s own identity
 * convention) - not hand-picked blueprint-level `jobFamily` strings. This
 * is what makes `binding.boundJobs[].specId === job.jobId` a genuine,
 * non-coincidental provenance proof.
 */
export const WEBSITE_BUILD_V1_BOUND_JOBS: ReadonlyArray<OutcomeJob> = WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS.map(
  (spec) =>
    createOutcomeJob({
      tenantScope: coldStart.tenantScope,
      customer: coldStart.customer,
      project: coldStart.project,
      jobId: spec.specId,
      jobFamily: spec.jobFamily,
      businessObjective: spec.intendedOutcome,
    }),
);

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
