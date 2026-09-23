import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope, type SoldScope } from "../src/domain/sold-scope.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
} from "../src/domain/connection-authority.js";
import { createCapabilityAdmission, type CapabilityAdmission } from "../src/domain/capability-admission.js";
import type { AdmittedWorker, WorkerRoutingRequest } from "../src/domain/worker-routing-policy.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";
import {
  compileProjectActivationProfile,
  createAcceptedCommercialReference,
  isCommercialReferenceValidForSoldScope,
  InvalidAcceptedCommercialReferenceError,
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

// blueprintA: exercises BLOCKED (a REQUIRED requirement depending on an
// excluded CONDITIONAL requirement), the happy path, connection readiness,
// and worker routing. "req-conn" is always REQUIRED, independent of scope.
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

function commercialRefFor(soldScope: SoldScope): AcceptedCommercialReference {
  return createAcceptedCommercialReference({
    soldScope,
    acceptedCommercialReferenceId: `accepted-${soldScope.soldScopeId}`,
    acceptedAt: "2026-09-01T00:00:00.000Z",
    acceptorRef: "customer-signatory-1",
  });
}

const ownership = createProjectOwnershipRef({
  tenantId: tenantScope.tenantId,
  customerId: customer.customerId,
  projectId: project.projectId,
});

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

// ---------------------------------------------------------------------------
// AcceptedCommercialReference
// ---------------------------------------------------------------------------

test("createAcceptedCommercialReference rejects an empty acceptorRef", () => {
  const soldScope = includedSoldScope("scope-cr-1");
  assert.throws(
    () =>
      createAcceptedCommercialReference({
        soldScope,
        acceptedCommercialReferenceId: "accepted-1",
        acceptedAt: "2026-09-01T00:00:00.000Z",
        acceptorRef: "",
      }),
    InvalidAcceptedCommercialReferenceError,
  );
});

test("isCommercialReferenceValidForSoldScope is true for the exact soldScope it was accepted against", () => {
  const soldScope = includedSoldScope("scope-cr-2");
  const reference = commercialRefFor(soldScope);
  assert.equal(isCommercialReferenceValidForSoldScope(reference, soldScope), true);
});

test("isCommercialReferenceValidForSoldScope fails closed on a materially changed soldScope with the same id", () => {
  const soldScope = includedSoldScope("scope-cr-3");
  const reference = commercialRefFor(soldScope);
  const changed = excludedSoldScope("scope-cr-3");
  assert.equal(isCommercialReferenceValidForSoldScope(reference, changed), false);
});

test("isCommercialReferenceValidForSoldScope fails closed on a different soldScopeId", () => {
  const soldScope = includedSoldScope("scope-cr-4");
  const reference = commercialRefFor(soldScope);
  const other = includedSoldScope("scope-cr-4-other");
  assert.equal(isCommercialReferenceValidForSoldScope(reference, other), false);
});

// ---------------------------------------------------------------------------
// Structural coherence (step 1) - throws, never a business decision
// ---------------------------------------------------------------------------

test("compileProjectActivationProfile throws when customer belongs to a different tenant", () => {
  const soldScope = includedSoldScope("scope-struct-1");
  const otherTenant = createTenantScope("tenant-other");
  const otherCustomer = createCustomer({
    tenantScope: otherTenant,
    customerId: "cust-other",
    displayName: "Other",
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope,
        customer: otherCustomer,
        project,
        acceptedCommercialReference: commercialRefFor(soldScope),
        blueprint: blueprintA,
        soldScope,
        planId: "plan-struct-1",
        now: "2026-09-01T00:00:00.000Z",
      }),
    InvalidProjectActivationProfileError,
  );
});

test("compileProjectActivationProfile throws when acceptedCommercialReference belongs to a different project", () => {
  const soldScope = includedSoldScope("scope-struct-2");
  const otherProject = createProject({
    tenantScope,
    customer,
    projectId: "proj-other",
    ownerRef: "owner-other",
    state: "active",
  });
  const otherSoldScope = includedSoldScope("scope-struct-2-other");
  const foreignReference = createAcceptedCommercialReference({
    soldScope: createSoldScope({
      tenantScope,
      project: otherProject,
      soldScopeId: otherSoldScope.soldScopeId,
      outcomeContractRef: "contract-other",
      includedRequirementIds: ["req-optional"],
    }),
    acceptedCommercialReferenceId: "accepted-other",
    acceptedAt: "2026-09-01T00:00:00.000Z",
    acceptorRef: "customer-signatory-1",
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope,
        customer,
        project,
        acceptedCommercialReference: foreignReference,
        blueprint: blueprintA,
        soldScope,
        planId: "plan-struct-2",
        now: "2026-09-01T00:00:00.000Z",
      }),
    InvalidProjectActivationProfileError,
  );
});

