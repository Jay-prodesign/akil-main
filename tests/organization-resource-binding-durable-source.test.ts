import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationServicePrincipal } from "../src/domain/organization-service-principal.js";
import {
  createConnectionRequirement,
  type ConnectionRequirement,
} from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import { createOrganizationResourceBinding } from "../src/domain/organization-resource-binding.js";
import { FileDurableOrganizationResourceBindingStore } from "../src/domain/durable-organization-resource-binding-store.js";
import { FileDurableOrganizationMembershipStore } from "../src/domain/durable-organization-membership-store.js";
import { FileDurableOrganizationServicePrincipalStore } from "../src/domain/durable-organization-service-principal-store.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";
import { resolveAndProjectConfigurationPolicyDecision } from "../src/domain/resolve-and-project-configuration-policy-decision.js";
import { FileDurableEvidenceReferenceStore } from "../src/domain/durable-evidence-reference-store.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createDurableOrganizationResourceBindingSource } from "../src/web/organization-resource-binding-durable-source.js";

/**
 * ORG-MEMBERSHIP-DURABLE-001: proves `createDurableOrganizationResourceBindingSource`
 * composes the durable OrganizationResourceBinding/OrganizationMembership/
 * Project/ConnectorConnection stores into a real, truthful
 * `OrganizationResourceBindingSource` - READY on the real golden path,
 * `undefined` (never bootstrapped) when no binding exists, and
 * BLOCKED/ACTION_REQUIRED exactly where `resolveOrganizationResourceBindingStatus`'s
 * own gates say so, including dimensions (effective config/policy, worker
 * routes, service principals) this adapter deliberately never fabricates
 * current evidence for, and knowledge evidence - which KNOWLEDGE-EVIDENCE-
 * DURABLE-001 gave a real durable source, mirroring config/policy's own
 * "never fabricates READY" + READY-once-recorded + cross-scope-isolation
 * witness triad.
 */

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixture(tenantSuffix = "a") {
  const tenantScope = createTenantScope(`tenant-orbds-${tenantSuffix}`);
  const customer = createCustomer({ tenantScope, customerId: `cust-orbds-${tenantSuffix}`, displayName: "Org Customer" });
  const project = createProject({ tenantScope, customer, projectId: `proj-orbds-${tenantSuffix}`, ownerRef: "owner-1", state: "ACTIVE" });
  const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: `org_orbds_${tenantSuffix}`,
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

function githubDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GITHUB",
    displayName: "GitHub",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:repo-access"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
}

function connectionRequirementFor(ownershipRef: ReturnType<typeof createProjectOwnershipRef>, suffix: string): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: `req-${suffix}`,
    ownership: ownershipRef,
    requiredCapabilityRef: "cap:repo-access",
    purpose: "org resource binding durable source test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH2",
    validationRequirement: "provider-verified",
  });
}

function stores(dir: string) {
  return {
    bindingStore: new FileDurableOrganizationResourceBindingStore(join(dir, "bindings")),
    membershipStore: new FileDurableOrganizationMembershipStore(join(dir, "memberships")),
    servicePrincipalStore: new FileDurableOrganizationServicePrincipalStore(join(dir, "service-principals")),
    projectStore: new FileDurableProjectStore(join(dir, "projects")),
    connectorConnectionStore: new FileDurableConnectorConnectionStore(join(dir, "connectors")),
    configurationPolicyDecisionStore: new FileDurableConfigurationPolicyDecisionStore(join(dir, "config-policy-decisions")),
    evidenceReferenceStore: new FileDurableEvidenceReferenceStore(join(dir, "evidence-references")),
  };
}

