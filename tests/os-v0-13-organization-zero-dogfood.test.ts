import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership, createAssignmentReference } from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import {
  requireInternalOsAccess,
  requireInternalOsProjectAccess,
  type StaffAccessGrant,
} from "../src/web/internal-os-access.js";

import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import { createSoldScope } from "../src/domain/sold-scope.js";
import { createDeliveryRecipe } from "../src/domain/delivery-recipe.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { createCustomerEvidenceItem } from "../src/domain/customer-evidence.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitServiceCatalogEntry, type ServiceCatalogAdmission } from "../src/domain/service-catalog-admission.js";
import type { ServiceCatalogEntry } from "../src/domain/commercial-order.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import {
  compileProjectActivationProfile,
  createAcceptedCommercialReference,
} from "../src/domain/project-activation-profile.js";

import { transitionOutcomeJob, verifyOutcomeJob } from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult, type VerificationResult } from "../src/domain/verification-result.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import {
  composeTaskPacketForOutcomeJob,
  resolveNextRunnableGoldenPathAction,
} from "../src/domain/outcome-job-golden-path-composition.js";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";
import { FileDurableOutcomeJobExecutionStore } from "../src/domain/durable-outcome-job-execution-store.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  type QuotaEnvelope,
} from "../src/domain/execution-quota-admission.js";
import {
  dispatchOutcomeJobExecutionRun,
  recordExecutionResult,
  advanceOutcomeJobAfterExecutionSuccess,
  type ExecutionEconomicsPort,
  type CurrentQuotaEnvelopeResolver,
} from "../src/application/outcome-job-execution-runtime.js";
import {
  appendExecutionEconomicsEventAllowingCapturedAtDrift,
  EMPTY_EXECUTION_ECONOMICS_LEDGER,
  type ExecutionEconomicsEvent,
  type ExecutionEconomicsLedger,
} from "../src/domain/execution-economics-attribution.js";

import {
  bootstrapOrganizationResourceBinding,
  FileDurableOrganizationResourceBindingStore,
} from "../src/domain/durable-organization-resource-binding-store.js";
import { resolveOrganizationResourceBindingStatus } from "../src/domain/organization-resource-binding.js";

import { createConnectionRequirement, createConnectionBinding, createSecretRef, verifyConnectionBinding } from "../src/domain/connection-authority.js";
import { transitionConnectorConnection, verifyConnectorConnection, type ConnectorConnectionInstance } from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { mutateConnectorConnectionStateAsAuthenticatedAdmin } from "../src/web/connector-connection-admin-access.js";
import {
  executeConnectorCapability,
  ConnectorExecutionNotAuthorizedError,
  type SecretResolver,
  type ConnectorTransport,
} from "../src/domain/connector-execution.js";

type BoundConnectorDefinition = Parameters<typeof executeConnectorCapability>[0]["bound"];
import { createGenericApiConnectorDefinition } from "../src/domain/generic-connector-definition.js";
import { executeConnectorCapabilityAsVerifiedEffect } from "../src/domain/connector-capability-verified-effect.js";

import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import type { OrganizationResourceBindingSource, OperationalObservabilitySource } from "../src/web/internal-os-view-state.js";
import { composeOperationalObservabilityView } from "../src/domain/operational-observability-view.js";

/**
 * OS-V0-13 "Organization Zero Dogfood" (Brain Rev196): the SAME already-
 * accepted OS-V0-09/10/11/12 owners, proven for Organization Zero's own
 * real identity (`org_akilta`, not a disposable per-test label) against
 * DURABLE canonical file-store state - not the in-memory fixtures every
 * prior OS-V0-10 test correctly used to prove logical correctness. Zero
 * new domain/application/web code is introduced; this file is a pure
 * integration/dogfood proof layer.
 */
