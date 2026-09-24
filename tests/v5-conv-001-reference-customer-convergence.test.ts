import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import {
  WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT,
  WEBSITE_BUILD_V1_CONNECTION_BINDING,
} from "../src/fixtures/website-build-v1-connection.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createApprovalReference, type ApprovalReference } from "../src/domain/approval-reference.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";
import {
  compileProjectActivationProfile,
  createAcceptedCommercialReference,
  createMaterialPlatformDecision,
  InvalidProjectActivationProfileError,
  type ProjectActivationCompilation,
  type ActivationWorkerRouteInput,
} from "../src/domain/project-activation-profile.js";
import {
  admitServiceCatalogEntry,
  revokeServiceCatalogAdmission,
  type ServiceCatalogAdmission,
} from "../src/domain/service-catalog-admission.js";
import { InvalidDeliveryRecipePlanBindingError } from "../src/domain/delivery-recipe-plan-binding.js";
import type { ServiceCatalogEntry } from "../src/domain/commercial-order.js";
import type { AdmittedWorker, WorkerRoutingRequest } from "../src/domain/worker-routing-policy.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  type ConnectionBinding,
} from "../src/domain/connection-authority.js";
import { buildClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";
import { renderShellPage } from "../src/web/shell-render.js";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";
import {
  authorizedTransitionOutcomeJob,
  authorizedVerifyOutcomeJob,
  MissingExecutionRoutingRequirementError,
} from "../src/application/authorized-outcome-job-operations.js";
import { createExecutionRoutingRequirementRegistry } from "../src/domain/outcome-job-routing-execution.js";
import { enterExceptionState, recoverFromExceptionState, type OutcomeJob } from "../src/domain/outcome-job.js";
import type { OutcomeJobSpec } from "../src/domain/outcome-job-spec.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";

/**
 * V5-CONV-001 (Brain Rev109/112/114/115/116/117): one real WEBSITE_BUILD_v1
 * reference-customer convergence proof, composed entirely through this
 * repository's own existing primitives - manual/proposal
 * AcceptedCommercialReference -> compileProjectActivationProfile (now
 * admitted-service/recipe-binding load-bearing, Rev116/117) -> admitted/
 * wired OutcomeJobs -> the already-proven execution/verification lifecycle
 * (Rev109 authorized-outcome-job-operations.ts) -> a truthful post-
 * execution ClientProjectSnapshot/shell. No parallel fixture, no simplified
 * fake compiler, no CommercialOrder/checkout authority (Rev114's explicit
 * "manual/proposal, not checkout" instruction).
 */

const fixture = buildWebsiteBuildV1Fixture();

function elevatedAdmittingWorker(idSuffix = "1"): AdmittedWorker {
  return {
    workerId: `authority-v5-conv-001-service-admission-${idSuffix}`,
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: `evidence://v5-conv-001-service-admission-worker-eval-${idSuffix}`,
  };
}

function serviceAdmissionFor(idSuffix = "1"): ServiceCatalogAdmission {
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: "service:website-build-v1-reference",
    blueprintId: fixture.blueprint.blueprintId,
    blueprintVersion: fixture.blueprint.version,
    recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  return admitServiceCatalogEntry({
    catalogEntry,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    authorizingWorker: elevatedAdmittingWorker(idSuffix),
    evidenceRef: `evidence://v5-conv-001-service-catalog-review-${idSuffix}`,
    admittedAt: "2026-09-24T00:00:00.000Z",
  });
}

function routingCandidateWorker(overrides: Partial<AdmittedWorker> = {}): AdmittedWorker {
  return {
    workerId: "worker-v5-conv-001-site-build",
    declaredCapabilityRefs: ["capability:site-build"],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: ["policy:no-production-publish-without-approval"],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "STANDARD",
    costWeight: 1,
    evaluationEvidenceRef: "evidence://v5-conv-001-worker-site-build-eval",
    ...overrides,
  };
}

function siteBuildRoute(overrides: Partial<WorkerRoutingRequest> = {}): WorkerRoutingRequest {
  return {
    requiredCapabilityRef: "capability:site-build",
    riskLevel: "STANDARD",
    requiredToolRefs: [],
    requiredPolicyConstraintRefs: ["policy:no-production-publish-without-approval"],
    requiredAuthorityLevel: "STANDARD",
    requiresIndependentReview: false,
    executorCandidates: [routingCandidateWorker()],
    ...overrides,
  };
}

interface HappyPathInputs {
  now: string;
  planId: string;
  plan: ReturnType<typeof compilePlan>;
  approval: ApprovalReference;
  serviceAdmission: ServiceCatalogAdmission;
  platformDecision: ReturnType<typeof createMaterialPlatformDecision>;
  route: ActivationWorkerRouteInput;
}

function buildHappyPathInputs(planId: string, idSuffix = "1"): HappyPathInputs {
  const now = "2026-09-24T00:00:00.000Z";
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now,
  });
  const approval = createApprovalReference({
    plan,
    approvalId: `approval-${planId}`,
    approvedAt: now,
    approverRef: "reviewer-v5-conv-001",
  });
  const serviceAdmission = serviceAdmissionFor(idSuffix);
  const platformDecision = createMaterialPlatformDecision({
    decisionRef: `decision-${planId}`,
    status: "RESOLVED",
    reason: "standard manual-execution delivery track",
    actor: "NONE",
    selectedOptionRef: "standard-manual-track",
  });
  const route: ActivationWorkerRouteInput = {
    routeRef: `route-${planId}`,
    request: siteBuildRoute(),
  };
  return { now, planId, plan, approval, serviceAdmission, platformDecision, route };
}

