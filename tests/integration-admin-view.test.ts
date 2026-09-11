import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef, type ConnectionRequirement } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  buildConnectorCatalog,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import { buildIntegrationsAdminView } from "../src/domain/integration-admin-view.js";

function ownership(tenantSuffix = "a"): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: `akilta-tenant-${tenantSuffix}`,
    customerId: `customer-${tenantSuffix}`,
    projectId: `project-${tenantSuffix}`,
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

function openAiDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "OPENAI",
    displayName: "OpenAI",
    supportedAuthModes: ["API_KEY"],
    capabilityRefs: ["cap:model-inference"],
    isAiModelProvider: true,
    requiresOAuthRedirect: false,
  });
}

function requirementFor(descriptor: ConnectorDescriptor, ownershipRef: ProjectOwnershipRef): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: `req-${descriptor.connectorKind}-${ownershipRef.tenantId}`,
    ownership: ownershipRef,
    requiredCapabilityRef: descriptor.capabilityRefs[0] as string,
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
}

test("N1: buildIntegrationsAdminView lists every catalog descriptor's public fields, and no others", () => {
  const catalog = buildConnectorCatalog([githubDescriptor(), openAiDescriptor()]);
  const view = buildIntegrationsAdminView({ catalog, connections: [] });
  assert.equal(view.availableConnectors.length, 2);
  const github = view.availableConnectors.find((c) => c.connectorKind === "GITHUB");
  assert.ok(github);
  assert.equal(github?.displayName, "GitHub");
  assert.deepEqual(github?.supportedAuthModes, ["OAUTH2"]);
  assert.equal(github?.isAiModelProvider, false);
  assert.equal(github?.requiresOAuthRedirect, true);
});

test("N2 (adversarial, secret-masking): the admin view's connection summaries never carry a secretRef field, even for a connection that has one", () => {
  const descriptor = githubDescriptor();
  const catalog = buildConnectorCatalog([descriptor]);
  const requirement = requirementFor(descriptor, ownership());
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-should-never-appear" }),
  });

  const view = buildIntegrationsAdminView({
    catalog,
    connections: [{ instance, version: 1 }],
  });

  assert.equal(view.connections.length, 1);
  const summary = view.connections[0] as unknown as Record<string, unknown>;
  assert.equal("secretRef" in summary, false);
  assert.equal(JSON.stringify(view).includes("secret-should-never-appear"), false);
});

test("N3: connection summaries expose connectionState, ownership, and version, and verificationEvidenceRef only when present", () => {
  const descriptor = githubDescriptor();
  const catalog = buildConnectorCatalog([descriptor]);
  const requirement = requirementFor(descriptor, ownership());
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });

  const unverifiedView = buildIntegrationsAdminView({ catalog, connections: [{ instance, version: 1 }] });
  assert.equal(unverifiedView.connections[0]?.connectionState, "REQUESTED");
  assert.equal("verificationEvidenceRef" in (unverifiedView.connections[0] as object), false);

  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  instance = verifyConnectorConnection(instance, "evidence:admin-view-1");
  const verifiedView = buildIntegrationsAdminView({ catalog, connections: [{ instance, version: 2 }] });
  assert.equal(verifiedView.connections[0]?.connectionState, "VERIFIED");
  assert.equal(verifiedView.connections[0]?.verificationEvidenceRef, "evidence:admin-view-1");
  assert.equal(verifiedView.connections[0]?.ownership.tenantId, requirement.ownership.tenantId);
  assert.equal(verifiedView.connections[0]?.version, 2);
});

test("N4 (cross-tenant, matching V5-CMD-001's precedent): the admin view aggregates connections across every tenant - deliberately, for an internal company-wide surface", () => {
  const descriptor = githubDescriptor();
  const catalog = buildConnectorCatalog([descriptor]);

  const requirementA = requirementFor(descriptor, ownership("a"));
  const instanceA = requestConnectorConnection({
    requirement: requirementA,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-a",
    workspaceRef: "workspace-a",
    integrationInstanceRef: "instance-a",
    delegatedScope: [],
    authMode: "OAUTH2",
  });

  const requirementB = requirementFor(descriptor, ownership("b"));
  const instanceB = requestConnectorConnection({
    requirement: requirementB,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-b",
    workspaceRef: "workspace-b",
    integrationInstanceRef: "instance-b",
    delegatedScope: [],
    authMode: "OAUTH2",
  });

  const view = buildIntegrationsAdminView({
    catalog,
    connections: [
      { instance: instanceA, version: 1 },
      { instance: instanceB, version: 1 },
    ],
  });
  assert.equal(view.connections.length, 2);
  assert.notEqual(view.connections[0]?.ownership.tenantId, view.connections[1]?.ownership.tenantId);
});

test("N5: this function adds no independent judgment - the availableConnectors/connections arrays are derived fresh each call, never mutating the inputs", () => {
  const descriptor = githubDescriptor();
  const catalog = buildConnectorCatalog([descriptor]);
  const requirement = requirementFor(descriptor, ownership());
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });
  const connections = [{ instance, version: 1 }];
  const snapshotBefore = JSON.stringify(connections);
  buildIntegrationsAdminView({ catalog, connections });
  assert.equal(JSON.stringify(connections), snapshotBefore);
});