// ---------------------------------------------------------------------------
// Commercial-acceptance gate (step 3)
// ---------------------------------------------------------------------------

test("a stale acceptedCommercialReference blocks with actor CUSTOMER", () => {
  const soldScope = includedSoldScope("scope-commercial-1");
  const stale = commercialRefFor(soldScope);
  const changed = excludedSoldScope("scope-commercial-1");
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: stale,
    blueprint: blueprintA,
    soldScope: changed,
    planId: "plan-commercial-1",
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.actor, "CUSTOMER");
  assert.equal(profile.decision?.kind, "COMMERCIAL_REFERENCE_INVALID");
  assert.equal(profile.wiredJobs.length, 0);
});

// ---------------------------------------------------------------------------
// Plan admission interpretation (steps 4-5)
// ---------------------------------------------------------------------------

test("a BLOCKED plan admission (unmet REQUIRED dependency) blocks with actor AKILTA", () => {
  const soldScope = excludedSoldScope("scope-plan-blocked");
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-blocked-1",
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.actor, "AKILTA");
  assert.equal(profile.decision?.kind, "PLAN_BLOCKED");
  assert.equal(profile.wiredJobs.length, 0);
});

test("an UNKNOWN sold-scope decision with no REQUIRED dependent waits on CUSTOMER", () => {
  const soldScope = unknownSoldScope("scope-plan-waiting-scope");
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintB,
    soldScope,
    planId: "plan-waiting-scope-1",
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "WAITING");
  assert.equal(profile.actor, "CUSTOMER");
  assert.equal(profile.decision?.kind, "PLAN_SCOPE_DECISION_REQUIRED");
  assert.equal(profile.decision?.relatedRef, "req-standalone-optional");
});

test("a complete plan with no approval waits on HUMAN_REVIEW", () => {
  const soldScope = includedSoldScope("scope-plan-waiting-approval");
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-waiting-approval-1",
    blueprint: blueprintA,
    soldScope,
    now: "2026-09-01T00:00:00.000Z",
  });
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-waiting-approval-1",
    readinessAssertions: buildFullReadinessAssertions(tenantScope, project, plan),
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "WAITING");
  assert.equal(profile.actor, "HUMAN_REVIEW");
  assert.equal(profile.decision?.kind, "PLAN_APPROVAL_REQUIRED");
  assert.equal(profile.decision?.relatedRef, "plan-approval");
});

test("a complete plan with no readiness assertions is BLOCKED/AKILTA before approval is even considered", () => {
  const soldScope = includedSoldScope("scope-plan-no-readiness");
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-no-readiness-1",
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.actor, "AKILTA");
  assert.equal(profile.decision?.kind, "PLAN_BLOCKED");
});

// ---------------------------------------------------------------------------
// Connection/capability readiness gate (step 7)
// ---------------------------------------------------------------------------

function admittedInputs(planId: string, soldScope: SoldScope) {
  const plan = compilePlan({
    tenantScope,
    project,
    planId,
    blueprint: blueprintA,
    soldScope,
    now: "2026-09-01T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: `approval-${planId}`,
    approvedAt: "2026-09-01T00:00:00.000Z",
    approverRef: "reviewer-1",
  });
  return {
    plan,
    readinessAssertions: buildFullReadinessAssertions(tenantScope, project, plan),
    approval,
  };
}

test("a REQUIRED connection requirement with no capability admission blocks CUSTOMER when accountOwner is CUSTOMER_OWNED", () => {
  const soldScope = includedSoldScope("scope-conn-1");
  const { readinessAssertions, approval } = admittedInputs("plan-conn-1", soldScope);
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-1",
    ownership,
    requiredCapabilityRef: "req-conn",
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-conn-1",
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.actor, "CUSTOMER");
  assert.equal(profile.decision?.kind, "CONNECTION_NOT_VERIFIED");
  assert.equal(profile.decision?.relatedRef, "conn-req-1");
});