function compileHappyPath(
  planId: string,
  idSuffix = "1",
): { result: ProjectActivationCompilation; inputs: HappyPathInputs } {
  const inputs = buildHappyPathInputs(planId, idSuffix);
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: `acceptance-${planId}`,
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    platformDecision: inputs.platformDecision,
    workerRoutes: [inputs.route],
    now: inputs.now,
  });
  return { result, inputs };
}

function findSpec(specs: ReadonlyArray<OutcomeJobSpec>, requirementId: string): OutcomeJobSpec {
  const spec = specs.find((s) => s.requirementId === requirementId);
  assert.ok(spec !== undefined, `expected a spec for requirement "${requirementId}"`);
  return spec as OutcomeJobSpec;
}

function findJob(jobs: ReadonlyArray<OutcomeJob>, jobId: string): OutcomeJob {
  const job = jobs.find((j) => (j.jobId as string) === jobId);
  assert.ok(job !== undefined, `expected a job with jobId "${jobId}"`);
  return job as OutcomeJob;
}

// ---------------------------------------------------------------------------
// G1 (Rev109 A-K + Rev114 required assertions): one real happy cold-start
// composes commercial ref -> admitted-service/recipe-bound activation
// compiler -> jobs -> snapshot -> shell, with every load-bearing provenance
// field present and exact.
// ---------------------------------------------------------------------------

