import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion, type OfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope, type SoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createDeliveryRecipe, type DeliveryRecipe } from "../src/domain/delivery-recipe.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  type ConnectionRequirement,
  type ConnectionBinding,
} from "../src/domain/connection-authority.js";
import type { AdmittedWorker, WorkerRoutingRequest } from "../src/domain/worker-routing-policy.js";
import {
  admitServiceCatalogEntry,
  revokeServiceCatalogAdmission,
  type ServiceCatalogAdmission,
} from "../src/domain/service-catalog-admission.js";
import { InvalidDeliveryRecipePlanBindingError } from "../src/domain/delivery-recipe-plan-binding.js";
import type { ServiceCatalogEntry } from "../src/domain/commercial-order.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";
import {
  compileProjectActivationProfile,
  createAcceptedCommercialReference,
  createMaterialPlatformDecision,
  InvalidAcceptedCommercialReferenceError,
  InvalidMaterialPlatformDecisionError,
  InvalidProjectActivationProfileError,
  type AcceptedCommercialReference,
  type ActivationWorkerRouteInput,
} from "../src/domain/project-activation-profile.js";

const tenantScope = createTenantScope("tenant-adm-proj-001");
const customer = createCustomer({
  tenantScope,
  customerId: "cust-adm-proj-001",
  displayName: "Reference Customer",
});
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-adm-proj-001",
  ownerRef: "owner-adm-proj-001",
  state: "active",
});
const ownership = createProjectOwnershipRef({
  tenantId: tenantScope.tenantId,
  customerId: customer.customerId,
  projectId: project.projectId,
});

// blueprintA: exercises the happy path, plan-admission mapping, connection
// readiness, platform decisions, and worker routing. "req-conn" is always
// REQUIRED, independent of scope.
const blueprintA = createOfferBlueprintVersion({
  blueprintId: "bp-adm-proj-001-a",
  version: "1.0.0",
  requirements: [
    { requirementId: "req-core", description: "Core", necessity: "REQUIRED", dependsOn: [] },
    { requirementId: "req-conn", description: "Connection", necessity: "REQUIRED", dependsOn: [] },
    { requirementId: "req-optional", description: "Optional", necessity: "CONDITIONAL", dependsOn: [] },
    {
      requirementId: "req-dependent",
      description: "Dependent",
      necessity: "REQUIRED",
      dependsOn: ["req-optional"],
    },
  ],
});

// blueprintB: a CONDITIONAL requirement with no REQUIRED dependent, so an
// UNKNOWN disposition never escalates to BLOCKED - a pure WAITING/CUSTOMER
// scenario.
const blueprintB = createOfferBlueprintVersion({
  blueprintId: "bp-adm-proj-001-b",
  version: "1.0.0",
  requirements: [
    { requirementId: "req-core", description: "Core", necessity: "REQUIRED", dependsOn: [] },
    {
      requirementId: "req-standalone-optional",
      description: "Standalone optional",
      necessity: "CONDITIONAL",
      dependsOn: [],
    },
  ],
});

