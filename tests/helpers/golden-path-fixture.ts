import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { createProject } from "../../src/domain/project.js";
import { createProjectOwnershipRef } from "../../src/domain/project-ownership.js";
import { createOfferBlueprintVersion } from "../../src/domain/offer-blueprint.js";
import { createSoldScope, type SoldScope } from "../../src/domain/sold-scope.js";
import { createDeliveryRecipe } from "../../src/domain/delivery-recipe.js";
import { compilePlan } from "../../src/domain/project-plan.js";
import { createApprovalReference } from "../../src/domain/approval-reference.js";
import { admitServiceCatalogEntry, type ServiceCatalogAdmission } from "../../src/domain/service-catalog-admission.js";
import type { ServiceCatalogEntry } from "../../src/domain/commercial-order.js";
import type { AdmittedWorker } from "../../src/domain/worker-routing-policy.js";
import {
  compileProjectActivationProfile,
  createAcceptedCommercialReference,
  type ProjectActivationCompilation,
} from "../../src/domain/project-activation-profile.js";
import { buildFullReadinessAssertions } from "./readiness-fixture.js";

/**
 * One minimal, genuinely-real (never literal-constructed) Golden-Path
 * lineage shared by OS-V0-10's own composer/integration tests - a single
 * REQUIRED requirement, no connection/platform-decision/worker-routing
 * gate, so each test's own scenario-specific gate is the only thing it
 * needs to add on top of an otherwise-READY activation.
 */
export const GOLDEN_PATH_TENANT_SCOPE = createTenantScope("tenant-os-v0-10");
export const GOLDEN_PATH_CUSTOMER = createCustomer({
  tenantScope: GOLDEN_PATH_TENANT_SCOPE,
  customerId: "cust-os-v0-10",
  displayName: "Golden Path Customer",
});
export const GOLDEN_PATH_PROJECT = createProject({
  tenantScope: GOLDEN_PATH_TENANT_SCOPE,
  customer: GOLDEN_PATH_CUSTOMER,
  projectId: "proj-os-v0-10",
  ownerRef: "owner-os-v0-10",
  state: "active",
});
export const GOLDEN_PATH_OWNERSHIP = createProjectOwnershipRef({
  tenantId: GOLDEN_PATH_TENANT_SCOPE.tenantId,
  customerId: GOLDEN_PATH_CUSTOMER.customerId,
  projectId: GOLDEN_PATH_PROJECT.projectId,
});

export const GOLDEN_PATH_BLUEPRINT = createOfferBlueprintVersion({
  blueprintId: "bp-os-v0-10",
  version: "1.0.0",
  requirements: [
    { requirementId: "req-golden-path", description: "Golden path requirement", necessity: "REQUIRED", dependsOn: [] },
  ],
});

export const GOLDEN_PATH_RECIPE = createDeliveryRecipe({
  recipeId: "recipe-os-v0-10",
  version: 1,
  jobFamily: GOLDEN_PATH_BLUEPRINT.blueprintId,
  gates: [],
  evidenceRequirements: [],
  steps: [
    {
      stepId: "step-1",
      dependsOn: [],
      allowedWorkerRefs: [],
      prohibitedActions: [],
      requiredGateRefs: [],
      requiredEvidenceRefs: [],
      recovery: "NO_EXTERNAL_EFFECT",
    },
  ],
});

export function buildGoldenPathSoldScope(soldScopeId: string): SoldScope {
  return createSoldScope({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    project: GOLDEN_PATH_PROJECT,
    soldScopeId,
    outcomeContractRef: `contract-${soldScopeId}`,
  });
}

function elevatedAdmittingWorker(): AdmittedWorker {
  return {
    workerId: "worker-os-v0-10-admitting",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence://worker-os-v0-10-admitting",
  };
}

export function buildGoldenPathServiceAdmission(): ServiceCatalogAdmission {
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: `service-${GOLDEN_PATH_BLUEPRINT.blueprintId}`,
    blueprintId: GOLDEN_PATH_BLUEPRINT.blueprintId,
    blueprintVersion: GOLDEN_PATH_BLUEPRINT.version,
    recipeId: GOLDEN_PATH_RECIPE.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  return admitServiceCatalogEntry({
    catalogEntry,
    recipe: GOLDEN_PATH_RECIPE,
    authorizingWorker: elevatedAdmittingWorker(),
    evidenceRef: "evidence://os-v0-10-service-admission",
    admittedAt: "2026-10-02T00:00:00.000Z",
  });
}

/**
 * Compiles one genuinely-real, READY `ProjectActivationProfile` (plus its
 * paired `OutcomeJobSpec`/`OutcomeJob`) via the actual, unmodified
 * `compileProjectActivationProfile` - never a literal-constructed fixture.
 */
export function compileGoldenPathActivation(planId: string, soldScopeId: string): ProjectActivationCompilation {
  const soldScope = buildGoldenPathSoldScope(soldScopeId);
  const plan = compilePlan({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    project: GOLDEN_PATH_PROJECT,
    planId,
    blueprint: GOLDEN_PATH_BLUEPRINT,
    soldScope,
    now: "2026-10-02T00:00:00.000Z",
  });
  return compileProjectActivationProfile({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    ownership: GOLDEN_PATH_OWNERSHIP,
    acceptedCommercialReference: createAcceptedCommercialReference({
      acceptanceRef: `acceptance-${soldScopeId}`,
      sourceBlueprintId: GOLDEN_PATH_BLUEPRINT.blueprintId,
      sourceBlueprintVersion: GOLDEN_PATH_BLUEPRINT.version,
      soldScopeId: soldScope.soldScopeId,
      outcomeContractRef: soldScope.outcomeContractRef,
    }),
    blueprint: GOLDEN_PATH_BLUEPRINT,
    soldScope,
    recipe: GOLDEN_PATH_RECIPE,
    serviceAdmission: buildGoldenPathServiceAdmission(),
    effectiveConfigRefs: [],
    effectivePolicyRefs: [],
    readinessAssertions: buildFullReadinessAssertions(GOLDEN_PATH_TENANT_SCOPE, GOLDEN_PATH_PROJECT, plan),
    approval: createApprovalReference({
      plan,
      approvalId: `approval-${planId}`,
      approvedAt: "2026-10-02T00:00:00.000Z",
      approverRef: "reviewer-os-v0-10",
    }),
    planId,
    now: "2026-10-02T00:00:00.000Z",
  });
}
