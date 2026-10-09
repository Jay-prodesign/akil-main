import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOrganization, activateOrganization, suspendOrganization, type Organization } from "../src/domain/organization.js";
import {
  createOrganizationMembership,
  revokeOrganizationMembership,
  type OrganizationMembership,
} from "../src/domain/organization-membership.js";
import {
  createOrganizationServicePrincipal,
  revokeOrganizationServicePrincipal,
  type OrganizationServicePrincipal,
} from "../src/domain/organization-service-principal.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  createSecretRef,
  type ConnectionBinding,
} from "../src/domain/connection-authority.js";
import {
  createOrganizationResourceBinding,
  resolveOrganizationResourceBindingStatus,
  InvalidOrganizationResourceBindingError,
  type OrganizationResourceBinding,
} from "../src/domain/organization-resource-binding.js";
import type { WorkerRoutingDecision } from "../src/domain/worker-routing-policy.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";
import { resolveAndProjectConfigurationPolicyDecision } from "../src/domain/resolve-and-project-configuration-policy-decision.js";

function fixture(tenantSuffix = "akilta") {
  const tenantScope = createTenantScope(`tenant-org-${tenantSuffix}`);
  const customer = createCustomer({
    tenantScope,
    customerId: `cust-org-${tenantSuffix}`,
    displayName: "Org Customer",
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: `proj-org-${tenantSuffix}`,
    ownerRef: `owner-org-${tenantSuffix}`,
    state: "active",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
  });
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: `org_${tenantSuffix}`,
      tenantScope,
      displayName: "Org Zero",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    activatedAt: "2026-01-01T00:05:00.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: `membership-founder-${tenantSuffix}`,
    tenantScope,
    principalRef: `principal-founder-${tenantSuffix}`,
    role: "STAFF",
  });
  return { tenantScope, customer, project, ownership, organization, membership };
}

