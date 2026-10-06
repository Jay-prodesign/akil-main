import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  InternalOsAccessDeniedError,
  type StaffAccessGrant,
} from "../src/web/internal-os-access.js";
import { NoStaffMembershipError } from "../src/web/staff-membership-guard.js";

import { createOutcomeJob } from "../src/domain/outcome-job.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import { FileDurableOutcomeJobExecutionStore } from "../src/domain/durable-outcome-job-execution-store.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  type QuotaEnvelope,
} from "../src/domain/execution-quota-admission.js";
import {
  dispatchOutcomeJobExecutionRun,
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

import { createConnectionRequirement, createConnectionBinding, createSecretRef } from "../src/domain/connection-authority.js";
import { transitionConnectorConnection, verifyConnectorConnection, type ConnectorConnectionInstance } from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { mutateConnectorConnectionStateAsAuthenticatedAdmin } from "../src/web/connector-connection-admin-access.js";

import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import type { OrganizationResourceBindingSource, OperationalObservabilitySource } from "../src/web/internal-os-view-state.js";
import { composeOperationalObservabilityView } from "../src/domain/operational-observability-view.js";

/**
 * OS-V0-14 "Controlled Second Organization Smoke" (Brain Rev196): proves
 * cross-organization isolation holds for the OS-V0-13 dogfood lineage
 * specifically - a second, real, distinct Organization (never a second
 * live external provider action, per Rev196's own explicit instruction)
 * shares the SAME durable store instances as Organization Zero, including
 * deliberate bare-id-string collisions, one concurrent smoke, and a
 * restart proof. Every primitive exercised here already enforces tenant-
 * scoping at the unit level (confirmed by repo-wide inspection before
 * writing this file) - this is the integration-level reinforcement Rev196
 * asks for, never a new isolation mechanism. Zero new production code.
 */
function buildOrg(label: "A" | "B") {
  const tenantScope = createTenantScope(label === "A" ? "t-akilta" : "t-b-smoke");
  const customer = createCustomer({
    tenantScope,
    customerId: label === "A" ? "c-akilta" : "c-b-smoke",
    displayName: label === "A" ? "AKILTA (Organization Zero)" : "Organization B (controlled smoke)",
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: label === "A" ? "p-akilta-web" : "p-b-smoke",
    ownerRef: label === "A" ? "akilta-digital-operations" : "org-b-smoke-owner",
    state: "active",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
  });
  const organization: Organization = activateOrganization({
    organization: createOrganization({
      organizationId: label === "A" ? "org_akilta" : "org-b-smoke",
      tenantScope,
      displayName: label === "A" ? "AKILTA" : "Organization B (controlled smoke)",
      createdAt: "2026-10-06T00:00:00.000Z",
    }),
    activatedAt: "2026-10-06T00:00:01.000Z",
  });

  const membership = createOrganizationMembership({
    membershipId: `membership-${label === "A" ? "org-zero" : "org-b-smoke"}-founder`,
    tenantScope,
    principalRef: `principal-${label === "A" ? "org-zero" : "org-b-smoke"}-founder`,
    role: "STAFF",
  });
  const assignment = createAssignmentReference({
    assignmentId: `assignment-${label === "A" ? "org-zero" : "org-b-smoke"}-founder`,
    membership,
    customerId: customer.customerId,
    projectId: project.projectId,
  });
  const authority = createAuthorityContext({
    tenantScope,
    permissions: ["EXECUTE", "WRITE", "READ"],
    canPerformProtectedActions: true,
  });
  const principal = createAuthenticatedStaffPrincipal({
    principalId: `principal-${label === "A" ? "org-zero" : "org-b-smoke"}-founder`,
    displayName: `${label === "A" ? "Organization Zero" : "Organization B"} Founding Principal`,
  });
  const sessionToken = `token-${label === "A" ? "org-zero" : "org-b-smoke"}-founder`;
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-06T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const roleContext = createOrganizationAccessRoleContext({ membership, role: "OWNER" });
  const grant: StaffAccessGrant = { membership, authority, assignments: [assignment], roleContext };

  return { tenantScope, customer, project, ownership, organization, membership, authority, principal, provider, sessionToken, grant };
}

const ORG_A = buildOrg("A");
const ORG_B = buildOrg("B");

function acceptingInvoker(callLog: unknown[]): WorkerInvoker {
  return {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async (input) => {
      callLog.push(input.outcomeJobExecution);
      return { accepted: true };
    },
  };
}

class InMemoryExecutionEconomicsStore implements ExecutionEconomicsPort {
  private ledger: ExecutionEconomicsLedger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  recordSettledAttempt(event: ExecutionEconomicsEvent): void {
    this.ledger = appendExecutionEconomicsEventAllowingCapturedAtDrift(this.ledger, event);
  }
}

// --- org/membership/access: stale A deep link after switching to B fails current scope checks ---

test("OS-V0-14: Organization A's own authenticated staff ingress succeeds for Organization A, independently of Organization B's existence", () => {
  const access = requireInternalOsAccess({
    provider: ORG_A.provider,
    sessionToken: ORG_A.sessionToken,
    organization: ORG_A.organization,
    grants: [ORG_A.grant],
  });
  assert.equal(access.access.decision, "GRANTED");
});

test("OS-V0-14: Organization B's own authenticated staff ingress succeeds for Organization B, independently of Organization A's existence", () => {
  const access = requireInternalOsAccess({
    provider: ORG_B.provider,
    sessionToken: ORG_B.sessionToken,
    organization: ORG_B.organization,
    grants: [ORG_B.grant],
  });
  assert.equal(access.access.decision, "GRANTED");
});

test("OS-V0-14: Organization A's own staff session/grant cannot be substituted into Organization B's organization - a stale A deep link after switching to B fails the current scope check closed", () => {
  assert.throws(
    () =>
      requireInternalOsAccess({
        provider: ORG_A.provider,
        sessionToken: ORG_A.sessionToken,
        organization: ORG_B.organization,
        grants: [ORG_A.grant],
      }),
    (error: unknown) => error instanceof NoStaffMembershipError || error instanceof InternalOsAccessDeniedError,
  );
});

// --- resource binding: shared store, distinct organizationIds, no cross-tenant leak ---

test("OS-V0-14: Organization A's and Organization B's own resource bindings, bootstrapped into the SAME shared durable store instance, each resolve READY independently with zero cross-visibility", () => {
  const sharedBindingDir = mkdtempSync(join(tmpdir(), "os-v0-14-shared-binding-"));
  const store = new FileDurableOrganizationResourceBindingStore(sharedBindingDir);

  const bootstrapA = bootstrapOrganizationResourceBinding({
    store,
    organization: ORG_A.organization,
    memberships: [ORG_A.membership],
    project: ORG_A.project,
    ownership: ORG_A.ownership,
    boundAt: "2026-10-06T00:00:02.000Z",
  });
  const bootstrapB = bootstrapOrganizationResourceBinding({
    store,
    organization: ORG_B.organization,
    memberships: [ORG_B.membership],
    project: ORG_B.project,
    ownership: ORG_B.ownership,
    boundAt: "2026-10-06T00:00:02.000Z",
  });
  assert.equal(bootstrapA.created, true);
  assert.equal(bootstrapB.created, true);

  const statusA = resolveOrganizationResourceBindingStatus({
    binding: bootstrapA.binding,
    organization: ORG_A.organization,
    currentMemberships: [ORG_A.membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: ORG_A.project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  const statusB = resolveOrganizationResourceBindingStatus({
    binding: bootstrapB.binding,
    organization: ORG_B.organization,
    currentMemberships: [ORG_B.membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: ORG_B.project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(statusA.state, "READY");
  assert.equal(statusB.state, "READY");

  // Cross-tenant lookup: Organization B's own tenantId never resolves
  // Organization A's binding, and vice versa, even from the SAME store.
  assert.equal(store.get(ORG_B.tenantScope.tenantId, ORG_A.organization.organizationId), undefined);
  assert.equal(store.get(ORG_A.tenantScope.tenantId, ORG_B.organization.organizationId), undefined);
});

// --- connection/SecretRef: deliberate bare-id-string collision across tenants ---

function buildConnectionInstance(org: ReturnType<typeof buildOrg>, connectionBindingId: string, secretRefId: string): ConnectorConnectionInstance {
  const requirement = createConnectionRequirement({
    connectionRequirementId: `creq-${connectionBindingId}`,
    ownership: org.ownership,
    requiredCapabilityRef: "cap-smoke-generic-read",
    purpose: "OS-V0-14 cross-organization collision probe",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: ["read:files"],
    connectionMethod: "OAUTH2",
    validationRequirement: "verified-oauth-handshake",
  });
  const binding = createConnectionBinding({
    connectionBindingId,
    requirement,
    ownership: org.ownership,
    providerRef: "GENERIC_CUSTOM_API",
    workspaceRef: `workspace-${connectionBindingId}`,
    integrationInstanceRef: `integration-${connectionBindingId}`,
    delegatedScope: ["read:files"],
    secretRef: createSecretRef({ secretRefId }),
  });
  return { binding, connectorKind: "GENERIC_CUSTOM_API", authMode: "API_KEY" };
}

test("OS-V0-14: the exact SAME bare connectionBindingId string, used by Organization A and Organization B in the SAME shared durable connection store, does not collide - each tenant's own record is independently verified and independently revocable", () => {
  const COLLIDING_ID = "conn-shared-collision-probe";
  const sharedConnDir = mkdtempSync(join(tmpdir(), "os-v0-14-shared-connections-"));
  const connectionStore = new FileDurableConnectorConnectionStore(sharedConnDir);

  let instanceA = buildConnectionInstance(ORG_A, COLLIDING_ID, "secret-ref-org-a-collision-probe");
  let instanceB = buildConnectionInstance(ORG_B, COLLIDING_ID, "secret-ref-org-b-collision-probe");
  let storedA = connectionStore.save(instanceA);
  let storedB = connectionStore.save(instanceB);
  assert.equal(storedA.version, 1);
  assert.equal(storedB.version, 1, "a distinct tenant's first save of the SAME bare connectionBindingId must independently start at version 1 - proof the store key is tenant-scoped, not id-only");

  instanceA = transitionConnectorConnection(instanceA, "CONNECTED_UNVERIFIED");
  storedA = connectionStore.save(instanceA, storedA.version);
  instanceA = verifyConnectorConnection(instanceA, "evidence://os-v0-14/org-a-collision-verified-1");
  storedA = connectionStore.save(instanceA, storedA.version);

  instanceB = transitionConnectorConnection(instanceB, "CONNECTED_UNVERIFIED");
  storedB = connectionStore.save(instanceB, storedB.version);
  instanceB = verifyConnectorConnection(instanceB, "evidence://os-v0-14/org-b-collision-verified-1");
  storedB = connectionStore.save(instanceB, storedB.version);

  assert.equal(storedA.instance.binding.connectionState, "VERIFIED");
  assert.equal(storedB.instance.binding.connectionState, "VERIFIED");
  const brandedIdA = storedA.instance.binding.connectionBindingId;
  const brandedIdB = storedB.instance.binding.connectionBindingId;
  assert.equal(
    connectionStore.get(ORG_B.tenantScope.tenantId, brandedIdB)?.instance.binding.connectionState,
    "VERIFIED",
    "reading the colliding id under Organization B's own tenant must return Organization B's own record, not Organization A's",
  );

  // Revoking A must not affect B, even though both share the exact same
  // bare connectionBindingId string.
  const revokedA = mutateConnectorConnectionStateAsAuthenticatedAdmin({
    tenantScope: ORG_A.tenantScope,
    organization: ORG_A.organization,
    provider: ORG_A.provider,
    sessionToken: ORG_A.sessionToken,
    grants: [ORG_A.grant],
    store: connectionStore,
    connectionBindingId: brandedIdA,
    to: "REVOKED",
  });
  assert.equal(revokedA.instance.binding.connectionState, "REVOKED");

  const stillB = connectionStore.get(ORG_B.tenantScope.tenantId, brandedIdB);
  assert.equal(stillB?.instance.binding.connectionState, "VERIFIED", "Organization B's own identically-named connection must remain VERIFIED after Organization A's own connection is revoked");

  // Restart: fresh store instances at the SAME shared directory reconstruct
  // each organization's own isolated truth with zero cross-contamination.
  const restartedStore = new FileDurableConnectorConnectionStore(sharedConnDir);
  assert.equal(restartedStore.get(ORG_A.tenantScope.tenantId, brandedIdA)?.instance.binding.connectionState, "REVOKED");
  assert.equal(restartedStore.get(ORG_B.tenantScope.tenantId, brandedIdB)?.instance.binding.connectionState, "VERIFIED");
});

// --- plan/job/run/task identity: one bounded concurrent smoke over the SAME shared execution/quota stores ---

async function dispatchMinimalJob(org: ReturnType<typeof buildOrg>, store: FileDurableOutcomeJobExecutionStore, quotaStore: FileDurableQuotaReservationStore, sharedId: string) {
  const job = createOutcomeJob({
    tenantScope: org.tenantScope,
    customer: org.customer,
    project: org.project,
    jobId: sharedId,
    jobFamily: "req-smoke",
    businessObjective: `OS-V0-14 concurrent smoke for ${org.organization.organizationId}`,
  });
  const quotaScope = createQuotaAdmissionScope({
    tenantScope: org.tenantScope,
    customerId: org.customer.customerId,
    projectId: org.project.projectId,
    planId: "plan-smoke",
    planVersion: 1,
  });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
    scope: quotaScope,
    envelopeRef: `envelope-${org.organization.organizationId}`,
    sourceFingerprint: "qfp-smoke",
    unitLimit: 1_000_000,
  });
  const quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver = { resolveCurrentQuotaEnvelope: () => quotaEnvelope };
  const economicsPort = new InMemoryExecutionEconomicsStore();
  const callLog: unknown[] = [];
  const invoker = acceptingInvoker(callLog);

  return { job, dispatch: await dispatchOutcomeJobExecutionRun({
    tenantScope: org.tenantScope,
    customer: org.customer,
    project: org.project,
    job,
    authority: org.authority,
    runId: sharedId,
    correlationId: `corr-${org.organization.organizationId}`,
    now: "2026-10-06T00:00:03.000Z",
    executorKind: "INJECTED",
    expectedFingerprint: "fp-smoke",
    currentFingerprint: "fp-smoke",
    currentActivationPlanId: "plan-smoke",
    currentActivationPlanVersion: 1,
    economicsPort,
    economicsTaskRef: `task-ref-${org.organization.organizationId}`,
    economicsUsageSource: "OTHER_ADMITTED",
    taskId: `task-${org.organization.organizationId}`,
    branch: "claude/os-v0-14-controlled-second-organization-smoke",
    checkpointSha: "sha-smoke",
    quotaAdmission: quotaStore,
    quotaEnvelope,
    currentQuotaSourceFingerprint: "qfp-smoke",
    quotaEnvelopeResolver,
    estimatedCost: { presence: "REPORTED", amountMinorUnits: 1, currency: "USD" },
    store,
    invoker,
  }) };
}

test("OS-V0-14: one bounded concurrent Organization Zero + Organization B smoke, dispatched with the exact SAME jobId/runId string against the SAME shared execution-event and quota-reservation store instances, causes zero cross-effect - neither organization's run/attempt/quota state is visible to the other", async () => {
  const COLLIDING_RUN_ID = "run-shared-collision-probe";
  const sharedExecDir = mkdtempSync(join(tmpdir(), "os-v0-14-shared-exec-"));
  const sharedQuotaDir = mkdtempSync(join(tmpdir(), "os-v0-14-shared-quota-"));
  const eventStore = new FileDurableOutcomeJobExecutionStore(sharedExecDir);
  const quotaStore = new FileDurableQuotaReservationStore(sharedQuotaDir);

  const [{ job: jobA, dispatch: resultA }, { job: jobB, dispatch: resultB }] = await Promise.all([
    dispatchMinimalJob(ORG_A, eventStore, quotaStore, COLLIDING_RUN_ID),
    dispatchMinimalJob(ORG_B, eventStore, quotaStore, COLLIDING_RUN_ID),
  ]);
  assert.equal(resultA.invoked, true);
  assert.equal(resultB.invoked, true);

  const stateA = eventStore.getState(ORG_A.tenantScope.tenantId, ORG_A.customer.customerId, ORG_A.project.projectId, jobA.jobId, COLLIDING_RUN_ID);
  const stateB = eventStore.getState(ORG_B.tenantScope.tenantId, ORG_B.customer.customerId, ORG_B.project.projectId, jobB.jobId, COLLIDING_RUN_ID);
  assert.notEqual(stateA, undefined);
  assert.notEqual(stateB, undefined);
  assert.notDeepEqual(stateA, stateB, "each organization's own run state must be its own independent record, never the same shared object/identity despite the identical bare jobId/runId string");

  // Restart: fresh store instances at the SAME shared directories
  // reconstruct each organization's own isolated run state.
  const restartedEventStore = new FileDurableOutcomeJobExecutionStore(sharedExecDir);
  const restartedA = restartedEventStore.getState(ORG_A.tenantScope.tenantId, ORG_A.customer.customerId, ORG_A.project.projectId, jobA.jobId, COLLIDING_RUN_ID);
  const restartedB = restartedEventStore.getState(ORG_B.tenantScope.tenantId, ORG_B.customer.customerId, ORG_B.project.projectId, jobB.jobId, COLLIDING_RUN_ID);
  assert.deepEqual(restartedA, stateA);
  assert.deepEqual(restartedB, stateB);
});

// --- evidence/audit/observability: Admin/shell scoping stays organization-explicit ---

test("OS-V0-14: the real /os/admin route, configured for Organization B, never shows Organization A's own durable dogfood state even when both organizations' sources are wired from the SAME shared durable connection store", async () => {
  const COLLIDING_ID = "conn-shared-admin-scope-probe";
  const sharedConnDir = mkdtempSync(join(tmpdir(), "os-v0-14-shared-admin-connections-"));
  const connectionStore = new FileDurableConnectorConnectionStore(sharedConnDir);

  let instanceA = buildConnectionInstance(ORG_A, COLLIDING_ID, "secret-ref-org-a-admin-scope");
  let storedA = connectionStore.save(instanceA);
  instanceA = transitionConnectorConnection(instanceA, "CONNECTED_UNVERIFIED");
  storedA = connectionStore.save(instanceA, storedA.version);
  instanceA = verifyConnectorConnection(instanceA, "evidence://os-v0-14/org-a-admin-scope-verified-1");
  connectionStore.save(instanceA, storedA.version);

  let instanceB = buildConnectionInstance(ORG_B, COLLIDING_ID, "secret-ref-org-b-admin-scope");
  const storedB = connectionStore.save(instanceB);
  instanceB = transitionConnectorConnection(instanceB, "CONNECTED_UNVERIFIED");
  connectionStore.save(instanceB, storedB.version);
  // Organization B's own connection is deliberately left CONNECTED_UNVERIFIED
  // (never VERIFIED) - distinct observable state from Organization A's
  // VERIFIED record, so the assertions below cannot pass by coincidence.
  const brandedId = storedB.instance.binding.connectionBindingId;

  const operationalObservabilitySource: OperationalObservabilitySource = {
    resolveView: (organization) => {
      const current = connectionStore.get(organization.tenantId, brandedId);
      return composeOperationalObservabilityView({
        connections: current !== undefined ? [current.instance.binding] : [],
      });
    },
  };
  const resourceBindingSource: OrganizationResourceBindingSource = {
    resolveStatus: () => undefined,
  };

  const server = createInternalOsHttpServer({
    isProduction: false,
    devStaffFixtures: new Map([[ORG_B.sessionToken, { principal: ORG_B.principal, issuedAt: "2026-10-06T00:00:00.000Z" }]]),
    organization: ORG_B.organization,
    grants: [ORG_B.grant],
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
      headers: { "x-akilta-staff-session-token": ORG_B.sessionToken },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /CONNECTED_UNVERIFIED/, "the server configured for Organization B must show Organization B's own CONNECTED_UNVERIFIED state");
    assert.doesNotMatch(body, />VERIFIED</, "Organization A's own VERIFIED state for the identically-named connection must never leak into Organization B's rendered Admin page");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