function recipeFor(blueprint: OfferBlueprintVersion, id: string): DeliveryRecipe {
  return createDeliveryRecipe({
    recipeId: id,
    version: 1,
    jobFamily: blueprint.blueprintId,
    requiredContextRefs: ["context:brand-guidelines"],
    policyRefs: ["policy:no-production-publish-without-approval"],
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
}

const recipeA = recipeFor(blueprintA, "recipe-adm-proj-001-a");
const recipeB = recipeFor(blueprintB, "recipe-adm-proj-001-b");

function includedSoldScope(id: string): SoldScope {
  return createSoldScope({
    tenantScope,
    project,
    soldScopeId: id,
    outcomeContractRef: `contract-${id}`,
    includedRequirementIds: ["req-optional"],
  });
}

function excludedSoldScope(id: string): SoldScope {
  return createSoldScope({
    tenantScope,
    project,
    soldScopeId: id,
    outcomeContractRef: `contract-${id}`,
    excludedRequirementIds: ["req-optional"],
  });
}

function unknownSoldScope(id: string): SoldScope {
  return createSoldScope({
    tenantScope,
    project,
    soldScopeId: id,
    outcomeContractRef: `contract-${id}`,
  });
}

function commercialRefFor(blueprint: OfferBlueprintVersion, soldScope: SoldScope): AcceptedCommercialReference {
  return createAcceptedCommercialReference({
    acceptanceRef: `acceptance-${soldScope.soldScopeId}`,
    sourceBlueprintId: blueprint.blueprintId,
    sourceBlueprintVersion: blueprint.version,
    soldScopeId: soldScope.soldScopeId,
    outcomeContractRef: soldScope.outcomeContractRef,
  });
}

function admittedWorker(overrides: Partial<AdmittedWorker> = {}): AdmittedWorker {
  return {
    workerId: "worker-1",
    declaredCapabilityRefs: ["cap:activation"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: "evidence://worker-1",
    ...overrides,
  };
}

function routableRequest(overrides: Partial<WorkerRoutingRequest> = {}): WorkerRoutingRequest {
  return {
    requiredCapabilityRef: "cap:activation",
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: [],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [admittedWorker()],
    ...overrides,
  };
}

function admittedInputs(planId: string, blueprint: OfferBlueprintVersion, soldScope: SoldScope) {
  const plan = compilePlan({
    tenantScope,
    project,
    planId,
    blueprint,
    soldScope,
    now: "2026-09-23T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: `approval-${planId}`,
    approvedAt: "2026-09-23T00:00:00.000Z",
    approverRef: "reviewer-1",
  });
  return {
    plan,
    readinessAssertions: buildFullReadinessAssertions(tenantScope, project, plan),
    approval,
  };
}

function verifiedConnectionFor(
  idSuffix: string,
  requiredCapabilityRef: string,
): {
  connectionRequirement: ConnectionRequirement;
  connectionBinding: ConnectionBinding;
} {
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: `conn-req-${idSuffix}`,
    ownership,
    requiredCapabilityRef,
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const requested = createConnectionBinding({
    connectionBindingId: `conn-binding-${idSuffix}`,
    requirement: connectionRequirement,
    ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connectedUnverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const connectionBinding = verifyConnectionBinding(
    connectedUnverified,
    `evidence://connection-health-check-${idSuffix}`,
  );
  return { connectionRequirement, connectionBinding };
}

function verifiedConnection(idSuffix: string): {
  connectionRequirement: ConnectionRequirement;
  connectionBinding: ConnectionBinding;
} {
  return verifiedConnectionFor(idSuffix, "req-conn");
}

const DEFAULT_EFFECTIVE_CONFIG_REFS = ["context:brand-guidelines"];
const DEFAULT_EFFECTIVE_POLICY_REFS = ["policy:no-production-publish-without-approval"];

function elevatedAdmittingWorker(): AdmittedWorker {
  return {
    workerId: "authority-adm-proj-001-service-admission",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence://adm-proj-001-service-admission-worker-eval",
  };
}

// V5-CONV-001 Rev116: compileProjectActivationProfile now requires an exact
// ADMITTED ServiceCatalogAdmission binding the given recipe to the given
// blueprint - a fresh admission per (blueprint, recipe) pair, matching the
// exact identities baseInput() already uses.
function serviceAdmissionFor(blueprint: OfferBlueprintVersion, recipe: DeliveryRecipe): ServiceCatalogAdmission {
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: `service-${blueprint.blueprintId}`,
    blueprintId: blueprint.blueprintId,
    blueprintVersion: blueprint.version,
    recipeId: recipe.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  return admitServiceCatalogEntry({
    catalogEntry,
    recipe,
    authorizingWorker: elevatedAdmittingWorker(),
    evidenceRef: `evidence://adm-proj-001-service-admission-${blueprint.blueprintId}`,
    admittedAt: "2026-09-23T00:00:00.000Z",
  });
}

function baseInput(
  planId: string,
  blueprint: OfferBlueprintVersion,
  recipe: DeliveryRecipe,
  soldScope: SoldScope,
  overrides: {
    effectiveConfigRefs?: ReadonlyArray<string>;
    effectivePolicyRefs?: ReadonlyArray<string>;
    serviceAdmission?: ServiceCatalogAdmission;
  } = {},
) {
  return {
    tenantScope,
    customer,
    project,
    ownership,
    acceptedCommercialReference: commercialRefFor(blueprint, soldScope),
    blueprint,
    soldScope,
    recipe,
    serviceAdmission: overrides.serviceAdmission ?? serviceAdmissionFor(blueprint, recipe),
    effectiveConfigRefs: overrides.effectiveConfigRefs ?? DEFAULT_EFFECTIVE_CONFIG_REFS,
    effectivePolicyRefs: overrides.effectivePolicyRefs ?? DEFAULT_EFFECTIVE_POLICY_REFS,
    planId,
    now: "2026-09-23T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// AcceptedCommercialReference / MaterialPlatformDecision construction
// ---------------------------------------------------------------------------

test("createAcceptedCommercialReference rejects an empty acceptanceRef", () => {
  assert.throws(
    () =>
      createAcceptedCommercialReference({
        acceptanceRef: "",
        sourceBlueprintId: "bp-1",
        sourceBlueprintVersion: "1.0.0",
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidAcceptedCommercialReferenceError,
  );
});

test("createMaterialPlatformDecision rejects a RESOLVED decision with a non-NONE actor", () => {
  assert.throws(
    () =>
      createMaterialPlatformDecision({
        decisionRef: "decision-1",
        status: "RESOLVED",
        reason: "chose the standard delivery track",
        actor: "CUSTOMER",
        selectedOptionRef: "standard-track",
      }),
    InvalidMaterialPlatformDecisionError,
  );
});

test("createMaterialPlatformDecision rejects an ACTION_REQUIRED decision carrying a selectedOptionRef", () => {
  assert.throws(
    () =>
      createMaterialPlatformDecision({
        decisionRef: "decision-2",
        status: "ACTION_REQUIRED",
        reason: "needs a human call",
        actor: "HUMAN_REVIEW",
        selectedOptionRef: "not-allowed",
      }),
    InvalidMaterialPlatformDecisionError,
  );
});

// ---------------------------------------------------------------------------
// A3: structural coherence throws
// ---------------------------------------------------------------------------

test("A3: compileProjectActivationProfile throws when customer belongs to a different tenant", () => {
  const soldScope = includedSoldScope("scope-a3");
  const otherTenant = createTenantScope("tenant-other");
  const otherCustomer = createCustomer({
    tenantScope: otherTenant,
    customerId: "cust-other",
    displayName: "Other",
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-a3", blueprintA, recipeA, soldScope),
        customer: otherCustomer,
      }),
    InvalidProjectActivationProfileError,
  );
});

test("A3: compileProjectActivationProfile throws when ownership belongs to a different project", () => {
  const soldScope = includedSoldScope("scope-a3b");
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: "proj-foreign",
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-a3b", blueprintA, recipeA, soldScope),
        ownership: foreignOwnership,
      }),
    InvalidProjectActivationProfileError,
  );
});

// ---------------------------------------------------------------------------
// A4/A5/A6: commercial reference / recipe mismatch throws
// ---------------------------------------------------------------------------

test("A4: a commercial reference for the wrong blueprintVersion throws", () => {
  const soldScope = includedSoldScope("scope-a4");
  const mismatched = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-a4",
    sourceBlueprintId: blueprintA.blueprintId,
    sourceBlueprintVersion: "9.9.9",
    soldScopeId: soldScope.soldScopeId,
    outcomeContractRef: soldScope.outcomeContractRef,
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-a4", blueprintA, recipeA, soldScope),
        acceptedCommercialReference: mismatched,
      }),
    InvalidProjectActivationProfileError,
  );
});

test("A5: a commercial reference for the wrong outcomeContractRef throws", () => {
  const soldScope = includedSoldScope("scope-a5");
  const mismatched = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-a5",
    sourceBlueprintId: blueprintA.blueprintId,
    sourceBlueprintVersion: blueprintA.version,
    soldScopeId: soldScope.soldScopeId,
    outcomeContractRef: "contract-wrong",
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-a5", blueprintA, recipeA, soldScope),
        acceptedCommercialReference: mismatched,
      }),
    InvalidProjectActivationProfileError,
  );
});