test("an unverified AKILTA_MANAGED connection requirement blocks AKILTA, not CUSTOMER", () => {
  const soldScope = includedSoldScope("scope-conn-2");
  const { readinessAssertions, approval } = admittedInputs("plan-conn-2", soldScope);
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-2",
    ownership,
    requiredCapabilityRef: "req-conn",
    purpose: "test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-conn-2",
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.actor, "AKILTA");
  assert.equal(profile.decision?.kind, "CONNECTION_NOT_VERIFIED");
});

test("a connection requirement for an excluded CONDITIONAL capability is not gated at all", () => {
  const soldScope = excludedSoldScope("scope-conn-3");
  // req-dependent becomes BLOCKED under an excluded scope (see the earlier
  // PLAN_BLOCKED test), so use a scope-independent capability instead:
  // req-core is REQUIRED regardless of scope, req-optional is not.
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-3",
    ownership,
    requiredCapabilityRef: "req-optional",
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-conn-3",
    connectionRequirements: [connectionRequirement],
    now: "2026-09-01T00:00:00.000Z",
  });
  // req-dependent is BLOCKED under the excluded scope - the connection gate
  // is never reached, but this still proves the requirement wasn't the
  // *cause* of a CONNECTION_NOT_VERIFIED decision.
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.decision?.kind, "PLAN_BLOCKED");
});

test("connectionRequirements belonging to a different project throw rather than silently passing", () => {
  const soldScope = includedSoldScope("scope-conn-4");
  const { readinessAssertions, approval } = admittedInputs("plan-conn-4", soldScope);
  const otherProject = createProject({
    tenantScope,
    customer,
    projectId: "proj-conn-other",
    ownerRef: "owner-other",
    state: "active",
  });
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: otherProject.projectId,
  });
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-4",
    ownership: foreignOwnership,
    requiredCapabilityRef: "req-conn",
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope,
        customer,
        project,
        acceptedCommercialReference: commercialRefFor(soldScope),
        blueprint: blueprintA,
        soldScope,
        planId: "plan-conn-4",
        readinessAssertions,
        approval,
        connectionRequirements: [connectionRequirement],
        now: "2026-09-01T00:00:00.000Z",
      }),
    InvalidProjectActivationProfileError,
  );
});

function verifiedCapabilityAdmission(): {
  connectionRequirement: ReturnType<typeof createConnectionRequirement>;
  capabilityAdmission: CapabilityAdmission;
} {
  const connectionRequirement = createConnectionRequirement({
    connectionRequirementId: "conn-req-verified",
    ownership,
    requiredCapabilityRef: "req-conn",
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const requested = createConnectionBinding({
    connectionBindingId: "conn-binding-verified",
    requirement: connectionRequirement,
    ownership,
    providerRef: "provider-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connectedUnverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectionBinding(connectedUnverified, "evidence://connection-health-check");
  const capabilityAdmission = createCapabilityAdmission({
    capabilityAdmissionId: "cap-admission-verified",
    ownership,
    requiredCapabilityRef: "req-conn",
    status: "VERIFIED_AVAILABLE",
    binding: verified,
    requirement: connectionRequirement,
    evidenceRef: "evidence://capability-admission",
  });
  return { connectionRequirement, capabilityAdmission };
}

// ---------------------------------------------------------------------------
// Worker routing (step 8)
// ---------------------------------------------------------------------------

test("a REJECTED worker route blocks AKILTA", () => {
  const soldScope = includedSoldScope("scope-route-1");
  const { readinessAssertions, approval } = admittedInputs("plan-route-1", soldScope);
  const { connectionRequirement, capabilityAdmission } = verifiedCapabilityAdmission();
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-1",
    request: routableRequest({ executorCandidates: [] }),
  };
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-route-1",
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    capabilityAdmissions: [capabilityAdmission],
    workerRoutes: [route],
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "BLOCKED");
  assert.equal(profile.actor, "AKILTA");
  assert.equal(profile.decision?.kind, "WORKER_ROUTE_REJECTED");
  assert.equal(profile.decision?.relatedRef, "route-1");
  assert.equal(profile.routingDecisions.length, 1);
  assert.equal(profile.routingDecisions[0]?.status, "REJECTED");
});

test("a duplicate routeRef throws rather than silently overwriting or double-routing", () => {
  const soldScope = includedSoldScope("scope-route-2");
  const { readinessAssertions, approval } = admittedInputs("plan-route-2", soldScope);
  const { connectionRequirement, capabilityAdmission } = verifiedCapabilityAdmission();
  const route: ActivationWorkerRouteInput = { routeRef: "route-dup", request: routableRequest() };
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope,
        customer,
        project,
        acceptedCommercialReference: commercialRefFor(soldScope),
        blueprint: blueprintA,
        soldScope,
        planId: "plan-route-2",
        readinessAssertions,
        approval,
        connectionRequirements: [connectionRequirement],
        capabilityAdmissions: [capabilityAdmission],
        workerRoutes: [route, route],
        now: "2026-09-01T00:00:00.000Z",
      }),
    InvalidProjectActivationProfileError,
  );
});