test("resolveStatus returns undefined when the organization has never been bootstrapped (no binding exists)", () => {
  const dir = freshDir("orbds-undefined-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { organization } = fixture("1");
    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    assert.equal(source.resolveStatus(organization), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns READY end-to-end once binding + current membership + current project are all durably wired", () => {
  const dir = freshDir("orbds-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("2");

    membershipStore.create(membership);
    projectStore.create(project);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "READY");
    assert.equal(status?.nextRequiredActor, "NONE");
    assert.deepEqual(status?.unresolvedGates, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns BLOCKED (NO_ACTIVE_BOUND_MEMBERSHIP) once the only bound membership is revoked in the durable membership store", () => {
  const dir = freshDir("orbds-revoked-membership-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("3");

    membershipStore.create(membership);
    projectStore.create(project);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    // Revoke the membership AFTER bootstrap - the binding's own historical
    // membershipRefs never change, but current evidence now disagrees.
    membershipStore.revoke({
      tenantId: tenantScope.tenantId,
      membershipId: membership.membershipId,
      expectedVersion: 1,
      revokedAt: "2026-01-03T00:00:00.000Z",
      revokedReason: "role ended",
    });

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "BLOCKED");
    assert.deepEqual(status?.unresolvedGates, ["NO_ACTIVE_BOUND_MEMBERSHIP"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns BLOCKED (PROJECT_NOT_CURRENT) when the bound project was never created in the durable project store", () => {
  const dir = freshDir("orbds-missing-project-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("4");

    membershipStore.create(membership);
    // Deliberately NOT created in the durable project store.
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "BLOCKED");
    assert.deepEqual(status?.unresolvedGates, ["PROJECT_NOT_CURRENT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns ACTION_REQUIRED (CONNECTION_MISSING) when a bound connectionBindingRef has no corresponding durable record", () => {
  const dir = freshDir("orbds-missing-connection-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("5");

    membershipStore.create(membership);
    projectStore.create(project);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      connectionBindingRefs: ["bind-never-saved"],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    // Deliberately NOT saved into the durable connector connection store.

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["CONNECTION_MISSING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns READY once the bound connection is durably saved and not revoked/degraded", () => {
  const dir = freshDir("orbds-connection-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("6");

    membershipStore.create(membership);
    projectStore.create(project);

    const descriptor = githubDescriptor();
    const requirement = connectionRequirementFor(ownership, "orbds-6");
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-orbds-6",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    connectorConnectionStore.save(instance);

    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      connectionBindingRefs: [instance.binding.connectionBindingId],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never fabricates READY: a binding bootstrapped with non-empty effectiveConfigRefs provenance blocks ACTION_REQUIRED (CONFIG_NOT_CURRENT) until a matching durable decision is recorded for its own scope", () => {
  const dir = freshDir("orbds-config-never-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("7");

    membershipStore.create(membership);
    projectStore.create(project);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      effectiveConfigRefs: ["cfg-bootstrap-provenance-only"],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    // Deliberately no decision ever recorded in the durable config/policy store.

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["CONFIG_NOT_CURRENT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns READY once a durable config/policy decision for the binding's own project scope resolves the bound effectiveConfigRefs/effectivePolicyRefs", () => {
  const dir = freshDir("orbds-config-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("11");

    membershipStore.create(membership);
    projectStore.create(project);

    const { entry } = resolveAndProjectConfigurationPolicyDecision({
      store: configurationPolicyDecisionStore,
      identity: { tenantId: tenantScope.tenantId, customerId: ownership.customerId, projectId: ownership.projectId },
      controls: [
        {
          kind: "CONFIG",
          key: "feature-flags",
          scope: "PROJECT",
          sourceRef: "cfg-src-1",
          version: "v1",
          identity: { tenantId: tenantScope.tenantId, customerId: ownership.customerId, projectId: ownership.projectId },
        },
        {
          kind: "POLICY",
          key: "retention",
          scope: "PROJECT",
          sourceRef: "pol-src-1",
          version: "v1",
          identity: { tenantId: tenantScope.tenantId, customerId: ownership.customerId, projectId: ownership.projectId },
        },
      ],
      decisionId: "decision-orbds-11",
      now: "2026-01-02T00:00:00.000Z",
    });
    const [effectiveConfigRef] = entry.resolution.effectiveConfigRefs;
    const [effectivePolicyRef] = entry.resolution.effectivePolicyRefs;
    assert.ok(effectiveConfigRef !== undefined && effectivePolicyRef !== undefined);

    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      effectiveConfigRefs: [effectiveConfigRef],
      effectivePolicyRefs: [effectivePolicyRef],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "READY");
    assert.deepEqual(status?.unresolvedGates, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns ACTION_REQUIRED (POLICY_NOT_CURRENT) when the durably-decided policy no longer includes the bound effectivePolicyRef", () => {
  const dir = freshDir("orbds-policy-drifted-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("12");

    membershipStore.create(membership);
    projectStore.create(project);

    resolveAndProjectConfigurationPolicyDecision({
      store: configurationPolicyDecisionStore,
      identity: { tenantId: tenantScope.tenantId, customerId: ownership.customerId, projectId: ownership.projectId },
      controls: [
        {
          kind: "POLICY",
          key: "retention",
          scope: "PROJECT",
          sourceRef: "pol-src-1",
          version: "v1",
          identity: { tenantId: tenantScope.tenantId, customerId: ownership.customerId, projectId: ownership.projectId },
        },
      ],
      decisionId: "decision-orbds-12",
      now: "2026-01-02T00:00:00.000Z",
    });

    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      // A policy ref the durable decision never produced (e.g. from a
      // superseded control) - the binding's own historical provenance
      // never changes, but current evidence now disagrees.
      effectivePolicyRefs: ["pol-ref-never-resolved"],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["POLICY_NOT_CURRENT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config/policy decision recorded for a DIFFERENT organization's project scope does not satisfy this binding's own bound effectiveConfigRefs (cross-scope isolation)", () => {
  const dir = freshDir("orbds-config-cross-scope-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("13");
    const other = fixture("13-other");

    membershipStore.create(membership);
    projectStore.create(project);

    // A decision recorded for a DIFFERENT customer/project under the same
    // tenant - same tenant file, different decisionKey partition.
    const { entry } = resolveAndProjectConfigurationPolicyDecision({
      store: configurationPolicyDecisionStore,
      identity: { tenantId: tenantScope.tenantId, customerId: other.customer.customerId, projectId: other.project.projectId },
      controls: [
        {
          kind: "CONFIG",
          key: "feature-flags",
          scope: "PROJECT",
          sourceRef: "cfg-src-1",
          version: "v1",
          identity: { tenantId: tenantScope.tenantId, customerId: other.customer.customerId, projectId: other.project.projectId },
        },
      ],
      decisionId: "decision-orbds-13-other",
      now: "2026-01-02T00:00:00.000Z",
    });
    const [foreignConfigRef] = entry.resolution.effectiveConfigRefs;
    assert.ok(foreignConfigRef !== undefined);

    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      effectiveConfigRefs: [foreignConfigRef],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["CONFIG_NOT_CURRENT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns ACTION_REQUIRED (SERVICE_PRINCIPAL_MISSING) when a bound servicePrincipalRef has no corresponding durable record", () => {
  const dir = freshDir("orbds-missing-service-principal-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("8");

    membershipStore.create(membership);
    projectStore.create(project);
    const servicePrincipal = createOrganizationServicePrincipal({
      servicePrincipalId: "sp-orbds-8",
      tenantScope,
      workerRef: "worker-orbds-8",
    });
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      servicePrincipals: [servicePrincipal],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    // Deliberately NOT saved into the durable service-principal store.

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["SERVICE_PRINCIPAL_MISSING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns READY once the bound service principal is durably saved and active", () => {
  const dir = freshDir("orbds-service-principal-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("9");

    membershipStore.create(membership);
    projectStore.create(project);
    const servicePrincipal = createOrganizationServicePrincipal({
      servicePrincipalId: "sp-orbds-9",
      tenantScope,
      workerRef: "worker-orbds-9",
    });
    servicePrincipalStore.create(servicePrincipal);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      servicePrincipals: [servicePrincipal],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns ACTION_REQUIRED (SERVICE_PRINCIPAL_REVOKED) once the bound service principal is revoked in the durable store", () => {
  const dir = freshDir("orbds-revoked-service-principal-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("10");

    membershipStore.create(membership);
    projectStore.create(project);
    const servicePrincipal = createOrganizationServicePrincipal({
      servicePrincipalId: "sp-orbds-10",
      tenantScope,
      workerRef: "worker-orbds-10",
    });
    servicePrincipalStore.create(servicePrincipal);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      servicePrincipals: [servicePrincipal],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    servicePrincipalStore.revoke({
      tenantId: tenantScope.tenantId,
      servicePrincipalId: servicePrincipal.servicePrincipalId,
      expectedVersion: 1,
      revokedAt: "2026-01-03T00:00:00.000Z",
      revokedReason: "worker decommissioned",
    });

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["SERVICE_PRINCIPAL_REVOKED"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never fabricates READY: a binding bootstrapped with non-empty knowledgeEvidenceRefs provenance blocks ACTION_REQUIRED (KNOWLEDGE_EVIDENCE_MISSING) until matching evidence is durably recorded", () => {
  const dir = freshDir("orbds-evidence-never-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("14");

    membershipStore.create(membership);
    projectStore.create(project);
    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      knowledgeEvidenceRefs: ["ev-bootstrap-provenance-only"],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    // Deliberately no evidence ever recorded in the durable evidence store.

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["KNOWLEDGE_EVIDENCE_MISSING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns READY once the bound knowledgeEvidenceRefs are durably recorded as evidence references for this binding's own tenant", () => {
  const dir = freshDir("orbds-evidence-ready-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, customer, organization, membership, project, ownership } = fixture("15");

    membershipStore.create(membership);
    projectStore.create(project);

    const job = createOutcomeJob({
      tenantScope,
      customer,
      project,
      jobId: "job-orbds-15",
      jobFamily: "family-x",
      businessObjective: "prove evidence currentness",
    });
    const evidence = createEvidenceReference({
      job,
      evidenceId: "ev-orbds-15",
      evidenceType: "VERIFICATION_ARTIFACT",
      sourceLocator: "https://example.invalid/evidence/15",
      capturedAt: "2026-01-02T00:00:00.000Z",
    });
    evidenceReferenceStore.record(evidence);

    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      knowledgeEvidenceRefs: [evidence.evidenceId],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "READY");
    assert.deepEqual(status?.unresolvedGates, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an evidence reference recorded for a DIFFERENT tenant does not satisfy this binding's own bound knowledgeEvidenceRefs (cross-tenant isolation)", () => {
  const dir = freshDir("orbds-evidence-cross-tenant-");
  try {
    const { bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore } = stores(dir);
    const { tenantScope, organization, membership, project, ownership } = fixture("16");
    const other = fixture("16-other");

    membershipStore.create(membership);
    projectStore.create(project);

    // Recorded under a DIFFERENT tenant's own evidence file, coincidentally
    // reusing the same evidenceId string this binding references.
    const otherJob = createOutcomeJob({
      tenantScope: other.tenantScope,
      customer: other.customer,
      project: other.project,
      jobId: "job-orbds-16-other",
      jobFamily: "family-x",
      businessObjective: "prove cross-tenant evidence isolation",
    });
    const foreignEvidence = createEvidenceReference({
      job: otherJob,
      evidenceId: "ev-orbds-16-shared-id",
      evidenceType: "VERIFICATION_ARTIFACT",
      sourceLocator: "https://example.invalid/evidence/16-other",
      capturedAt: "2026-01-02T00:00:00.000Z",
    });
    evidenceReferenceStore.record(foreignEvidence);

    const binding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      knowledgeEvidenceRefs: ["ev-orbds-16-shared-id"],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    bindingStore.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, servicePrincipalStore, projectStore, connectorConnectionStore, configurationPolicyDecisionStore, evidenceReferenceStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["KNOWLEDGE_EVIDENCE_MISSING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