test("A6: a recipe whose jobFamily does not match the blueprint throws", () => {
  const soldScope = includedSoldScope("scope-a6");
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-a6", blueprintA, recipeB, soldScope),
      }),
    InvalidProjectActivationProfileError,
  );
});

// ---------------------------------------------------------------------------
// A7/A8: plan admission mapping
// ---------------------------------------------------------------------------

test("A7: a complete plan with no approval waits on HUMAN_REVIEW and wires zero jobs", () => {
  const soldScope = includedSoldScope("scope-a7");
  const { readinessAssertions } = admittedInputs("plan-a7", blueprintA, soldScope);
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a7", blueprintA, recipeA, soldScope),
    readinessAssertions,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "HUMAN_REVIEW");
  assert.equal(result.profile.nextRequiredAction?.code, "PLAN_APPROVAL_REQUIRED");
  assert.equal(result.jobs.length, 0);
});

test("A8: an unresolved sold-scope decision waits on CUSTOMER and wires zero jobs", () => {
  const soldScope = unknownSoldScope("scope-a8");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a8", blueprintB, recipeB, soldScope),
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "CUSTOMER");
  assert.equal(result.profile.nextRequiredAction?.code, "PLAN_SCOPE_DECISION_REQUIRED");
  assert.equal(result.jobs.length, 0);
});

test("a BLOCKED plan admission (excluded scope leaving a REQUIRED dependent unmet) maps to HUMAN_REVIEW", () => {
  const soldScope = excludedSoldScope("scope-blocked");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-blocked", blueprintA, recipeA, soldScope),
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "HUMAN_REVIEW");
  assert.equal(result.profile.nextRequiredAction?.code, "PLAN_ADMISSION_BLOCKED");
});

// ---------------------------------------------------------------------------
// A9/A10/A11/A12/A13: connection readiness gate
// ---------------------------------------------------------------------------

test("A9: a missing CUSTOMER_OWNED connection blocks CUSTOMER", () => {
  const soldScope = includedSoldScope("scope-a9");
  const { readinessAssertions, approval } = admittedInputs("plan-a9", blueprintA, soldScope);
  const { connectionRequirement } = verifiedConnection("a9");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a9", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "CUSTOMER");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
});

test("A10: a missing AKILTA_MANAGED connection blocks AKILTA", () => {
  const soldScope = includedSoldScope("scope-a10");
  const { readinessAssertions, approval } = admittedInputs("plan-a10", blueprintA, soldScope);
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-a10",
    ownership,
    requiredCapabilityRef: "req-conn",
    purpose: "test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a10", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "AKILTA");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
});

test("A11: an unverified (CONNECTED_UNVERIFIED) binding cannot satisfy the connection gate", () => {
  const soldScope = includedSoldScope("scope-a11");
  const { readinessAssertions, approval } = admittedInputs("plan-a11", blueprintA, soldScope);
  const { connectionRequirement, connectionBinding } = verifiedConnection("a11");
  const unverified = transitionConnectionBinding(
    createConnectionBinding({
      connectionBindingId: "conn-binding-a11-unverified",
      requirement: connectionRequirement,
      ownership,
      providerRef: "provider-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: ["catalog:read"],
    }),
    "CONNECTED_UNVERIFIED",
  );
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a11", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [unverified],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  // the fully VERIFIED binding built by the same helper is unrelated to this
  // scenario and only proves the helper itself produces a genuinely VERIFIED
  // binding elsewhere in this suite.
  assert.equal(connectionBinding.connectionState, "VERIFIED");
});

test("A11: a DEGRADED binding cannot satisfy the connection gate", () => {
  const soldScope = includedSoldScope("scope-a11-degraded");
  const { readinessAssertions, approval } = admittedInputs("plan-a11-degraded", blueprintA, soldScope);
  const { connectionRequirement, connectionBinding } = verifiedConnection("a11-degraded");
  const degraded = transitionConnectionBinding(connectionBinding, "DEGRADED");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a11-degraded", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [degraded],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
});

test("A11: a REVOKED binding cannot satisfy the connection gate", () => {
  const soldScope = includedSoldScope("scope-a11-revoked");
  const { readinessAssertions, approval } = admittedInputs("plan-a11-revoked", blueprintA, soldScope);
  const { connectionRequirement, connectionBinding } = verifiedConnection("a11-revoked");
  const revoked = transitionConnectionBinding(connectionBinding, "REVOKED");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a11-revoked", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [revoked],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
});

