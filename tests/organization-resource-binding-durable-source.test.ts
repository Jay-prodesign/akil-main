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
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { createDurableOrganizationResourceBindingSource } from "../src/web/organization-resource-binding-durable-source.js";

/**
 * ORG-MEMBERSHIP-DURABLE-001: proves `createDurableOrganizationResourceBindingSource`
 * composes the durable OrganizationResourceBinding/OrganizationMembership/
 * Project/ConnectorConnection stores into a real, truthful
 * `OrganizationResourceBindingSource` - READY on the real golden path,
 * `undefined` (never bootstrapped) when no binding exists, and
 * BLOCKED/ACTION_REQUIRED exactly where `resolveOrganizationResourceBindingStatus`'s
 * own gates say so, including dimensions (effective config/policy, worker
 * routes, knowledge evidence, service principals) this adapter deliberately
 * never fabricates current evidence for.
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
    projectStore: new FileDurableProjectStore(join(dir, "projects")),
    connectorConnectionStore: new FileDurableConnectorConnectionStore(join(dir, "connectors")),
  };
}

test("resolveStatus returns undefined when the organization has never been bootstrapped (no binding exists)", () => {
  const dir = freshDir("orbds-undefined-");
  try {
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
    const { organization } = fixture("1");
    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
    assert.equal(source.resolveStatus(organization), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStatus returns READY end-to-end once binding + current membership + current project are all durably wired", () => {
  const dir = freshDir("orbds-ready-");
  try {
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
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

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
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
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
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

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
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
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
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

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
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
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
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

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
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
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
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

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never fabricates READY: a binding bootstrapped with non-empty effectiveConfigRefs provenance blocks ACTION_REQUIRED (CONFIG_NOT_CURRENT) forever, since no durable current-config registry exists yet", () => {
  const dir = freshDir("orbds-config-never-ready-");
  try {
    const { bindingStore, membershipStore, projectStore, connectorConnectionStore } = stores(dir);
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

    const source = createDurableOrganizationResourceBindingSource(bindingStore, membershipStore, projectStore, connectorConnectionStore);
    const status = source.resolveStatus(organization);
    assert.equal(status?.state, "ACTION_REQUIRED");
    assert.deepEqual(status?.unresolvedGates, ["CONFIG_NOT_CURRENT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