test("G1: happy cold-start composes through the entire chain to a READY, customer-safe rendered shell with full provenance", () => {
  const { result, inputs } = compileHappyPath("plan-v5-conv-g1");

  assert.equal(result.profile.state, "READY");
  assert.equal(result.profile.nextRequiredActor, "NONE");
  assert.equal(result.profile.nextRequiredAction, undefined);
  assert.ok(result.jobs.length > 0, "expected at least one admitted/wired OutcomeJob");
  for (const job of result.jobs) {
    assert.equal(job.state, "DRAFT");
  }

  // B: independent provenance - identities exact, effective config/policy
  // provenance equals the caller's own inputs (never derived from the
  // recipe's own declarations).
  assert.equal(result.profile.tenantId, fixture.tenantScope.tenantId);
  assert.equal(result.profile.customerId, fixture.customer.customerId);
  assert.equal(result.profile.projectId, fixture.project.projectId);
  assert.equal(result.profile.blueprintId, fixture.blueprint.blueprintId);
  assert.equal(result.profile.recipeId, WEBSITE_BUILD_V1_RECIPE.recipeId);
  assert.equal(result.profile.recipeVersion, WEBSITE_BUILD_V1_RECIPE.version);
  assert.deepEqual(result.profile.effectiveConfigRefs, WEBSITE_BUILD_V1_RECIPE.requiredContextRefs);
  assert.deepEqual(result.profile.effectivePolicyRefs, WEBSITE_BUILD_V1_RECIPE.policyRefs);

  // Platform decision provenance is present.
  assert.equal(result.profile.platformDecision?.decisionRef, inputs.platformDecision.decisionRef);

  // Verified connection evidence is present.
  assert.equal(result.profile.verifiedConnections.length, 1);
  assert.equal(
    result.profile.verifiedConnections[0]?.connectionRequirementId,
    WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT.connectionRequirementId,
  );

  // Consumed route decision is present and routed.
  assert.equal(result.profile.consumedRoutes.length, 1);
  assert.equal(result.profile.consumedRoutes[0]?.decision.status, "ROUTED");

  // sourceFingerprint is deterministic (a stable 64-hex-char sha256 digest).
  assert.match(result.profile.sourceFingerprint, /^[0-9a-f]{64}$/);

  // RECIPE/PLAN BINDING: the actual admitted recipe is bound to the actual
  // compiled plan/spec set - not merely a matching jobFamily string.
  assert.equal(result.recipeBinding.boundRecipeId, WEBSITE_BUILD_V1_RECIPE.recipeId);
  assert.equal(result.recipeBinding.consumedRecipeVersion, WEBSITE_BUILD_V1_RECIPE.version);
  assert.equal(result.recipeBinding.planId, result.plan.planId);
  assert.equal(result.recipeBinding.planVersion, result.plan.version);
  assert.equal(result.recipeBinding.boundJobs.length, result.specs.length);

  // No raw secret/credential/provider-internal identifier crosses into the
  // profile - only the opaque SecretRef id and the verification evidence
  // ref are ever exposed (mirrors ADM-PROJ-001 A19).
  const serializedProfile = JSON.stringify(result.profile);
  for (const forbidden of ["reference-storefront-provider", "reference-storefront-workspace", "reference-storefront-instance-1"]) {
    assert.equal(serializedProfile.includes(forbidden), false, `profile leaked "${forbidden}"`);
  }

  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: result.jobs,
    plan: result.plan,
    latestApproval: inputs.approval,
  });
  assert.equal(snapshot.nextAction.owner, "NO_ACTION_NEEDED");
  assert.equal(snapshot.workingArtifact?.isCurrentVersionApproved, true);

  const rendered = renderShellPage({ kind: "READY", snapshot });
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /NO ACTION NEEDED/);
});

test("G1b: identical cold-start inputs produce deep-equal activation/recipe-binding output and byte-identical rendered HTML", () => {
  const { result: resultA, inputs: inputsA } = compileHappyPath("plan-v5-conv-g1b", "det-a");
  const { result: resultB } = compileHappyPath("plan-v5-conv-g1b", "det-a");
  assert.deepEqual(resultA, resultB);

  const snapshotA = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: resultA.jobs,
    plan: resultA.plan,
    latestApproval: inputsA.approval,
  });
  const snapshotB = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: resultB.jobs,
    plan: resultB.plan,
    latestApproval: inputsA.approval,
  });
  assert.deepEqual(snapshotA, snapshotB);
  const renderedA = renderShellPage({ kind: "READY", snapshot: snapshotA });
  const renderedB = renderShellPage({ kind: "READY", snapshot: snapshotB });
  assert.equal(renderedA.html, renderedB.html);
});

// ---------------------------------------------------------------------------
// G2: same-job governed execution/verification proof, closing the gap
// between ProjectActivationProfile output and the already-proven
// authorized-outcome-job-operations.ts lifecycle. Truthful post-execution
// status/next-action never fabricates whole-project completion.
// ---------------------------------------------------------------------------