test("A12: a VERIFIED binding belonging to a different project cannot satisfy a same-id requirement", () => {
  const soldScope = includedSoldScope("scope-a12");
  const { readinessAssertions, approval } = admittedInputs("plan-a12", blueprintA, soldScope);
  const { connectionRequirement } = verifiedConnection("a12");
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: "proj-foreign-a12",
  });
  const foreignRequirement = createConnectionRequirement({
    connectionRequirementId: connectionRequirement.connectionRequirementId,
    ownership: foreignOwnership,
    requiredCapabilityRef: "req-conn",
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const foreignBinding = verifyConnectionBinding(
    transitionConnectionBinding(
      createConnectionBinding({
        connectionBindingId: "conn-binding-a12-foreign",
        requirement: foreignRequirement,
        ownership: foreignOwnership,
        providerRef: "provider-1",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: ["catalog:read"],
      }),
      "CONNECTED_UNVERIFIED",
    ),
    "evidence://foreign",
  );
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a12", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [foreignBinding],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
});

test("A13: ambiguous multiple VERIFIED compatible bindings for the same requirement rejects", () => {
  const soldScope = includedSoldScope("scope-a13");
  const { readinessAssertions, approval } = admittedInputs("plan-a13", blueprintA, soldScope);
  const { connectionRequirement, connectionBinding } = verifiedConnection("a13-1");
  const secondBinding = verifyConnectionBinding(
    transitionConnectionBinding(
      createConnectionBinding({
        connectionBindingId: "conn-binding-a13-2",
        requirement: connectionRequirement,
        ownership,
        providerRef: "provider-2",
        workspaceRef: "workspace-2",
        integrationInstanceRef: "instance-2",
        delegatedScope: ["catalog:read"],
      }),
      "CONNECTED_UNVERIFIED",
    ),
    "evidence://second",
  );
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a13", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [connectionBinding, secondBinding],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "AKILTA");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_AMBIGUOUS");
});

// ---------------------------------------------------------------------------
// A14: material platform decision gate
// ---------------------------------------------------------------------------