// ---------------------------------------------------------------------------
// Happy path (step 9) and determinism
// ---------------------------------------------------------------------------

test("a fully clean activation reaches READY/NONE and wires every REQUIRED OutcomeJob", () => {
  const soldScope = includedSoldScope("scope-ready-1");
  const { readinessAssertions, approval } = admittedInputs("plan-ready-1", soldScope);
  const { connectionRequirement, capabilityAdmission } = verifiedCapabilityAdmission();
  const route: ActivationWorkerRouteInput = { routeRef: "route-ready", request: routableRequest() };
  const profile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-ready-1",
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    capabilityAdmissions: [capabilityAdmission],
    workerRoutes: [route],
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(profile.state, "READY");
  assert.equal(profile.actor, "NONE");
  assert.equal(profile.decision, undefined);
  assert.equal(profile.routingDecisions.length, 1);
  assert.equal(profile.routingDecisions[0]?.status, "ROUTED");
  // req-core, req-conn, req-optional (included), req-dependent are all
  // REQUIRED under this soldScope.
  const wiredRequirementIds = new Set(profile.wiredJobs.map((job) => job.jobFamily));
  assert.deepEqual(
    wiredRequirementIds,
    new Set(["req-core", "req-conn", "req-optional", "req-dependent"]),
  );
  for (const job of profile.wiredJobs) {
    assert.equal(job.state, "DRAFT");
  }
});

test("compileProjectActivationProfile is deterministic: identical inputs produce an identical profile, including sourceFingerprint", () => {
  const soldScope = includedSoldScope("scope-ready-2");
  const { readinessAssertions, approval } = admittedInputs("plan-ready-2", soldScope);
  const { connectionRequirement, capabilityAdmission } = verifiedCapabilityAdmission();
  const buildInput = () => ({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(soldScope),
    blueprint: blueprintA,
    soldScope,
    planId: "plan-ready-2",
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    capabilityAdmissions: [capabilityAdmission],
    now: "2026-09-01T00:00:00.000Z",
  });
  const first = compileProjectActivationProfile(buildInput());
  const second = compileProjectActivationProfile(buildInput());
  assert.deepEqual(first, second);
  assert.equal(first.sourceFingerprint.length, 64);
});

test("sourceFingerprint differs between a BLOCKED profile and a READY profile over otherwise-similar inputs", () => {
  const blockedScope = excludedSoldScope("scope-fingerprint-blocked");
  const blockedProfile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(blockedScope),
    blueprint: blueprintA,
    soldScope: blockedScope,
    planId: "plan-fingerprint-1",
    now: "2026-09-01T00:00:00.000Z",
  });

  const readyScope = includedSoldScope("scope-fingerprint-ready");
  const { readinessAssertions, approval } = admittedInputs("plan-fingerprint-2", readyScope);
  const { connectionRequirement, capabilityAdmission } = verifiedCapabilityAdmission();
  const readyProfile = compileProjectActivationProfile({
    tenantScope,
    customer,
    project,
    acceptedCommercialReference: commercialRefFor(readyScope),
    blueprint: blueprintA,
    soldScope: readyScope,
    planId: "plan-fingerprint-2",
    readinessAssertions,
    approval,
    connectionRequirements: [connectionRequirement],
    capabilityAdmissions: [capabilityAdmission],
    now: "2026-09-01T00:00:00.000Z",
  });

  assert.notEqual(blockedProfile.sourceFingerprint, readyProfile.sourceFingerprint);
});