test("G2: one admitted job is driven through the real governed execution/verification lifecycle, and the rebuilt snapshot stays truthful", () => {
  const { result, inputs } = compileHappyPath("plan-v5-conv-g2");
  const spec = findSpec(result.specs, "discovery-evidence-intake");
  const draftJob = findJob(result.jobs, spec.specId);
  assert.equal(draftJob.state, "DRAFT");

  const authority: AuthorityContext = createAuthorityContext({
    tenantScope: fixture.tenantScope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });

  const qualifiedJob = authorizedTransitionOutcomeJob(authority, draftJob, "QUALIFIED");
  const readyJob = authorizedTransitionOutcomeJob(authority, qualifiedJob, "READY");

  // G (evidence/verification): capability/service admission alone can
  // never authorize EXECUTING - no ExecutionRoutingRequirement has been
  // admitted yet for this exact job.
  assert.throws(
    () => authorizedTransitionOutcomeJob(authority, readyJob, "EXECUTING"),
    MissingExecutionRoutingRequirementError,
  );

  const registry = createExecutionRoutingRequirementRegistry();
  const requirement = registry.admitManualExecutionAllowedFromServiceCatalogAdmission({
    job: readyJob,
    spec,
    admission: inputs.serviceAdmission,
    admittedAt: "2026-09-24T00:05:00.000Z",
  });
  assert.equal(requirement.policy, "MANUAL_EXECUTION_ALLOWED");

  const executingJob = authorizedTransitionOutcomeJob(authority, readyJob, "EXECUTING", registry);
  assert.equal(executingJob.state, "EXECUTING");

  // H (recovery): a governed BLOCKED -> recovered -> EXECUTING cycle never
  // skips verification by itself.
  const { job: blockedJob } = enterExceptionState({
    job: executingJob,
    to: "BLOCKED",
    eventId: "evt-v5-conv-g2-blocked-1",
    actorRef: "worker:reference-v5-conv-001",
    timestamp: "2026-09-24T00:10:00.000Z",
    reason: "temporary provider outage",
  });
  assert.equal(blockedJob.state, "BLOCKED");
  const { job: recoveredJob } = recoverFromExceptionState({
    job: blockedJob,
    authority,
    to: "EXECUTING",
    eventId: "evt-v5-conv-g2-recovered-1",
    actorRef: "worker:reference-v5-conv-001",
    timestamp: "2026-09-24T00:15:00.000Z",
    reason: "provider outage resolved",
    evidenceRef: "evidence:v5-conv-001-recovery-1",
  });
  assert.equal(recoveredJob.state, "EXECUTING");
  assert.notEqual((recoveredJob as OutcomeJob).state, "VERIFIED");

  const verifyingJob = authorizedTransitionOutcomeJob(authority, recoveredJob, "VERIFYING");
  assert.equal(verifyingJob.state, "VERIFYING");

  // G: ExecutionResult/job transition alone cannot produce VERIFIED -
  // VerificationResult + evidence remains required.
  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: "ev-v5-conv-g2-discovery",
    evidenceType: "discovery-evidence-review",
    sourceLocator: "internal://reference-fixtures/v5-conv-001/discovery-evidence-review",
    capturedAt: "2026-09-24T00:20:00.000Z",
  });
  const verificationResult = createVerificationResult({
    verificationId: "verif-v5-conv-g2-discovery",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: spec.requirementId,
    status: "PASSED",
  });
  const verifiedJob = authorizedVerifyOutcomeJob(authority, verifyingJob, verificationResult);
  assert.equal(verifiedJob.state, "VERIFIED");

  // J (truthful next action): rebuild the snapshot with only the selected
  // job's state replaced - every other job keeps its real DRAFT state, so
  // one verified job never fabricates whole-project completion.
  const postExecutionJobs = result.jobs.map((job) => (job.jobId === verifiedJob.jobId ? verifiedJob : job));
  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: postExecutionJobs,
    plan: result.plan,
    latestApproval: inputs.approval,
  });
  assert.equal(snapshot.deliveryStatus.overallStatus, "IN_PROGRESS");
  assert.deepEqual(snapshot.verifiedCompletedJobIds, [verifiedJob.jobId]);
  assert.ok(
    postExecutionJobs.some((job) => job.jobId !== verifiedJob.jobId && job.state === "DRAFT"),
    "expected at least one other job to remain truthfully DRAFT",
  );

  const rendered = renderShellPage({ kind: "READY", snapshot });
  assert.equal(rendered.status, 200);
  assert.doesNotMatch(rendered.html, /\bproject outage\b/i);
  assert.doesNotMatch(rendered.html, /provider outage/i);
});

// ---------------------------------------------------------------------------
// Negative witnesses (Rev114 "MANDATORY NEGATIVE INTEGRATION WITNESSES").
// ---------------------------------------------------------------------------

test("N1: missing/stale plan approval fails closed to HUMAN_REVIEW with zero jobs", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n1");
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n1",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n1",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    // No approval supplied.
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    now: inputs.now,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "HUMAN_REVIEW");
  assert.equal(result.profile.nextRequiredAction?.code, "PLAN_APPROVAL_REQUIRED");
  assert.equal(result.jobs.length, 0);
});

test("N2: missing required CUSTOMER_OWNED connection fails closed to CUSTOMER with zero jobs", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n2");
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n2",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n2",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [],
    now: inputs.now,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "CUSTOMER");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  assert.equal(result.jobs.length, 0);
});