test("A14: an ACTION_REQUIRED platform decision blocks with its own declared actor", () => {
  const soldScope = includedSoldScope("scope-a14");
  const { readinessAssertions, approval } = admittedInputs("plan-a14", blueprintA, soldScope);
  const { connectionRequirement, connectionBinding } = verifiedConnection("a14");
  const platformDecision = createMaterialPlatformDecision({
    decisionRef: "decision-a14",
    status: "ACTION_REQUIRED",
    reason: "delivery track has not been selected yet",
    actor: "HUMAN_REVIEW",
  });
  const result = compileProjectActivationProfile({
    ...baseInput("plan-a14", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [connectionBinding],
    platformDecision,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "HUMAN_REVIEW");
  assert.equal(result.profile.nextRequiredAction?.code, "PLATFORM_DECISION_REQUIRED");
  // Rev107 F2: an ACTION_REQUIRED decision still blocks, but its exact
  // provenance must survive onto the profile - never dropped.
  assert.equal(result.profile.platformDecision?.decisionRef, "decision-a14");
  assert.equal(result.profile.platformDecision?.status, "ACTION_REQUIRED");
});

test("F2 regression: two ACTION_REQUIRED platform decisions with identical reason/actor but different decisionRef preserve distinct provenance and produce different fingerprints", () => {
  const shared = readyInputs("plan-f2-regression");
  const decisionA = createMaterialPlatformDecision({
    decisionRef: "decision-f2-a",
    status: "ACTION_REQUIRED",
    reason: "needs a human call",
    actor: "HUMAN_REVIEW",
  });
  const decisionB = createMaterialPlatformDecision({
    decisionRef: "decision-f2-b",
    status: "ACTION_REQUIRED",
    reason: "needs a human call",
    actor: "HUMAN_REVIEW",
  });
  const resultA = compileProjectActivationProfile({ ...shared, platformDecision: decisionA });
  const resultB = compileProjectActivationProfile({ ...shared, platformDecision: decisionB });
  assert.equal(resultA.profile.state, "ACTION_REQUIRED");
  assert.equal(resultB.profile.state, "ACTION_REQUIRED");
  assert.equal(resultA.profile.platformDecision?.decisionRef, "decision-f2-a");
  assert.equal(resultB.profile.platformDecision?.decisionRef, "decision-f2-b");
  assert.notEqual(resultA.profile.sourceFingerprint, resultB.profile.sourceFingerprint);
});

// ---------------------------------------------------------------------------
// V5-CONV-001 Rev113: F1 (early-blocker platformDecision provenance loss),
// F2 (connection-provenance loss inside the same loop), F3 (plain-interface
// factory bypass at the compiler boundary).
// ---------------------------------------------------------------------------

test("Rev113 F1: a supplied platformDecision survives a plan-admission blocker and changes the fingerprint when decisionRef changes", () => {
  const soldScope = includedSoldScope("scope-rev113-f1-plan");
  const { readinessAssertions } = admittedInputs("plan-rev113-f1-plan", blueprintA, soldScope);
  const decisionA = createMaterialPlatformDecision({
    decisionRef: "decision-rev113-f1-plan-a",
    status: "RESOLVED",
    reason: "standard delivery track",
    actor: "NONE",
    selectedOptionRef: "standard-track",
  });
  const decisionB = createMaterialPlatformDecision({
    decisionRef: "decision-rev113-f1-plan-b",
    status: "RESOLVED",
    reason: "standard delivery track",
    actor: "NONE",
    selectedOptionRef: "standard-track",
  });
  // No approval supplied, so this blocks at Step 5 (PLAN_APPROVAL_REQUIRED)
  // long before Step 7's own platformDecision handling would ever run.
  const resultA = compileProjectActivationProfile({
    ...baseInput("plan-rev113-f1-plan", blueprintA, recipeA, soldScope),
    readinessAssertions,
    platformDecision: decisionA,
  });
  const resultB = compileProjectActivationProfile({
    ...baseInput("plan-rev113-f1-plan", blueprintA, recipeA, soldScope),
    readinessAssertions,
    platformDecision: decisionB,
  });
  assert.equal(resultA.profile.state, "ACTION_REQUIRED");
  assert.equal(resultA.profile.nextRequiredAction?.code, "PLAN_APPROVAL_REQUIRED");
  assert.equal(resultA.profile.platformDecision?.decisionRef, "decision-rev113-f1-plan-a");
  assert.equal(resultB.profile.platformDecision?.decisionRef, "decision-rev113-f1-plan-b");
  assert.notEqual(resultA.profile.sourceFingerprint, resultB.profile.sourceFingerprint);
});

test("Rev113 F1: a supplied platformDecision survives a connection blocker", () => {
  const soldScope = includedSoldScope("scope-rev113-f1-conn");
  const { readinessAssertions, approval } = admittedInputs("plan-rev113-f1-conn", blueprintA, soldScope);
  const decision = createMaterialPlatformDecision({
    decisionRef: "decision-rev113-f1-conn",
    status: "RESOLVED",
    reason: "standard delivery track",
    actor: "NONE",
    selectedOptionRef: "standard-track",
  });
  // The req-conn requirement is supplied but with no compatible binding at
  // all, so it blocks at Step 6 - well before Step 7's own platformDecision
  // handling would run.
  const { connectionRequirement } = verifiedConnection("rev113-f1-conn");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-rev113-f1-conn", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    platformDecision: decision,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  assert.equal(result.profile.platformDecision?.decisionRef, "decision-rev113-f1-conn");
});

test("Rev113 F2: an earlier verified connection remains in terminal profile/fingerprint when a later required connection blocks", () => {
  const soldScope = includedSoldScope("scope-rev113-f2");
  const { readinessAssertions, approval } = admittedInputs("plan-rev113-f2", blueprintA, soldScope);
  // req-core is REQUIRED and gets a VERIFIED binding (resolves first, in
  // requirement-array order); req-conn is also REQUIRED but has no binding
  // at all, so it blocks. The already-accumulated req-core observation must
  // survive onto the terminal ACTION_REQUIRED profile/fingerprint.
  const { connectionRequirement: coreRequirement, connectionBinding: coreBinding } = verifiedConnectionFor(
    "rev113-f2-core",
    "req-core",
  );
  // req-conn is also REQUIRED but is supplied with no compatible binding at
  // all, so it blocks after req-core has already resolved and accumulated.
  const { connectionRequirement: connRequirement } = verifiedConnectionFor("rev113-f2-conn", "req-conn");
  const result = compileProjectActivationProfile({
    ...baseInput("plan-rev113-f2", blueprintA, recipeA, soldScope),
    readinessAssertions,
    approval,
    connectionRequirements: [coreRequirement, connRequirement],
    connectionBindings: [coreBinding],
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  assert.equal(result.profile.verifiedConnections.length, 1);
  assert.equal(result.profile.verifiedConnections[0]?.connectionRequirementId, coreRequirement.connectionRequirementId);
});

test("Rev113 F3: a hand-built (factory-bypassing) invalid AcceptedCommercialReference rejects at the compiler boundary, after structural coherence", () => {
  const soldScope = includedSoldScope("scope-rev113-f3-commercial");
  // Bypasses createAcceptedCommercialReference entirely - an empty
  // acceptanceRef could never come from the factory.
  const handBuilt: AcceptedCommercialReference = {
    acceptanceRef: "",
    sourceBlueprintId: blueprintA.blueprintId,
    sourceBlueprintVersion: blueprintA.version,
    soldScopeId: soldScope.soldScopeId,
    outcomeContractRef: soldScope.outcomeContractRef,
  };
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-rev113-f3-commercial", blueprintA, recipeA, soldScope),
        acceptedCommercialReference: handBuilt,
      }),
    InvalidAcceptedCommercialReferenceError,
  );
});

test("Rev113 F3: a hand-built (factory-bypassing) invalid MaterialPlatformDecision rejects at the compiler boundary, after structural coherence", () => {
  const soldScope = includedSoldScope("scope-rev113-f3-platform");
  // Bypasses createMaterialPlatformDecision entirely - a RESOLVED decision
  // with a non-NONE actor could never come from the factory.
  const handBuilt = {
    decisionRef: "decision-rev113-f3",
    status: "RESOLVED",
    reason: "bypassed",
    actor: "CUSTOMER",
    selectedOptionRef: "standard-track",
  } as unknown as ReturnType<typeof createMaterialPlatformDecision>;
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-rev113-f3-platform", blueprintA, recipeA, soldScope),
        platformDecision: handBuilt,
      }),
    InvalidMaterialPlatformDecisionError,
  );
});

test("Rev113 combined-adversarial priority: a foreign-tenant structural mismatch fails before a co-occurring invalid hand-built commercial reference is ever checked", () => {
  const soldScope = includedSoldScope("scope-rev113-priority");
  const otherTenant = createTenantScope("tenant-rev113-priority-other");
  const otherCustomer = createCustomer({
    tenantScope: otherTenant,
    customerId: "cust-rev113-priority-other",
    displayName: "Other",
  });
  const handBuilt: AcceptedCommercialReference = {
    acceptanceRef: "",
    sourceBlueprintId: blueprintA.blueprintId,
    sourceBlueprintVersion: blueprintA.version,
    soldScopeId: soldScope.soldScopeId,
    outcomeContractRef: soldScope.outcomeContractRef,
  };
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...baseInput("plan-rev113-priority", blueprintA, recipeA, soldScope),
        customer: otherCustomer,
        acceptedCommercialReference: handBuilt,
      }),
    InvalidProjectActivationProfileError,
  );
});