function verifiedConnection(
  ownership: ReturnType<typeof createProjectOwnershipRef>,
  bindingSuffix: string,
): ConnectionBinding {
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${bindingSuffix}`,
    ownership,
    requiredCapabilityRef: "required-access-connections",
    purpose: "org resource binding test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH2",
    validationRequirement: "provider-verified",
  });
  const requested = createConnectionBinding({
    connectionBindingId: `bind-${bindingSuffix}`,
    requirement,
    ownership,
    providerRef: "PROVIDER",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    secretRef: createSecretRef({ secretRefId: `secret-${bindingSuffix}` }),
  });
  const connectedUnverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(connectedUnverified, `evidence-${bindingSuffix}`);
}

// --- construction ---

test("B1: createOrganizationResourceBinding builds a valid binding from real, tenant-correct evidence", () => {
  const { organization, membership, project, ownership } = fixture();
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(binding.organizationId, organization.organizationId);
  assert.equal(binding.tenantId, organization.tenantId);
  assert.deepEqual(binding.membershipRefs, [membership.membershipId]);
  assert.deepEqual(binding.servicePrincipalRefs, []);
  assert.equal(binding.projectRef, project.projectId);
});

test("B2: at least one membership is required - a binding cannot be bootstrapped from zero founder evidence", () => {
  const { organization, project, ownership } = fixture();
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [],
        project,
        ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B3: at least one supplied membership must be active - all-revoked membership evidence is rejected at construction", () => {
  const { organization, membership, project, ownership } = fixture();
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-01-01T12:00:00.000Z",
    revokedReason: "test revocation",
  });
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [revoked],
        project,
        ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B4: a membership from a different tenant cannot be bound - cross-tenant substitution rejected at construction", () => {
  const { organization, project, ownership } = fixture("a");
  const other = fixture("b");
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [other.membership],
        project,
        ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B5: a project from a different tenant cannot be bound", () => {
  const { organization, membership, ownership } = fixture("a");
  const other = fixture("b");
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [membership],
        project: other.project,
        ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B6: ownership must agree with the organization's tenant and the given project", () => {
  const { organization, membership, project } = fixture("a");
  const other = fixture("b");
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [membership],
        project,
        ownership: other.ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B7: duplicate membership refs are rejected", () => {
  const { organization, membership, project, ownership } = fixture();
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [membership, membership],
        project,
        ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B8: a service principal from a different tenant cannot be bound", () => {
  const { organization, membership, project, ownership } = fixture("a");
  const other = fixture("b");
  const foreignPrincipal = createOrganizationServicePrincipal({
    servicePrincipalId: "sp-foreign",
    tenantScope: other.tenantScope,
    workerRef: "worker-foreign",
  });
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [membership],
        servicePrincipals: [foreignPrincipal],
        project,
        ownership,
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("B9: connectionBindingRefs/effectiveConfigRefs/etc. only ever accept opaque strings, never a ConnectionBinding/SecretRef object - raw connection state can never reach the binding", () => {
  const { organization, membership, project, ownership } = fixture();
  const connection = verifiedConnection(ownership, "b9");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    connectionBindingRefs: [connection.connectionBindingId],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(binding.connectionBindingRefs, [connection.connectionBindingId]);
  // The binding object is fully JSON-serializable and contains no secretRef anywhere.
  const serialized = JSON.stringify(binding);
  assert.doesNotMatch(serialized, /secret-b9/, "the connection's own secretRef value must never reach the durable binding shape");
});

test("B10: duplicate entries within an opaque ref array are rejected", () => {
  const { organization, membership, project, ownership } = fixture();
  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [membership],
        project,
        ownership,
        effectiveConfigRefs: ["cfg-1", "cfg-1"],
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

// --- status resolution ---

function bindingFixture(tenantSuffix = "status") {
  const base = fixture(tenantSuffix);
  const binding = createOrganizationResourceBinding({
    organization: base.organization,
    memberships: [base.membership],
    project: base.project,
    ownership: base.ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  return { ...base, binding };
}

/** Rev183 F1: the default "everything current, nothing bound beyond membership" evidence shape every existing witness needs. */
function defaultCurrentEvidence(project: ReturnType<typeof createProject>) {
  return {
    currentProject: project,
    currentEffectiveConfigRefs: [] as ReadonlyArray<string>,
    currentEffectivePolicyRefs: [] as ReadonlyArray<string>,
    currentWorkerRouteDecisions: [] as ReadonlyArray<{ routeRef: string; decision: WorkerRoutingDecision }>,
    currentKnowledgeEvidenceRefs: [] as ReadonlyArray<string>,
  };
}

test("S1: a fully current binding resolves READY", () => {
  const { organization, membership, binding, project } = bindingFixture();
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "READY");
  assert.equal(status.nextRequiredActor, "NONE");
  assert.deepEqual(status.unresolvedGates, []);
});

test("S2: a SUSPENDED organization blocks, even though the binding's own ref list is untouched", () => {
  const { organization, membership, binding, project } = bindingFixture();
  const suspended = suspendOrganization({ organization, suspendedAt: "2026-01-03T00:00:00.000Z" });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization: suspended,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "ORGANIZATION_SUSPENDED");
  // The historical binding evidence itself is never mutated/deleted.
  assert.deepEqual(binding.membershipRefs, [membership.membershipId]);
});

test("S3 (mandatory witness): a revoked membership blocks downstream use WITHOUT deleting the historical binding evidence", () => {
  const { organization, membership, binding, project } = bindingFixture();
  const revoked = revokeOrganizationMembership({
    membership,
    revokedAt: "2026-01-03T00:00:00.000Z",
    revokedReason: "left the company",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [revoked],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "NO_ACTIVE_BOUND_MEMBERSHIP");
  // The binding's own membershipRefs are unchanged - only the CURRENT
  // resolution observes the revocation, exactly like
  // resolveEffectiveOrganizationAccess does for ordinary access checks.
  assert.deepEqual(binding.membershipRefs, [membership.membershipId]);
});

test("S4: a membership missing entirely from current evidence (deleted authoritative source) also blocks", () => {
  const { organization, binding, project } = bindingFixture();
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "NO_ACTIVE_BOUND_MEMBERSHIP");
});

test("S5 (mandatory witness): same-looking membership ref bound to a DIFFERENT organization cannot substitute", () => {
  const a = bindingFixture("s5-a");
  const b = fixture("s5-b");
  // A membership that happens to carry the exact same membershipId string as
  // a's bound membership, but genuinely belongs to organization b's tenant.
  const lookalike = createOrganizationMembership({
    membershipId: a.membership.membershipId,
    tenantScope: b.tenantScope,
    principalRef: "some-other-principal",
    role: "STAFF",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding: a.binding,
    organization: a.organization,
    currentMemberships: [lookalike],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(a.project),
  });
  assert.equal(status.state, "BLOCKED", "a same-id membership from a foreign tenant must never satisfy a's own binding");
});

test("S6: a revoked service principal referenced by the binding triggers ACTION_REQUIRED, without affecting an unrelated binding with no service principal at all", () => {
  const { organization, membership, project, ownership, tenantScope } = fixture();
  const servicePrincipal = createOrganizationServicePrincipal({
    servicePrincipalId: "sp-1",
    tenantScope,
    workerRef: "worker-1",
  });
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    servicePrincipals: [servicePrincipal],
    project,
    ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const revokedPrincipal = revokeOrganizationServicePrincipal({
    servicePrincipal,
    revokedAt: "2026-01-03T00:00:00.000Z",
    revokedReason: "worker decommissioned",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [revokedPrincipal],
    currentConnections: [],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "ACTION_REQUIRED");
  assert.equal(status.nextRequiredAction?.code, "SERVICE_PRINCIPAL_REVOKED");
});

test("S7 (mandatory witness): a REVOKED connection referenced by the binding blocks downstream use, without deleting historical binding evidence", () => {
  const { organization, membership, project, ownership } = fixture();
  const connection = verifiedConnection(ownership, "s7");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    connectionBindingRefs: [connection.connectionBindingId],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const revokedConnection = transitionConnectionBinding(connection, "REVOKED");
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [revokedConnection],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "ACTION_REQUIRED");
  assert.equal(status.nextRequiredAction?.code, "CONNECTION_NOT_CURRENT");
  assert.deepEqual(binding.connectionBindingRefs, [connection.connectionBindingId]);
});

test("S8: a bound connection resolved from a foreign tenant/project cannot substitute for the real one", () => {
  const { organization, membership, project, ownership } = fixture("s8-a");
  const other = fixture("s8-b");
  const connection = verifiedConnection(ownership, "s8");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    connectionBindingRefs: [connection.connectionBindingId],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const lookalikeConnection = verifiedConnection(other.ownership, "s8"); // same bindingSuffix -> same connectionBindingId string
  assert.equal(lookalikeConnection.connectionBindingId, connection.connectionBindingId);
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [lookalikeConnection],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "ACTION_REQUIRED", "a same-id connection bound to a foreign tenant/project must never satisfy this binding");
  assert.equal(status.nextRequiredAction?.code, "CONNECTION_MISSING");
});

test("S9: an organization identity mismatch between the binding and the supplied current organization is BLOCKED, not silently ignored", () => {
  const a = bindingFixture("s9-a");
  const b = fixture("s9-b");
  const status = resolveOrganizationResourceBindingStatus({
    binding: a.binding,
    organization: b.organization,
    currentMemberships: [a.membership],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(a.project),
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "ORGANIZATION_IDENTITY_MISMATCH");
});

test("S10: a BOOTSTRAPPING (not yet activated) organization reports ACTION_REQUIRED with actor AKILTA", () => {
  const { tenantScope, membership, project, ownership } = fixture();
  const bootstrapping = createOrganization({
    organizationId: "org_bootstrapping",
    tenantScope,
    displayName: "Not Yet Active",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const binding = createOrganizationResourceBinding({
    organization: activateOrganization({ organization: bootstrapping, activatedAt: "2026-01-01T00:05:00.000Z" }),
    memberships: [membership],
    project,
    ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization: bootstrapping,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(project),
  });
  assert.equal(status.state, "ACTION_REQUIRED");
  assert.equal(status.nextRequiredActor, "AKILTA");
  assert.equal(status.nextRequiredAction?.code, "ORGANIZATION_NOT_ACTIVATED");
});

// --- controlled second organization (mandatory witness) ---

test("C1 (mandatory witness): the exact same constructors/resolver bootstrap a controlled second Organization with different identifiers, no org_akilta-specific path", () => {
  const orgZero = bindingFixture("org_akilta");
  const secondOrg = bindingFixture("org_controlled_second");
  assert.notEqual(orgZero.binding.organizationId, secondOrg.binding.organizationId);
  assert.notEqual(orgZero.binding.tenantId, secondOrg.binding.tenantId);
  const secondStatus = resolveOrganizationResourceBindingStatus({
    binding: secondOrg.binding,
    organization: secondOrg.organization,
    currentMemberships: [secondOrg.membership],
    currentServicePrincipals: [],
    currentConnections: [],
    ...defaultCurrentEvidence(secondOrg.project),
  });
  assert.equal(secondStatus.state, "READY", "the second organization reaches READY through the identical code path used for org_akilta");
});

// --- Rev183 F1: currentness gates the prior resolver never checked ---

test("Rev183 F1-P1: a project that no longer resolves to a current record blocks, even though membership/org are both fine", () => {
  const { organization, membership, binding } = bindingFixture("rev183-p1");
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: undefined,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "PROJECT_NOT_CURRENT");
});

test("Rev183 F1-P2 (mandatory witness): a same-looking project reassigned to a different tenant/customer cannot substitute for the bound one", () => {
  const a = bindingFixture("rev183-p2-a");
  const b = fixture("rev183-p2-b");
  const status = resolveOrganizationResourceBindingStatus({
    binding: a.binding,
    organization: a.organization,
    currentMemberships: [a.membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: b.project, // a foreign project, never a's own
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "PROJECT_NOT_CURRENT");
});

test("Rev183 F1-C1: a bound effective config ref no longer among the currently effective configuration triggers ACTION_REQUIRED, without deleting the historical binding evidence", () => {
  const { organization, membership, project, ownership } = fixture("rev183-c1");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    effectiveConfigRefs: ["cfg-alpha"],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: [], // cfg-alpha has been superseded/removed
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "ACTION_REQUIRED");
  assert.equal(status.nextRequiredAction?.code, "CONFIG_NOT_CURRENT");
  assert.deepEqual(binding.effectiveConfigRefs, ["cfg-alpha"]);
});

test("Rev183 F1-C2: a bound effective policy ref no longer among the currently effective policy triggers ACTION_REQUIRED", () => {
  const { organization, membership, project, ownership } = fixture("rev183-c2");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    effectivePolicyRefs: ["pol-alpha"],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "ACTION_REQUIRED");
  assert.equal(status.nextRequiredAction?.code, "POLICY_NOT_CURRENT");
});

test("Rev183 F1-W1: a bound worker route with no current decision, or a current REJECTED decision, triggers ACTION_REQUIRED", () => {
  const { organization, membership, project, ownership } = fixture("rev183-w1");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    workerRouteRefs: ["route-alpha"],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const missingStatus = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(missingStatus.state, "ACTION_REQUIRED");
  assert.equal(missingStatus.nextRequiredAction?.code, "WORKER_ROUTE_NOT_CURRENT");

  const rejectedStatus = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [
      {
        routeRef: "route-alpha",
        decision: {
          requiredCapabilityRef: "cap-1",
          riskLevel: "STANDARD",
          status: "REJECTED",
          reason: "no eligible worker",
        },
      },
    ],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(rejectedStatus.state, "ACTION_REQUIRED");
  assert.equal(rejectedStatus.nextRequiredAction?.code, "WORKER_ROUTE_NOT_CURRENT");
});

test("Rev183 F1-K1: a bound knowledge/evidence ref no longer resolving to current evidence triggers ACTION_REQUIRED", () => {
  const { organization, membership, project, ownership } = fixture("rev183-k1");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    knowledgeEvidenceRefs: ["evidence-alpha"],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "ACTION_REQUIRED");
  assert.equal(status.nextRequiredAction?.code, "KNOWLEDGE_EVIDENCE_MISSING");
});

test("Rev183 F1: a binding with current config/policy/worker-route/knowledge-evidence still resolves READY - the new gates don't false-positive-block genuinely current state", () => {
  const { organization, membership, project, ownership } = fixture("rev183-ready");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    effectiveConfigRefs: ["cfg-1"],
    effectivePolicyRefs: ["pol-1"],
    workerRouteRefs: ["route-1"],
    knowledgeEvidenceRefs: ["evidence-1"],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: ["cfg-1"],
    currentEffectivePolicyRefs: ["pol-1"],
    currentWorkerRouteDecisions: [
      {
        routeRef: "route-1",
        decision: { requiredCapabilityRef: "cap-1", riskLevel: "STANDARD", status: "ROUTED", executorWorkerId: "worker-1", reason: "eligible" },
      },
    ],
    currentKnowledgeEvidenceRefs: ["evidence-1"],
  });
  assert.equal(status.state, "READY");
});

// --- Rev183 F2: widened manifest fields ---

test("Rev183 F2: outcomeIdentityRefs/repositoryWorkspaceRefs/usageQuotaNamespaceRefs/auditRecoveryRefs/admittedCapabilityRefs are captured as opaque refs and reject duplicates like every other ref array", () => {
  const { organization, membership, project, ownership } = fixture("rev183-f2");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    outcomeIdentityRefs: ["job-1"],
    repositoryWorkspaceRefs: ["workspace-1"],
    usageQuotaNamespaceRefs: ["quota-ns-1"],
    auditRecoveryRefs: ["audit-1"],
    admittedCapabilityRefs: ["cap-admission-1"],
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(binding.outcomeIdentityRefs, ["job-1"]);
  assert.deepEqual(binding.repositoryWorkspaceRefs, ["workspace-1"]);
  assert.deepEqual(binding.usageQuotaNamespaceRefs, ["quota-ns-1"]);
  assert.deepEqual(binding.auditRecoveryRefs, ["audit-1"]);
  assert.deepEqual(binding.admittedCapabilityRefs, ["cap-admission-1"]);

  assert.throws(
    () =>
      createOrganizationResourceBinding({
        organization,
        memberships: [membership],
        project,
        ownership,
        usageQuotaNamespaceRefs: ["quota-ns-1", "quota-ns-1"],
        boundAt: "2026-01-02T00:00:00.000Z",
      }),
    InvalidOrganizationResourceBindingError,
  );
});

test("Rev183 F2: the five new fields default to an honest empty [] posture, never fabricated content, when the caller has nothing real to bind yet", () => {
  const { organization, membership, project, ownership } = fixture("rev183-f2-defaults");
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(binding.outcomeIdentityRefs, []);
  assert.deepEqual(binding.repositoryWorkspaceRefs, []);
  assert.deepEqual(binding.usageQuotaNamespaceRefs, []);
  assert.deepEqual(binding.auditRecoveryRefs, []);
  assert.deepEqual(binding.admittedCapabilityRefs, []);
});

// --- OS-V0-11 integration witness (read-only reuse - organization-resource-binding.ts itself is never modified) ---

function platformConfigControl(overrides: Record<string, unknown> = {}) {
  return {
    kind: "CONFIG",
    scope: "PLATFORM",
    key: "theme",
    sourceRef: "platform-theme-default",
    version: "1",
    identity: {},
    ...overrides,
  };
}

test("OS-V0-11 integration witness: resolveAndProjectConfigurationPolicyDecision's resolution.effectiveConfigRefs feeds resolveOrganizationResourceBindingStatus's currentEffectiveConfigRefs byte-for-byte, and a drift between two decisions explains exactly the CONFIG_NOT_CURRENT the existing currentness gate independently reports", () => {
  const { organization, membership, project, ownership, tenantScope } = fixture("os-v0-11-witness");
  const decisionStore = new FileDurableConfigurationPolicyDecisionStore(
    mkdtempSync(join(tmpdir(), "os-v0-11-org-binding-witness-")),
  );
  const identity = { tenantId: tenantScope.tenantId, projectId: project.projectId };

  const first = resolveAndProjectConfigurationPolicyDecision({
    store: decisionStore,
    identity,
    controls: [platformConfigControl()],
    decisionId: "decision-1",
    now: "2026-01-02T00:00:00.000Z",
  });

  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    effectiveConfigRefs: first.resolution.effectiveConfigRefs,
    boundAt: "2026-01-02T00:00:00.000Z",
  });

  // The binding's own currentness gate accepts the durable decision's
  // own refs unchanged - no transformation, no second ref encoding.
  const readyStatus = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: first.resolution.effectiveConfigRefs,
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(readyStatus.state, "READY");

  // A materially different platform control (same key, new sourceRef/
  // version) is resolved and durably projected as a drifted decision.
  const second = resolveAndProjectConfigurationPolicyDecision({
    store: decisionStore,
    identity,
    controls: [platformConfigControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-01-02T00:01:00.000Z",
  });
  assert.equal(second.stale, true);
  assert.equal(second.drift.length, 1);
  assert.equal(second.drift[0]?.key, "theme");

  // Feeding the FRESH decision's refs as the current evidence reproduces
  // exactly the same staleness the existing gate independently detects -
  // the durable drift explanation and the binding's own currentness check
  // agree on which ref stopped being current, without either depending on
  // the other's internals.
  const staleStatus = resolveOrganizationResourceBindingStatus({
    binding,
    organization,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: second.resolution.effectiveConfigRefs,
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: [],
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(staleStatus.state, "ACTION_REQUIRED");
  assert.equal(staleStatus.nextRequiredAction?.code, "CONFIG_NOT_CURRENT");
  assert.deepEqual(binding.effectiveConfigRefs, first.resolution.effectiveConfigRefs, "the historical binding evidence is never mutated by a later drifted decision");
});