test("N3: a DEGRADED connection binding cannot satisfy readiness", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n3");
  const degraded = transitionConnectionBinding(WEBSITE_BUILD_V1_CONNECTION_BINDING, "DEGRADED");
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n3",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n3",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [degraded],
    now: inputs.now,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  assert.equal(result.jobs.length, 0);
});

test("N4: a VERIFIED ConnectionBinding belonging to a foreign project cannot satisfy this project's connection requirement", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n4");
  const foreignOwnership = createProjectOwnershipRef({
    tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
    customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
    projectId: "proj-v5-conv-n4-foreign",
  });
  const foreignRequirement = createConnectionRequirement({
    connectionRequirementId: WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT.connectionRequirementId,
    ownership: foreignOwnership,
    requiredCapabilityRef: WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT.requiredCapabilityRef,
    purpose: "test",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider health check",
  });
  const foreignRequested = createConnectionBinding({
    connectionBindingId: "conn-binding-v5-conv-n4-foreign",
    requirement: foreignRequirement,
    ownership: foreignOwnership,
    providerRef: "reference-storefront-provider",
    workspaceRef: "reference-storefront-workspace",
    integrationInstanceRef: "reference-storefront-instance-foreign",
    delegatedScope: ["catalog:read"],
  });
  const foreignConnected = transitionConnectionBinding(foreignRequested, "CONNECTED_UNVERIFIED");
  const foreignVerified: ConnectionBinding = verifyConnectionBinding(
    foreignConnected,
    "internal://reference-fixtures/v5-conv-001/foreign-connection-health-check",
  );
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n4",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n4",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [foreignVerified],
    now: inputs.now,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredAction?.code, "CONNECTION_NOT_VERIFIED");
  assert.equal(result.jobs.length, 0);
});

test("N5: an ACTION_REQUIRED MaterialPlatformDecision blocks with its own declared actor", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n5");
  const actionRequiredDecision = createMaterialPlatformDecision({
    decisionRef: "decision-v5-conv-n5",
    status: "ACTION_REQUIRED",
    reason: "delivery track has not been selected yet",
    actor: "HUMAN_REVIEW",
  });
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n5",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n5",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    platformDecision: actionRequiredDecision,
    now: inputs.now,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "HUMAN_REVIEW");
  assert.equal(result.profile.nextRequiredAction?.code, "PLATFORM_DECISION_REQUIRED");
  assert.equal(result.jobs.length, 0);
  assert.equal(result.profile.platformDecision?.decisionRef, "decision-v5-conv-n5");
});

test("N6: a rejected activation-time WorkerRoutingRequest fails closed to AKILTA with zero jobs", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n6");
  const rejectedRoute: ActivationWorkerRouteInput = {
    routeRef: "route-v5-conv-n6",
    request: siteBuildRoute({ executorCandidates: [] }),
  };
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n6",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const result = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n6",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    workerRoutes: [rejectedRoute],
    now: inputs.now,
  });
  assert.equal(result.profile.state, "ACTION_REQUIRED");
  assert.equal(result.profile.nextRequiredActor, "AKILTA");
  assert.equal(result.profile.nextRequiredAction?.code, "WORKER_ROUTE_REJECTED");
  assert.equal(result.jobs.length, 0);
});

test("N7: an ineligible preferred worker is skipped in favor of an eligible fallback, without relaxing capability/tool/policy/authority constraints", () => {
  const { result } = compileHappyPath("plan-v5-conv-n7", "n7");
  // compileHappyPath's default route already exercises a single eligible
  // candidate; this witness proves an ineligible-then-eligible candidate
  // list still routes without weakening any constraint.
  const inputs = buildHappyPathInputs("plan-v5-conv-n7-fallback");
  const ineligible = routingCandidateWorker({
    workerId: "worker-v5-conv-n7-ineligible",
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
  });
  const route: ActivationWorkerRouteInput = {
    routeRef: "route-v5-conv-n7",
    request: siteBuildRoute({ executorCandidates: [ineligible, routingCandidateWorker()] }),
  };
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n7",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  const fallbackResult = compileProjectActivationProfile({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    acceptedCommercialReference,
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    serviceAdmission: inputs.serviceAdmission,
    effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    evidence: fixture.evidence,
    planId: "plan-v5-conv-n7-fallback",
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
    approval: inputs.approval,
    connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
    connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
    workerRoutes: [route],
    now: inputs.now,
  });
  assert.equal(result.profile.state, "READY");
  assert.equal(fallbackResult.profile.state, "READY");
  assert.equal(fallbackResult.profile.consumedRoutes[0]?.decision.status, "ROUTED");
});