// ---------------------------------------------------------------------------
// A15/A16/A17: worker routing
// ---------------------------------------------------------------------------

function readyInputs(
  planId: string,
  overrides: {
    effectiveConfigRefs?: ReadonlyArray<string>;
    effectivePolicyRefs?: ReadonlyArray<string>;
  } = {},
) {
  const soldScope = includedSoldScope(`scope-${planId}`);
  const { readinessAssertions, approval } = admittedInputs(planId, blueprintA, soldScope);
  const { connectionRequirement, connectionBinding } = verifiedConnection(planId);
  return {
    ...baseInput(planId, blueprintA, recipeA, soldScope, overrides),
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    connectionBindings: [connectionBinding],
  };
}

test("A16: a REJECTED worker route blocks AKILTA and wires zero jobs", () => {
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-a16",
    request: routableRequest({ executorCandidates: [] }),
  };
  const result = compileProjectActivationProfile({ ...readyInputs("plan-a16"), workerRoutes: [route] });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "AKILTA");
  assert.equal(result.profile.nextRequiredAction?.code, "WORKER_ROUTE_REJECTED");
  assert.equal(result.jobs.length, 0);
  assert.equal(result.profile.consumedRoutes.length, 1);
  assert.equal(result.profile.consumedRoutes[0]?.decision.status, "REJECTED");
});

test("A15/A17: an ineligible preferred worker is skipped and an eligible fallback still routes without relaxing requirements", () => {
  const preferred = admittedWorker({ workerId: "worker-untrusted", trustStatus: "UNTRUSTED" });
  const fallback = admittedWorker({ workerId: "worker-eligible" });
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-a17",
    request: routableRequest({ executorCandidates: [preferred, fallback] }),
  };
  const result = compileProjectActivationProfile({ ...readyInputs("plan-a17"), workerRoutes: [route] });
  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.consumedRoutes[0]?.decision.status, "ROUTED");
  assert.equal(result.profile.consumedRoutes[0]?.decision.executorWorkerId, "worker-eligible");
});

test("A15/A17: an UNAVAILABLE preferred worker is skipped in favor of an eligible fallback", () => {
  const preferred = admittedWorker({ workerId: "worker-unavailable", availability: "UNAVAILABLE" });
  const fallback = admittedWorker({ workerId: "worker-eligible-unavailable-fallback" });
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-a17-unavailable",
    request: routableRequest({ executorCandidates: [preferred, fallback] }),
  };
  const result = compileProjectActivationProfile({
    ...readyInputs("plan-a17-unavailable"),
    workerRoutes: [route],
  });
  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.consumedRoutes[0]?.decision.executorWorkerId, "worker-eligible-unavailable-fallback");
});

test("A15/A17: an under-authorized preferred worker is skipped in favor of an ELEVATED-authority fallback", () => {
  const preferred = admittedWorker({ workerId: "worker-standard-authority" });
  const fallback = admittedWorker({ workerId: "worker-elevated-authority", authorityLevel: "ELEVATED" });
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-a17-authority",
    request: routableRequest({
      requiredAuthorityLevel: "ELEVATED",
      executorCandidates: [preferred, fallback],
    }),
  };
  const result = compileProjectActivationProfile({
    ...readyInputs("plan-a17-authority"),
    workerRoutes: [route],
  });
  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.consumedRoutes[0]?.decision.executorWorkerId, "worker-elevated-authority");
});

test("A15/A17: a preferred worker missing a required tool/policy constraint is skipped in favor of a fully-declared fallback", () => {
  const preferred = admittedWorker({ workerId: "worker-missing-constraint" });
  const fallback = admittedWorker({
    workerId: "worker-fully-declared",
    declaredToolRefs: ["tool:required-one"],
    declaredPolicyConstraintRefs: ["policy:required-one"],
  });
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-a17-constraint",
    request: routableRequest({
      requiredToolRefs: ["tool:required-one"],
      requiredPolicyConstraintRefs: ["policy:required-one"],
      executorCandidates: [preferred, fallback],
    }),
  };
  const result = compileProjectActivationProfile({
    ...readyInputs("plan-a17-constraint"),
    workerRoutes: [route],
  });
  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.consumedRoutes[0]?.decision.executorWorkerId, "worker-fully-declared");
});

test("a duplicate routeRef throws rather than silently double-routing", () => {
  const route: ActivationWorkerRouteInput = { routeRef: "route-dup", request: routableRequest() };
  assert.throws(
    () =>
      compileProjectActivationProfile({
        ...readyInputs("plan-dup-route"),
        workerRoutes: [route, route],
      }),
    InvalidProjectActivationProfileError,
  );
});

// ---------------------------------------------------------------------------
// A1/A2: happy path and determinism
// ---------------------------------------------------------------------------

test("A1: a fully clean activation reaches READY/NONE and wires every REQUIRED OutcomeJob as DRAFT", () => {
  const route: ActivationWorkerRouteInput = { routeRef: "route-a1", request: routableRequest() };
  const result = compileProjectActivationProfile({ ...readyInputs("plan-a1"), workerRoutes: [route] });
  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.nextRequiredActor, "NONE");
  assert.equal(result.profile.nextRequiredAction, undefined);
  assert.equal(result.profile.unresolvedGates.length, 0);
  const wiredRequirementIds = new Set(result.jobs.map((job) => job.jobFamily));
  assert.deepEqual(
    wiredRequirementIds,
    new Set(["req-core", "req-conn", "req-optional", "req-dependent"]),
  );
  for (const job of result.jobs) {
    assert.equal(job.state, "DRAFT");
  }
});

