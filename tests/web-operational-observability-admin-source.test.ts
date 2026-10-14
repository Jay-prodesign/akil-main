import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { createDurableOperationalObservabilitySource } from "../src/web/operational-observability-admin-source.js";
import { resolveOperationalObservabilityView } from "../src/web/internal-os-view-state.js";

/**
 * OBS-ADMIN-SOURCE-001: proves `createDurableOperationalObservabilitySource`
 * genuinely connects OS-V0-12's `OperationalObservabilitySource` port to
 * the real `FileDurableConnectorConnectionStore` for the connection
 * dimension - no longer only an abstract optional source - and that a
 * corrupted tenant file degrades to a safe empty view rather than
 * crashing the whole `/os/admin` render.
 */

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "obs-admin-source-001-"));
}

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function organizationFor(tenantSuffix: string): Organization {
  const tenantScope = createTenantScope(`tenant-obs-${tenantSuffix}`);
  return activateOrganization({
    organization: createOrganization({
      organizationId: `org-obs-${tenantSuffix}`,
      tenantScope,
      displayName: `Obs Org ${tenantSuffix}`,
      createdAt: "2026-10-14T00:00:00.000Z",
    }),
    activatedAt: "2026-10-14T00:00:01.000Z",
  });
}

function ownershipFor(organization: Organization): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: organization.tenantId,
    customerId: `customer-${organization.organizationId}`,
    projectId: `project-${organization.organizationId}`,
  });
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

function connectionInstanceFor(organization: Organization, connectionBindingId: string) {
  const ownership = ownershipFor(organization);
  const descriptor = githubDescriptor();
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${connectionBindingId}`,
    ownership,
    requiredCapabilityRef: descriptor.capabilityRefs[0] as string,
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  return requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });
}

test("createDurableOperationalObservabilitySource surfaces a real connection for the organization's tenant", () => {
  const dir = freshStoreDir();
  try {
    const organization = organizationFor("1");
    const store = new FileDurableConnectorConnectionStore(dir);
    store.save(connectionInstanceFor(organization, "bind-obs-1"));

    const source = createDurableOperationalObservabilitySource(store);
    const view = source.resolveView(organization);
    assert.equal(view.connections.length, 1);
    assert.equal(view.connections[0]?.connectionBindingId, "bind-obs-1");
    assert.equal(view.connections[0]?.connectionState, "REQUESTED");
    assert.equal(view.connections[0]?.killSwitchEngaged, false);
    assert.deepEqual(view.task, undefined);
    assert.equal(view.pendingApprovals.length, 0);
    assert.equal(view.auditEvidence.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableOperationalObservabilitySource surfaces killSwitchEngaged for a REVOKED connection", () => {
  const dir = freshStoreDir();
  try {
    const organization = organizationFor("2");
    const store = new FileDurableConnectorConnectionStore(dir);
    const instance = connectionInstanceFor(organization, "bind-obs-2");
    const saved = store.save(instance);
    store.save(transitionConnectorConnection(saved.instance, "REVOKED"), saved.version);

    const source = createDurableOperationalObservabilitySource(store);
    const view = source.resolveView(organization);
    assert.equal(view.connections.length, 1);
    assert.equal(view.connections[0]?.connectionState, "REVOKED");
    assert.equal(view.connections[0]?.killSwitchEngaged, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableOperationalObservabilitySource returns an empty-but-valid view when the tenant has never bootstrapped any connection", () => {
  const dir = freshStoreDir();
  try {
    const organization = organizationFor("3");
    const store = new FileDurableConnectorConnectionStore(dir);

    const source = createDurableOperationalObservabilitySource(store);
    const view = source.resolveView(organization);
    assert.equal(view.connections.length, 0);

    const resolved = resolveOperationalObservabilityView(organization, source);
    assert.equal(resolved.kind, "READY");
    if (resolved.kind === "READY") {
      assert.equal(resolved.view.connections.length, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableOperationalObservabilitySource never surfaces a different tenant's connections", () => {
  const dir = freshStoreDir();
  try {
    const organizationA = organizationFor("4a");
    const organizationB = organizationFor("4b");
    const store = new FileDurableConnectorConnectionStore(dir);
    store.save(connectionInstanceFor(organizationA, "bind-obs-4"));

    const source = createDurableOperationalObservabilitySource(store);
    assert.equal(source.resolveView(organizationB).connections.length, 0);
    assert.equal(source.resolveView(organizationA).connections.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableOperationalObservabilitySource degrades to an empty view instead of throwing when the tenant file is corrupted", () => {
  const dir = freshStoreDir();
  try {
    const organization = organizationFor("5");
    const store = new FileDurableConnectorConnectionStore(dir);
    store.save(connectionInstanceFor(organization, "bind-obs-5"));

    writeFileSync(tenantFilePath(dir, organization.tenantId), "{ not valid json garbage", "utf8");

    const source = createDurableOperationalObservabilitySource(store);
    const view = source.resolveView(organization);
    assert.equal(view.connections.length, 0);

    const resolved = resolveOperationalObservabilityView(organization, source);
    assert.equal(resolved.kind, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