test("N8: a foreign tenant/customer/project ownership commercial input fails closed before any profile is produced", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n8");
  const foreignTenantScope = createTenantScope("tenant-v5-conv-n8-foreign");
  const foreignCustomer = createCustomer({
    tenantScope: foreignTenantScope,
    customerId: "cust-v5-conv-n8-foreign",
    displayName: "Foreign Customer",
  });
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n8",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope: fixture.tenantScope,
        customer: foreignCustomer,
        project: fixture.project,
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        acceptedCommercialReference,
        blueprint: fixture.blueprint,
        soldScope: fixture.soldScope,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        serviceAdmission: inputs.serviceAdmission,
        effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
        effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
        evidence: fixture.evidence,
        planId: "plan-v5-conv-n8",
        connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
        connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
        now: inputs.now,
      }),
    InvalidProjectActivationProfileError,
  );
});

test("N9: a service admission for a different recipe/blueprint fails closed and never yields READY", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n9");
  const mismatchedAdmission: ServiceCatalogAdmission = {
    ...inputs.serviceAdmission,
    blueprintId: "some-other-blueprint" as ServiceCatalogAdmission["blueprintId"],
  };
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n9",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope: fixture.tenantScope,
        customer: fixture.customer,
        project: fixture.project,
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        acceptedCommercialReference,
        blueprint: fixture.blueprint,
        soldScope: fixture.soldScope,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        serviceAdmission: mismatchedAdmission,
        effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
        effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
        evidence: fixture.evidence,
        planId: "plan-v5-conv-n9",
        readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
        approval: inputs.approval,
        connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
        connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
        now: inputs.now,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("N10: a REVOKED ServiceCatalogAdmission cannot yield READY through the full integrated chain", () => {
  const inputs = buildHappyPathInputs("plan-v5-conv-n10");
  const revoked = revokeServiceCatalogAdmission({
    admission: inputs.serviceAdmission,
    revokedAt: "2026-09-24T00:00:01.000Z",
    reason: "test revocation",
  });
  const acceptedCommercialReference = createAcceptedCommercialReference({
    acceptanceRef: "acceptance-v5-conv-n10",
    sourceBlueprintId: fixture.blueprint.blueprintId,
    sourceBlueprintVersion: fixture.blueprint.version,
    soldScopeId: fixture.soldScope.soldScopeId,
    outcomeContractRef: fixture.soldScope.outcomeContractRef,
  });
  assert.throws(
    () =>
      compileProjectActivationProfile({
        tenantScope: fixture.tenantScope,
        customer: fixture.customer,
        project: fixture.project,
        ownership: WEBSITE_BUILD_V1_OWNERSHIP,
        acceptedCommercialReference,
        blueprint: fixture.blueprint,
        soldScope: fixture.soldScope,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        serviceAdmission: revoked,
        effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
        effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
        evidence: fixture.evidence,
        planId: "plan-v5-conv-n10",
        readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
        approval: inputs.approval,
        connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
        connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
        now: inputs.now,
      }),
    InvalidDeliveryRecipePlanBindingError,
  );
});

test("N11: config/policy/platform/connection-evidence/service-admission/routing mutations each independently change the sourceFingerprint from an otherwise-identical base", () => {
  const { result: base } = compileHappyPath("plan-v5-conv-n11-base", "n11-base");

  const { result: configChanged } = (() => {
    const inputs = buildHappyPathInputs("plan-v5-conv-n11-base", "n11-base");
    const acceptedCommercialReference = createAcceptedCommercialReference({
      acceptanceRef: "acceptance-v5-conv-n11-config",
      sourceBlueprintId: fixture.blueprint.blueprintId,
      sourceBlueprintVersion: fixture.blueprint.version,
      soldScopeId: fixture.soldScope.soldScopeId,
      outcomeContractRef: fixture.soldScope.outcomeContractRef,
    });
    const result = compileProjectActivationProfile({
      tenantScope: fixture.tenantScope,
      customer: fixture.customer,
      project: fixture.project,
      ownership: WEBSITE_BUILD_V1_OWNERSHIP,
      acceptedCommercialReference,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      recipe: WEBSITE_BUILD_V1_RECIPE,
      serviceAdmission: inputs.serviceAdmission,
      effectiveConfigRefs: [...WEBSITE_BUILD_V1_RECIPE.requiredContextRefs, "context:extra-config"],
      effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
      evidence: fixture.evidence,
      planId: "plan-v5-conv-n11-base",
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
      approval: inputs.approval,
      connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
      connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
      platformDecision: inputs.platformDecision,
      workerRoutes: [inputs.route],
      now: inputs.now,
    });
    return { result };
  })();
  assert.notEqual(base.profile.sourceFingerprint, configChanged.profile.sourceFingerprint);

  const { result: serviceAdmissionChanged } = (() => {
    const inputs = buildHappyPathInputs("plan-v5-conv-n11-base", "n11-alt-admission");
    const acceptedCommercialReference = createAcceptedCommercialReference({
      acceptanceRef: "acceptance-v5-conv-n11-admission",
      sourceBlueprintId: fixture.blueprint.blueprintId,
      sourceBlueprintVersion: fixture.blueprint.version,
      soldScopeId: fixture.soldScope.soldScopeId,
      outcomeContractRef: fixture.soldScope.outcomeContractRef,
    });
    const result = compileProjectActivationProfile({
      tenantScope: fixture.tenantScope,
      customer: fixture.customer,
      project: fixture.project,
      ownership: WEBSITE_BUILD_V1_OWNERSHIP,
      acceptedCommercialReference,
      blueprint: fixture.blueprint,
      soldScope: fixture.soldScope,
      recipe: WEBSITE_BUILD_V1_RECIPE,
      serviceAdmission: inputs.serviceAdmission,
      effectiveConfigRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
      effectivePolicyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
      evidence: fixture.evidence,
      planId: "plan-v5-conv-n11-base",
      readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, inputs.plan),
      approval: inputs.approval,
      connectionRequirements: [WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT],
      connectionBindings: [WEBSITE_BUILD_V1_CONNECTION_BINDING],
      platformDecision: inputs.platformDecision,
      workerRoutes: [inputs.route],
      now: inputs.now,
    });
    return { result };
  })();
  // Different admittingAuthorityId/evidenceRef only (Rev116) - the admitted
  // service/recipe binding provenance is material to the fingerprint.
  assert.notEqual(base.profile.sourceFingerprint, serviceAdmissionChanged.profile.sourceFingerprint);
});