test("A2: identical inputs produce a deep-equal profile and an equal sourceFingerprint", () => {
  const inputs = readyInputs("plan-a2");
  const first = compileProjectActivationProfile(inputs);
  const second = compileProjectActivationProfile(inputs);
  assert.deepEqual(first, second);
  assert.equal(first.profile.sourceFingerprint.length, 64);
});

// ---------------------------------------------------------------------------
// V5-CONV-001 Rev116: admitted service/recipe binding becomes load-bearing.
// ---------------------------------------------------------------------------

test("Rev116: a fully clean activation with an ADMITTED service/recipe binding reaches READY and returns the exact binding on the compilation", () => {
  const inputs = readyInputs("plan-rev116-happy");
  const result = compileProjectActivationProfile(inputs);
  assert.equal(result.profile.state, "READY");
  assert.equal(result.recipeBinding.boundRecipeId, recipeA.recipeId);
  assert.equal(result.recipeBinding.consumedRecipeVersion, recipeA.version);
  assert.equal(result.recipeBinding.serviceRef, inputs.serviceAdmission.serviceRef);
  assert.equal(result.recipeBinding.boundJobs.length, result.specs.length);
});

test("Rev116 (adversarial): a REVOKED ServiceCatalogAdmission cannot yield READY", () => {
  const inputs = readyInputs("plan-rev116-revoked");
  const revoked = revokeServiceCatalogAdmission({
    admission: inputs.serviceAdmission,
    revokedAt: "2026-09-23T00:00:01.000Z",
    reason: "test revocation",
  });
  assert.throws(
    () => compileProjectActivationProfile({ ...inputs, serviceAdmission: revoked }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("Rev116 (adversarial): a service admission for a different blueprintId cannot yield READY", () => {
  const inputs = readyInputs("plan-rev116-blueprint-mismatch");
  const mismatched: ServiceCatalogAdmission = {
    ...inputs.serviceAdmission,
    blueprintId: "some-other-blueprint" as ServiceCatalogAdmission["blueprintId"],
  };
  assert.throws(
    () => compileProjectActivationProfile({ ...inputs, serviceAdmission: mismatched }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("Rev116 (adversarial): a service admission for a different blueprintVersion cannot yield READY", () => {
  const inputs = readyInputs("plan-rev116-blueprint-version-mismatch");
  const mismatched: ServiceCatalogAdmission = {
    ...inputs.serviceAdmission,
    blueprintVersion: "9.9.9",
  };
  assert.throws(
    () => compileProjectActivationProfile({ ...inputs, serviceAdmission: mismatched }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("Rev116 (adversarial): a service admission for a different recipeId cannot yield READY", () => {
  const inputs = readyInputs("plan-rev116-recipeid-mismatch");
  const mismatched: ServiceCatalogAdmission = {
    ...inputs.serviceAdmission,
    recipeId: "some-other-recipe" as ServiceCatalogAdmission["recipeId"],
  };
  assert.throws(
    () => compileProjectActivationProfile({ ...inputs, serviceAdmission: mismatched }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("Rev117 (adversarial, via compileProjectActivationProfile): a service admission for a different recipeVersion cannot yield READY", () => {
  const inputs = readyInputs("plan-rev117-recipeversion-mismatch");
  const mismatched: ServiceCatalogAdmission = {
    ...inputs.serviceAdmission,
    recipeVersion: (inputs.serviceAdmission.recipeVersion as number) + 1,
  };
  assert.throws(
    () => compileProjectActivationProfile({ ...inputs, serviceAdmission: mismatched }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("Rev116: changing the admitted service/recipe binding's provenance changes the sourceFingerprint from an otherwise-identical base", () => {
  const inputs = readyInputs("plan-rev116-fingerprint");
  const admissionA = serviceAdmissionFor(blueprintA, recipeA);
  const admissionB = admitServiceCatalogEntry({
    catalogEntry: {
      serviceRef: admissionA.serviceRef,
      blueprintId: admissionA.blueprintId,
      blueprintVersion: admissionA.blueprintVersion,
      recipeId: admissionA.recipeId,
      executionRoutingPolicy: admissionA.executionRoutingPolicy,
    },
    recipe: recipeA,
    authorizingWorker: elevatedAdmittingWorker(),
    // Different evidenceRef only - otherwise the same admitted service/recipe.
    evidenceRef: "evidence://adm-proj-001-service-admission-rev116-alternate",
    admittedAt: "2026-09-23T00:00:00.000Z",
  });
  const resultA = compileProjectActivationProfile({ ...inputs, serviceAdmission: admissionA });
  const resultB = compileProjectActivationProfile({ ...inputs, serviceAdmission: admissionB });
  assert.equal(resultA.profile.state, "READY");
  assert.equal(resultB.profile.state, "READY");
  assert.notEqual(resultA.profile.sourceFingerprint, resultB.profile.sourceFingerprint);
});

// ---------------------------------------------------------------------------
// A18: material mutations change the fingerprint
// ---------------------------------------------------------------------------

test("A18: independently varying effectiveConfigRefs, effectivePolicyRefs, platform decision, verified-connection evidence, or routing input each change the sourceFingerprint from an otherwise-identical base", () => {
  // One shared base input (same planId/blueprint/soldScope/recipe/connection
  // identity throughout) - each sub-case changes exactly one field from it,
  // per Rev107 F3's "controlled one-variable-at-a-time mutation" requirement.
  const shared = readyInputs("plan-a18-shared");
  const baseline = compileProjectActivationProfile(shared);

  const configVaried = compileProjectActivationProfile({
    ...shared,
    effectiveConfigRefs: ["context:a-materially-different-config"],
  });
  assert.notEqual(configVaried.profile.sourceFingerprint, baseline.profile.sourceFingerprint);

  const policyVaried = compileProjectActivationProfile({
    ...shared,
    effectivePolicyRefs: ["policy:a-materially-different-policy"],
  });
  assert.notEqual(policyVaried.profile.sourceFingerprint, baseline.profile.sourceFingerprint);

  const platformVaried = compileProjectActivationProfile({
    ...shared,
    platformDecision: createMaterialPlatformDecision({
      decisionRef: "decision-a18",
      status: "RESOLVED",
      reason: "standard track selected",
      actor: "NONE",
      selectedOptionRef: "standard-track",
    }),
  });
  assert.notEqual(platformVaried.profile.sourceFingerprint, baseline.profile.sourceFingerprint);

  const routeVaried = compileProjectActivationProfile({
    ...shared,
    workerRoutes: [{ routeRef: "route-a18", request: routableRequest() }],
  });
  assert.notEqual(routeVaried.profile.sourceFingerprint, baseline.profile.sourceFingerprint);

  // Connection observation: identical requirement/ownership/ids, only the
  // verification evidence ref differs.
  const { connectionRequirement, connectionBinding } = verifiedConnection("a18-evidence");
  const alternateEvidenceBinding = verifyConnectionBinding(
    transitionConnectionBinding(
      createConnectionBinding({
        connectionBindingId: connectionBinding.connectionBindingId,
        requirement: connectionRequirement,
        ownership,
        providerRef: "provider-1",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: ["catalog:read"],
      }),
      "CONNECTED_UNVERIFIED",
    ),
    "evidence://a-materially-different-evidence-value",
  );
  const evidenceSoldScope = includedSoldScope("scope-a18-evidence");
  const evidenceAdmitted = admittedInputs("plan-a18-evidence", blueprintA, evidenceSoldScope);
  const evidenceShared = {
    ...baseInput("plan-a18-evidence", blueprintA, recipeA, evidenceSoldScope),
    readinessAssertions: evidenceAdmitted.readinessAssertions,
    approval: evidenceAdmitted.approval,
    connectionRequirements: [connectionRequirement],
  };
  const evidenceBaseline = compileProjectActivationProfile({
    ...evidenceShared,
    connectionBindings: [connectionBinding],
  });
  const evidenceVaried = compileProjectActivationProfile({
    ...evidenceShared,
    connectionBindings: [alternateEvidenceBinding],
  });
  assert.notEqual(evidenceVaried.profile.sourceFingerprint, evidenceBaseline.profile.sourceFingerprint);
});

// ---------------------------------------------------------------------------
// A19: no raw secret/credential leakage
// ---------------------------------------------------------------------------

test("A19: the serialized profile never contains a raw providerRef/workspaceRef/instanceRef, only the opaque SecretRef id and evidence ref", () => {
  const result = compileProjectActivationProfile(readyInputs("plan-a19"));
  const serialized = JSON.stringify(result.profile);
  assert.doesNotMatch(serialized, /provider-1|workspace-1|instance-1/);
  assert.match(serialized, /connectionBindingId/);
  assert.match(serialized, /verificationEvidenceRef/);
});

// ---------------------------------------------------------------------------
// A20: boundary scan - no AI Commerce/provider SDK/fetch/HTTP/store/
// Date.now/randomness. Folded into this file rather than a separate
// boundary-scan test file: Rev106's bounded write surface for this
// correction is exactly src/domain/project-activation-profile.ts,
// tests/project-activation-profile.test.ts, and
// docs/exec-plans/active/ADM-PROJ-001.md.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADM_PROJ_001_SOURCE_PATH = "src/domain/project-activation-profile.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

const AI_COMMERCE_AND_PROVIDER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "akilta-commerce", pattern: /akilta-commerce/i },
  { label: "ai-commerce", pattern: /ai[_-]?commerce/i },
  { label: "Shopify", pattern: /shopify/i },
  { label: "Ticimax", pattern: /ticimax/i },
  { label: "ikas", pattern: /\bikas\b/i },
  { label: "IdeaSoft", pattern: /ideasoft/i },
  { label: "T-Soft", pattern: /t-soft/i },
  { label: "WooCommerce", pattern: /woocommerce/i },
  { label: "openai", pattern: /openai/i },
  { label: "anthropic-sdk", pattern: /anthropic/i },
];

const RUNTIME_EFFECT_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "fetch", pattern: /\bfetch\s*\(/ },
  { label: "http-module", pattern: /require\(['"]https?['"]\)|from ['"]node:https?['"]/ },
  { label: "XMLHttpRequest", pattern: /XMLHttpRequest/ },
  { label: "child_process", pattern: /child_process/ },
  { label: "filesystem", pattern: /\bfs\.(readFile|writeFile|readFileSync|writeFileSync)\b/ },
  { label: "Date.now", pattern: /Date\.now\s*\(/ },
  { label: "new Date without argument", pattern: /new Date\(\s*\)/ },
  { label: "Math.random", pattern: /Math\.random\s*\(/ },
  { label: "process.env", pattern: /process\.env/ },
];

test("A20/boundary: domain source contains no secret material, no AI Commerce/provider-SDK coupling, and no fetch/HTTP/filesystem/child_process/Date.now/randomness", () => {
  const content = readFileSync(join(REPO_ROOT, ADM_PROJ_001_SOURCE_PATH), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [
    ...SECRET_PATTERNS,
    ...AI_COMMERCE_AND_PROVIDER_PATTERNS,
    ...RUNTIME_EFFECT_PATTERNS,
  ]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("A20/boundary: no new runtime dependency was introduced", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@types/node", "typescript"],
  );
});