const ORG_ZERO_TENANT_SCOPE = createTenantScope("t-akilta");
const ORG_ZERO_CUSTOMER = createCustomer({
  tenantScope: ORG_ZERO_TENANT_SCOPE,
  customerId: "c-akilta",
  displayName: "AKILTA (Organization Zero)",
});
const ORG_ZERO_PROJECT = createProject({
  tenantScope: ORG_ZERO_TENANT_SCOPE,
  customer: ORG_ZERO_CUSTOMER,
  projectId: "p-akilta-web",
  ownerRef: "akilta-digital-operations",
  state: "active",
});
const ORG_ZERO_OWNERSHIP = createProjectOwnershipRef({
  tenantId: ORG_ZERO_TENANT_SCOPE.tenantId,
  customerId: ORG_ZERO_CUSTOMER.customerId,
  projectId: ORG_ZERO_PROJECT.projectId,
});
const ORGANIZATION_ZERO: Organization = activateOrganization({
  organization: createOrganization({
    organizationId: "org_akilta",
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    displayName: "AKILTA",
    createdAt: "2026-10-06T00:00:00.000Z",
  }),
  activatedAt: "2026-10-06T00:00:01.000Z",
});

const ORG_ZERO_BLUEPRINT = createOfferBlueprintVersion({
  blueprintId: "bp-akilta-web",
  version: "1.0.0",
  requirements: [
    {
      requirementId: "req-akilta-web",
      description: "Operate and maintain the AKILTA marketing website and digital operations surface for Organization Zero",
      necessity: "REQUIRED",
      dependsOn: [],
    },
  ],
});
const ORG_ZERO_RECIPE = createDeliveryRecipe({
  recipeId: "recipe-akilta-web",
  version: 1,
  jobFamily: ORG_ZERO_BLUEPRINT.blueprintId,
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

function elevatedAdmittingWorker(): AdmittedWorker {
  return {
    workerId: "worker-org-zero-admitting",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence://worker-org-zero-admitting",
  };
}

function buildOrgZeroServiceAdmission(): ServiceCatalogAdmission {
  const catalogEntry: ServiceCatalogEntry = {
    serviceRef: `service-${ORG_ZERO_BLUEPRINT.blueprintId}`,
    blueprintId: ORG_ZERO_BLUEPRINT.blueprintId,
    blueprintVersion: ORG_ZERO_BLUEPRINT.version,
    recipeId: ORG_ZERO_RECIPE.recipeId,
    executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
  };
  return admitServiceCatalogEntry({
    catalogEntry,
    recipe: ORG_ZERO_RECIPE,
    authorizingWorker: elevatedAdmittingWorker(),
    evidenceRef: "evidence://os-v0-13-service-admission",
    admittedAt: "2026-10-06T00:00:00.000Z",
  });
}

/**
 * Compiles one genuinely-real, READY `ProjectActivationProfile` (plus its
 * paired `OutcomeJobSpec`/`OutcomeJob`) for Organization Zero's own real
 * identity, via the actual, unmodified `compileProjectActivationProfile` -
 * mirroring `tests/helpers/golden-path-fixture.ts`'s own established
 * pattern exactly, never a literal-constructed fixture, never a second
 * compiler.
 */
function compileOrgZeroActivation(planId: string, soldScopeId: string) {
  const soldScope = createSoldScope({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    project: ORG_ZERO_PROJECT,
    soldScopeId,
    outcomeContractRef: `contract-${soldScopeId}`,
  });
  const plan = compilePlan({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    project: ORG_ZERO_PROJECT,
    planId,
    blueprint: ORG_ZERO_BLUEPRINT,
    soldScope,
    now: "2026-10-06T00:00:00.000Z",
  });
  return compileProjectActivationProfile({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    customer: ORG_ZERO_CUSTOMER,
    project: ORG_ZERO_PROJECT,
    ownership: ORG_ZERO_OWNERSHIP,
    acceptedCommercialReference: createAcceptedCommercialReference({
      acceptanceRef: `acceptance-${soldScopeId}`,
      sourceBlueprintId: ORG_ZERO_BLUEPRINT.blueprintId,
      sourceBlueprintVersion: ORG_ZERO_BLUEPRINT.version,
      soldScopeId: soldScope.soldScopeId,
      outcomeContractRef: soldScope.outcomeContractRef,
    }),
    blueprint: ORG_ZERO_BLUEPRINT,
    soldScope,
    recipe: ORG_ZERO_RECIPE,
    serviceAdmission: buildOrgZeroServiceAdmission(),
    effectiveConfigRefs: [],
    effectivePolicyRefs: [],
    readinessAssertions: buildOrgZeroReadinessAssertions(plan),
    approval: createApprovalReference({
      plan,
      approvalId: `approval-${planId}`,
      approvedAt: "2026-10-06T00:00:00.000Z",
      approverRef: "reviewer-org-zero",
    }),
    planId,
    now: "2026-10-06T00:00:00.000Z",
  });
}

function buildOrgZeroReadinessAssertions(plan: ReturnType<typeof compilePlan>) {
  return plan.nodes
    .filter((node) => node.disposition === "REQUIRED")
    .map((node) => ({
      evidence: createCustomerEvidenceItem({
        tenantScope: ORG_ZERO_TENANT_SCOPE,
        project: ORG_ZERO_PROJECT,
        evidenceRef: `ev-readiness-${node.requirementId}-v${plan.version}`,
        kind: "FACT" as const,
        subject: `Readiness confirmed for ${node.requirementId}`,
        sourceLocator: `internal://org-zero-dogfood/readiness/${node.requirementId}`,
        relatedRequirementId: node.requirementId,
      }),
      assertedForPlanVersion: plan.version,
      readinessOutcome: "SATISFIED" as const,
    }));
}

/**
 * The real authenticated staff ingress chain (`StaffSessionProvider` ->
 * `requireInternalOsAccess` -> `resolveEffectiveOrganizationAccess`), for
 * Organization Zero's own real identity - never a bare caller-constructed
 * `AuthorityContext`/`EffectiveAccessResolution`. Carries a curated OWNER
 * `roleContext` so the SAME principal can also exercise Golden B's
 * authenticated admin-mutation boundary (which requires OWNER/ADMIN,
 * never a bare MEMBER resolution).
 */
function foundingPrincipalContext() {
  const membership = createOrganizationMembership({
    membershipId: "membership-org-zero-founder",
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    principalRef: "principal-org-zero-founder",
    role: "STAFF",
  });
  const assignment = createAssignmentReference({
    assignmentId: "assignment-org-zero-founder",
    membership,
    customerId: ORG_ZERO_CUSTOMER.customerId,
    projectId: ORG_ZERO_PROJECT.projectId,
  });
  const authority = createAuthorityContext({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    permissions: ["EXECUTE", "WRITE", "READ"],
    canPerformProtectedActions: true,
  });
  const principal = createAuthenticatedStaffPrincipal({
    principalId: "principal-org-zero-founder",
    displayName: "Organization Zero Founding Principal",
  });
  const sessionToken = "token-org-zero-founder";
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-06T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const roleContext = createOrganizationAccessRoleContext({ membership, role: "OWNER" });
  const grant: StaffAccessGrant = { membership, authority, assignments: [assignment], roleContext };

  const internalOsAccess = requireInternalOsAccess({
    provider,
    sessionToken,
    organization: ORGANIZATION_ZERO,
    grants: [grant],
  });

  return { membership, authority, principal, provider, sessionToken, grant, internalOsAccess };
}

function bootstrapRealResourceBinding(baseDir: string, membership: ReturnType<typeof foundingPrincipalContext>["membership"]) {
  const store = new FileDurableOrganizationResourceBindingStore(baseDir);
  const bootstrap = bootstrapOrganizationResourceBinding({
    store,
    organization: ORGANIZATION_ZERO,
    memberships: [membership],
    project: ORG_ZERO_PROJECT,
    ownership: ORG_ZERO_OWNERSHIP,
    boundAt: "2026-10-06T00:00:02.000Z",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding: bootstrap.binding,
    organization: ORGANIZATION_ZERO,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: ORG_ZERO_PROJECT,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  return { bootstrap, status };
}

class InMemoryExecutionEconomicsStore implements ExecutionEconomicsPort {
  private ledger: ExecutionEconomicsLedger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  recordSettledAttempt(event: ExecutionEconomicsEvent): void {
    this.ledger = appendExecutionEconomicsEventAllowingCapturedAtDrift(this.ledger, event);
  }
}

function acceptingInvoker(callLog: unknown[]): WorkerInvoker {
  return {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async (input) => {
      callLog.push(input.outcomeJobExecution);
      return { accepted: true };
    },
  };
}

// --- Golden A: real org_akilta Website/Digital Operations outcome, durable canonical state end to end ---

test("OS-V0-13 Golden A: real org_akilta principal + READY resource binding + real activation/plan/OutcomeJob -> TaskPacket -> durable dispatch -> SUCCEEDED -> VERIFYING -> independent verification -> VERIFIED -> CLOSE_JOB", async () => {
  const { membership, authority, internalOsAccess } = foundingPrincipalContext();
  assert.equal(internalOsAccess.access.decision, "GRANTED");
  const projectAccess = requireInternalOsProjectAccess({ organization: ORGANIZATION_ZERO, context: internalOsAccess, project: ORG_ZERO_PROJECT });
  assert.equal(projectAccess.decision, "GRANTED");

  const bindingDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-binding-"));
  const { status } = bootstrapRealResourceBinding(bindingDir, membership);
  assert.equal(status.state, "READY");

  const compilation = compileOrgZeroActivation("plan-a", "sold-a");
  assert.equal(compilation.profile.state, "READY");
  const wiredJob = compilation.jobs[0]!;
  assert.equal(wiredJob.jobFamily, "req-akilta-web");
  assert.equal(wiredJob.businessObjective, "Operate and maintain the AKILTA marketing website and digital operations surface for Organization Zero");
  const spec = compilation.specs.find((candidate) => (candidate.specId as unknown as string) === (wiredJob.jobId as unknown as string))!;

  const jobDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-jobs-"));
  const jobStore = new FileDurableOutcomeJobStore(jobDir);
  const admission = jobStore.putIfAbsent(wiredJob);
  assert.equal(admission.created, true);

  const readyJob = transitionOutcomeJob(transitionOutcomeJob(wiredJob, "QUALIFIED"), "READY");
  const packet = composeTaskPacketForOutcomeJob({
    job: readyJob,
    spec,
    activation: compilation.profile,
    projectOwnership: ORG_ZERO_OWNERSHIP,
    baseIdentity: "sha-org-zero-dogfood-a",
    acceptanceCriteria: ["the AKILTA website/digital-operations requirement is satisfied for Organization Zero"],
  });
  assert.equal(packet.nextAuthorizedAction.startsWith("AKILTA:DISPATCH_EXECUTION"), true);

  const executingJob = transitionOutcomeJob(readyJob, "EXECUTING");
  const quotaScope = createQuotaAdmissionScope({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    customerId: ORG_ZERO_CUSTOMER.customerId,
    projectId: ORG_ZERO_PROJECT.projectId,
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
    scope: quotaScope,
    envelopeRef: "envelope-org-zero-dogfood-a",
    sourceFingerprint: "qfp-org-zero-dogfood-a",
    unitLimit: 1_000_000,
  });
  const quotaDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-quota-"));
  const quotaAdmission = new FileDurableQuotaReservationStore(quotaDir);
  const economicsPort = new InMemoryExecutionEconomicsStore();
  const execDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-exec-"));
  const eventStore = new FileDurableOutcomeJobExecutionStore(execDir);
  const quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver = { resolveCurrentQuotaEnvelope: () => quotaEnvelope };
  const callLog: unknown[] = [];
  const invoker = acceptingInvoker(callLog);

  const dispatchResult = await dispatchOutcomeJobExecutionRun({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    customer: ORG_ZERO_CUSTOMER,
    project: ORG_ZERO_PROJECT,
    job: executingJob,
    authority,
    runId: "run-a",
    correlationId: "corr-org-zero-dogfood-a",
    now: "2026-10-06T00:00:03.000Z",
    executorKind: "INJECTED",
    expectedFingerprint: compilation.profile.sourceFingerprint,
    currentFingerprint: compilation.profile.sourceFingerprint,
    currentActivationPlanId: compilation.profile.planId,
    currentActivationPlanVersion: compilation.profile.planVersion,
    economicsPort,
    economicsTaskRef: "task-ref-org-zero-dogfood-a",
    economicsUsageSource: "OTHER_ADMITTED",
    taskId: "task-org-zero-dogfood-a",
    branch: "claude/os-v0-13-organization-zero-dogfood",
    checkpointSha: "sha-org-zero-dogfood-a",
    quotaAdmission,
    quotaEnvelope,
    currentQuotaSourceFingerprint: "qfp-org-zero-dogfood-a",
    quotaEnvelopeResolver,
    estimatedCost: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" },
    store: eventStore,
    invoker,
  });
  assert.equal(dispatchResult.invoked, true);
  assert.equal(callLog.length, 1);

  const succeededState = await recordExecutionResult({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    customer: ORG_ZERO_CUSTOMER,
    project: ORG_ZERO_PROJECT,
    job: executingJob,
    currentState: dispatchResult.state,
    now: "2026-10-06T00:00:10.000Z",
    type: "SUCCEEDED",
    store: eventStore,
  });
  const afterSuccessAction = resolveNextRunnableGoldenPathAction({ job: executingJob, activation: compilation.profile, executionState: succeededState });
  assert.equal(afterSuccessAction.code, "ADVANCE_TO_VERIFYING");

  const succeededJob = advanceOutcomeJobAfterExecutionSuccess(executingJob, succeededState);
  assert.equal(succeededJob.state, "VERIFYING");

  const evidence = createEvidenceReference({
    job: succeededJob,
    evidenceId: "ev-org-zero-dogfood-a-1",
    evidenceType: "TEST_RESULT",
    sourceLocator: "internal://org-zero-dogfood/golden-a",
    capturedAt: "2026-10-06T00:00:20.000Z",
  });
  const verification: VerificationResult = createVerificationResult({
    verificationId: "verif-org-zero-dogfood-a-1",
    job: succeededJob,
    evidence,
    verificationRequirementRef: "req-akilta-web",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(succeededJob, verification);
  assert.equal(verifiedJob.state, "VERIFIED");

  const closeAction = resolveNextRunnableGoldenPathAction({ job: verifiedJob, activation: compilation.profile });
  assert.equal(closeAction.code, "CLOSE_JOB");

  // --- restart/replay: fresh store instances pointed at the SAME durable
  // directories must reconstruct the identical run truth without any
  // second dispatch (callLog stays at exactly 1 invocation).
  const restartedEventStore = new FileDurableOutcomeJobExecutionStore(execDir);
  const restartedState = restartedEventStore.getState(
    ORG_ZERO_TENANT_SCOPE.tenantId,
    ORG_ZERO_CUSTOMER.customerId,
    ORG_ZERO_PROJECT.projectId,
    executingJob.jobId,
    "run-a",
  );
  assert.deepEqual(restartedState, succeededState);

  const restartedJobStore = new FileDurableOutcomeJobStore(jobDir);
  const restartedAdmittedJob = restartedJobStore.get(ORG_ZERO_TENANT_SCOPE.tenantId, wiredJob.jobId);
  assert.deepEqual(restartedAdmittedJob, wiredJob);

  const restartedCloseAction = resolveNextRunnableGoldenPathAction({ job: verifiedJob, activation: compilation.profile, executionState: restartedState });
  assert.equal(restartedCloseAction.code, "CLOSE_JOB");
  assert.equal(callLog.length, 1);
});

// --- Golden B: real org_akilta VERIFIED connection, authenticated REVOKED admin mutation, queued-attempt currentness ---

function buildOrgZeroConnectionInstance(secretRefId: string): ConnectorConnectionInstance {
  const requirement = createConnectionRequirement({
    connectionRequirementId: "creq-akilta-primary-workspace",
    ownership: ORG_ZERO_OWNERSHIP,
    requiredCapabilityRef: "cap-akilta-generic-read",
    purpose: "Operate AKILTA's own primary workspace connection for Organization Zero",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: ["read:files"],
    connectionMethod: "OAUTH2",
    validationRequirement: "verified-oauth-handshake",
  });
  const binding = createConnectionBinding({
    connectionBindingId: "conn-akilta-primary-workspace",
    requirement,
    ownership: ORG_ZERO_OWNERSHIP,
    providerRef: "GENERIC_CUSTOM_API",
    workspaceRef: "workspace-akilta-primary",
    integrationInstanceRef: "integration-akilta-primary",
    delegatedScope: ["read:files"],
    secretRef: createSecretRef({ secretRefId }),
  });
  return { binding, connectorKind: "GENERIC_CUSTOM_API", authMode: "API_KEY" };
}

function buildOrgZeroConnectorBound(instance: ConnectorConnectionInstance): BoundConnectorDefinition {
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: instance.binding.connectionBindingId,
    baseUrl: "https://internal-dogfood.akilta.test",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap-akilta-generic-read", method: "GET", path: "/files" }],
  });
  return { instance, definition };
}

test("OS-V0-13 Golden B: a real org_akilta VERIFIED connection is authentically mutated to REVOKED by an OWNER-authenticated admin; a queued/subsequent connector attempt flips from succeeding to zero-effect fail-closed; durable restart confirms current truth with historical evidence preserved", async () => {
  const { provider, sessionToken, grant } = foundingPrincipalContext();

  let instance = buildOrgZeroConnectionInstance("secret-ref-akilta-primary-workspace-placeholder");
  const connDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-connections-"));
  const connectionStore = new FileDurableConnectorConnectionStore(connDir);
  let stored = connectionStore.save(instance);
  assert.equal(stored.version, 1);
  assert.equal(stored.instance.binding.connectionState, "REQUESTED");

  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  stored = connectionStore.save(instance, stored.version);
  instance = verifyConnectorConnection(instance, "evidence://org-zero-dogfood/connection-verified-1");
  stored = connectionStore.save(instance, stored.version);
  assert.equal(stored.instance.binding.connectionState, "VERIFIED");
  const verificationEvidenceRef = stored.instance.binding.verificationEvidenceRef;
  assert.equal(verificationEvidenceRef, "evidence://org-zero-dogfood/connection-verified-1");

  const bound = buildOrgZeroConnectorBound(stored.instance);
  const secretResolver: SecretResolver = { resolve: () => "resolved-dogfood-secret-value" };
  let transportCallCount = 0;
  const transport: ConnectorTransport = {
    execute: () => {
      transportCallCount += 1;
      return { outcome: "SUCCESS", data: { ok: true } };
    },
  };

  // A "queued reference" succeeds while the current durable record is VERIFIED.
  const preRevokeResult = executeConnectorCapability({
    bound,
    capabilityRef: "cap-akilta-generic-read",
    requestingOwnership: ORG_ZERO_OWNERSHIP,
    connectionStore,
    secretResolver,
    transport,
  });
  assert.equal(preRevokeResult.connectionBindingId, stored.instance.binding.connectionBindingId);
  assert.equal(transportCallCount, 1);

  // The real, OWNER-authenticated admin boundary - never a raw domain
  // transition with no authenticated staff/session binding.
  const afterRevoke = mutateConnectorConnectionStateAsAuthenticatedAdmin({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    organization: ORGANIZATION_ZERO,
    provider,
    sessionToken,
    grants: [grant],
    store: connectionStore,
    connectionBindingId: stored.instance.binding.connectionBindingId,
    to: "REVOKED",
  });
  assert.equal(afterRevoke.instance.binding.connectionState, "REVOKED");
  assert.equal(afterRevoke.instance.binding.verificationEvidenceRef, verificationEvidenceRef, "REVOKED preserves prior verification evidence - historical provenance is never deleted by a lifecycle demotion");

  // The exact SAME queued reference now fails closed with ZERO transport
  // invocation - the connection's CURRENT durable state, not the caller's
  // stale snapshot, governs authorization.
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap-akilta-generic-read",
        requestingOwnership: ORG_ZERO_OWNERSHIP,
        connectionStore,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transportCallCount, 1, "the transport must never be invoked a second time once the current durable record is REVOKED");

  // Restart/replay: a fresh store instance pointed at the SAME durable
  // directory reconstructs the identical REVOKED truth.
  const restartedStore = new FileDurableConnectorConnectionStore(connDir);
  const restarted = restartedStore.get(ORG_ZERO_TENANT_SCOPE.tenantId, stored.instance.binding.connectionBindingId);
  assert.equal(restarted?.instance.binding.connectionState, "REVOKED");
  assert.equal(restarted?.instance.binding.verificationEvidenceRef, verificationEvidenceRef);
});

// --- Golden C: no already-admitted controlled/non-production connection-backed surface exists; drive to the exact pre-effect boundary ---

test("OS-V0-13 Golden C: no production ConnectorTransport implementation exists anywhere in src/ - no already-admitted controlled/non-production connection-backed surface can satisfy Golden C without fabricating one", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcDir = join(repoRoot, "src");
  const offenders: string[] = [];

  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const content = readFileSync(fullPath, "utf8");
      // The interface itself (`connector-execution.ts`) and its two
      // existing consumers are expected to reference the TYPE; a concrete
      // implementing object/class (`implements ConnectorTransport` or an
      // object literal assigned to a `ConnectorTransport`-typed variable)
      // is what would constitute a real adapter - none exists.
      if (/implements\s+ConnectorTransport\b/.test(content) || /:\s*ConnectorTransport\s*=\s*\{/.test(content)) {
        offenders.push(fullPath);
      }
    }
  }
  scan(srcDir);
  assert.deepEqual(offenders, [], "a concrete production ConnectorTransport implementation would make Golden C's BLOCKED/NOT_ACTIVATED finding stale - none currently exists");
});

test("OS-V0-13 Golden C: the real protected-effect path for org_akilta's own VERIFIED connection, with no real secret resolvable, is driven to the exact pre-effect boundary and fails closed as BLOCKED_NO_EFFECT - never a fabricated real external action", () => {
  const { authority } = foundingPrincipalContext();
  const instanceWithNoSecret: ConnectorConnectionInstance = (() => {
    const requirement = createConnectionRequirement({
      connectionRequirementId: "creq-akilta-golden-c",
      ownership: ORG_ZERO_OWNERSHIP,
      requiredCapabilityRef: "cap-akilta-generic-read",
      purpose: "Golden C pre-effect boundary probe for Organization Zero",
      accountOwner: "AKILTA_MANAGED",
      minimumProviderScope: ["read:files"],
      connectionMethod: "OAUTH2",
      validationRequirement: "verified-oauth-handshake",
    });
    const binding = createConnectionBinding({
      connectionBindingId: "conn-akilta-golden-c",
      requirement,
      ownership: ORG_ZERO_OWNERSHIP,
      providerRef: "GENERIC_CUSTOM_API",
      workspaceRef: "workspace-akilta-golden-c",
      integrationInstanceRef: "integration-akilta-golden-c",
      delegatedScope: ["read:files"],
      // Deliberately no `secretRef` - no real credential exists for
      // Organization Zero's own connections today (confirmed by the
      // preceding Golden C test). This is the honest current boundary,
      // never fabricated.
    });
    return { binding, connectorKind: "GENERIC_CUSTOM_API", authMode: "API_KEY" };
  })();

  const verified: ConnectorConnectionInstance = {
    ...instanceWithNoSecret,
    binding: verifyConnectionBinding(
      transitionConnectorConnection(instanceWithNoSecret, "CONNECTED_UNVERIFIED").binding,
      "evidence://org-zero-dogfood/golden-c-verified-1",
    ),
  };
  const connDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-golden-c-"));
  const connectionStore = new FileDurableConnectorConnectionStore(connDir);
  connectionStore.save(verified);

  const bound = buildOrgZeroConnectorBound(verified);
  let transportInvoked = false;
  const transport: ConnectorTransport = {
    execute: () => {
      transportInvoked = true;
      throw new Error("Golden C must never reach the transport with no real secret resolvable");
    },
  };
  const secretResolver: SecretResolver = {
    resolve: () => {
      throw new Error("no real secret exists for Organization Zero's own connections - Golden C is honestly BLOCKED, not activated");
    },
  };
  const readback = { confirmsApplied: () => true, evidenceRef: () => "unused" };

  const outcome = executeConnectorCapabilityAsVerifiedEffect({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    authority,
    effectIntentId: "effect-org-zero-golden-c-1",
    actionRef: "akilta-generic-read",
    retryClassification: "SAFE_TO_RETRY",
    attemptId: "attempt-org-zero-golden-c-1",
    bound,
    capabilityRef: "cap-akilta-generic-read",
    requestingOwnership: ORG_ZERO_OWNERSHIP,
    connectionStore,
    secretResolver,
    transport,
    readback,
  });

  assert.equal(outcome.kind, "BLOCKED_NO_EFFECT");
  assert.equal(transportInvoked, false, "Golden C's honest BLOCKED/NOT_ACTIVATED finding requires zero transport invocation - never a fabricated real external action");
});

// --- Admin observability wiring: the real /os/admin route surfaces org_akilta's own real dogfood truth ---

test("OS-V0-13: the real /os/admin route surfaces org_akilta's own real dogfood connection truth (REVOKED kill-switch) through the already-accepted OperationalObservabilitySource/OrganizationResourceBindingSource wiring", async () => {
  const { membership, principal, provider, sessionToken, grant } = foundingPrincipalContext();

  const bindingDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-admin-binding-"));
  const { bootstrap, status } = bootstrapRealResourceBinding(bindingDir, membership);
  assert.equal(status.state, "READY");

  let instance = buildOrgZeroConnectionInstance("secret-ref-akilta-admin-dogfood-placeholder");
  const connDir = mkdtempSync(join(tmpdir(), "os-v0-13-org-zero-admin-connections-"));
  const connectionStore = new FileDurableConnectorConnectionStore(connDir);
  let stored = connectionStore.save(instance);
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  stored = connectionStore.save(instance, stored.version);
  instance = verifyConnectorConnection(instance, "evidence://org-zero-dogfood/admin-connection-verified-1");
  stored = connectionStore.save(instance, stored.version);
  const revoked = mutateConnectorConnectionStateAsAuthenticatedAdmin({
    tenantScope: ORG_ZERO_TENANT_SCOPE,
    organization: ORGANIZATION_ZERO,
    provider,
    sessionToken,
    grants: [grant],
    store: connectionStore,
    connectionBindingId: stored.instance.binding.connectionBindingId,
    to: "REVOKED",
  });

  const resourceBindingSource: OrganizationResourceBindingSource = {
    resolveStatus: () =>
      resolveOrganizationResourceBindingStatus({
        binding: bootstrap.binding,
        organization: ORGANIZATION_ZERO,
        currentMemberships: [membership],
        currentServicePrincipals: [],
        currentConnections: [revoked.instance.binding],
        currentProject: ORG_ZERO_PROJECT,
        currentEffectiveConfigRefs: [],
        currentEffectivePolicyRefs: [],
        currentWorkerRouteDecisions: [],
        currentKnowledgeEvidenceRefs: [],
      }),
  };
  const operationalObservabilitySource: OperationalObservabilitySource = {
    resolveView: () =>
      composeOperationalObservabilityView({
        connections: [revoked.instance.binding],
      }),
  };

  const server = createInternalOsHttpServer({
    isProduction: false,
    devStaffFixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-06T00:00:00.000Z" }]]),
    organization: ORGANIZATION_ZERO,
    grants: [grant],
    resourceBindingSource,
    operationalObservabilitySource,
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/os/admin`, {
      headers: { "x-akilta-staff-session-token": sessionToken },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /conn-akilta-primary-workspace/);
    assert.match(body, /REVOKED/);
    assert.match(body, /kill switch engaged/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