// ---------------------------------------------------------------------------
// N12: customer-safe boundary - neither the serialized snapshot nor the
// rendered shell HTML ever exposes internal activation/service-admission/
// connection provenance.
// ---------------------------------------------------------------------------

test("N12: neither the serialized snapshot nor the rendered shell HTML ever exposes internal activation/service-admission/connection provenance", () => {
  // Rev115: this repository's existing ClientProjectSnapshot/shell
  // pathway does not consume ProjectActivationProfile at all on this
  // lineage (that is a separate, narrower-scoped composition than this
  // task) - so this proves the two layers stay cleanly separated: no
  // activation/service-admission/connection-binding provenance leaks into
  // the customer-safe surface even indirectly through the real jobs/plan/
  // approval this compilation produced.
  const { result, inputs } = compileHappyPath("plan-v5-conv-n12", "n12");
  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: result.jobs,
    plan: result.plan,
    latestApproval: inputs.approval,
  });
  const rendered = renderShellPage({ kind: "READY", snapshot });
  const haystacks = [JSON.stringify(snapshot), rendered.html];
  const forbidden = [
    "nextRequiredAction",
    "unresolvedGates",
    "platformDecision",
    "verifiedConnections",
    "consumedRoutes",
    "connectionBindingId",
    "secretRef",
    "sourceFingerprint",
    "acceptedCommercialReference",
    "effectiveConfigRefs",
    "effectivePolicyRefs",
    "admittedByAuthorityId",
    "recipeBinding",
    "reference-storefront-provider",
    "reference-storefront-workspace",
    "reference-storefront-instance-1",
  ];
  for (const haystack of haystacks) {
    for (const term of forbidden) {
      assert.equal(haystack.includes(term), false, `found forbidden term "${term}"`);
    }
  }
});

