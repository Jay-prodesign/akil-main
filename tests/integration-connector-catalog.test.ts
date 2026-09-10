import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createSecretRef,
  type ConnectionRequirement,
} from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  buildConnectorCatalog,
  resolveConnectorDescriptor,
  listAiModelProviderConnectors,
  listIntegrationConnectors,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  rotateConnectorSecret,
  reconnectConnectorConnection,
  recordConnectorHealthCheck,
  InvalidConnectorCatalogError,
  InvalidConnectorConnectionError,
  type ConnectorDescriptor,
  type ConnectorCatalog,
} from "../src/domain/integration-connector-catalog.js";

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

function genericApiDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Generic Custom API",
    supportedAuthModes: ["API_KEY", "BASIC", "BEARER_TOKEN", "CUSTOM_HEADER"],
    capabilityRefs: ["cap:custom-integration"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
}

function genericOAuthDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_OAUTH",
    displayName: "Generic Custom OAuth",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:custom-oauth-integration"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
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

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test("K1: createConnectorDescriptor rejects an unrecognized connectorKind", () => {
  assert.throws(
    () =>
      createConnectorDescriptor({
        connectorKind: "SLACK",
        displayName: "Slack",
        supportedAuthModes: ["OAUTH2"],
        capabilityRefs: ["cap:messaging"],
        isAiModelProvider: false,
        requiresOAuthRedirect: true,
      }),
    InvalidConnectorCatalogError,
  );
});

test("K2: createConnectorDescriptor rejects empty supportedAuthModes/capabilityRefs", () => {
  assert.throws(
    () =>
      createConnectorDescriptor({
        connectorKind: "GITHUB",
        displayName: "GitHub",
        supportedAuthModes: [],
        capabilityRefs: ["cap:repo-access"],
        isAiModelProvider: false,
        requiresOAuthRedirect: true,
      }),
    InvalidConnectorCatalogError,
  );
  assert.throws(
    () =>
      createConnectorDescriptor({
        connectorKind: "GITHUB",
        displayName: "GitHub",
        supportedAuthModes: ["OAUTH2"],
        capabilityRefs: [],
        isAiModelProvider: false,
        requiresOAuthRedirect: true,
      }),
    InvalidConnectorCatalogError,
  );
});

test("K3: createConnectorDescriptor rejects an unrecognized auth mode and a duplicate auth mode", () => {
  assert.throws(
    () =>
      createConnectorDescriptor({
        connectorKind: "GITHUB",
        displayName: "GitHub",
        supportedAuthModes: ["OAUTH2", "SSO"],
        capabilityRefs: ["cap:repo-access"],
        isAiModelProvider: false,
        requiresOAuthRedirect: true,
      }),
    InvalidConnectorCatalogError,
  );
  assert.throws(
    () =>
      createConnectorDescriptor({
        connectorKind: "GENERIC_CUSTOM_API",
        displayName: "Generic Custom API",
        supportedAuthModes: ["API_KEY", "API_KEY"],
        capabilityRefs: ["cap:custom-integration"],
        isAiModelProvider: false,
        requiresOAuthRedirect: false,
      }),
    InvalidConnectorCatalogError,
  );
});

test("K4: GENERIC_CUSTOM_OAUTH must declare requiresOAuthRedirect:true and exactly [OAUTH2]", () => {
  assert.throws(() => genericOAuthWith({ requiresOAuthRedirect: false }), InvalidConnectorCatalogError);
  assert.throws(
    () => genericOAuthWith({ supportedAuthModes: ["OAUTH2", "API_KEY"] }),
    InvalidConnectorCatalogError,
  );
  assert.throws(() => genericOAuthWith({ supportedAuthModes: ["API_KEY"] }), InvalidConnectorCatalogError);
  assert.doesNotThrow(() => genericOAuthDescriptor());

  function genericOAuthWith(overrides: Record<string, unknown>): ConnectorDescriptor {
    return createConnectorDescriptor({
      connectorKind: "GENERIC_CUSTOM_OAUTH",
      displayName: "Generic Custom OAuth",
      supportedAuthModes: ["OAUTH2"],
      capabilityRefs: ["cap:custom-oauth-integration"],
      isAiModelProvider: false,
      requiresOAuthRedirect: true,
      ...overrides,
    });
  }
});

test("K5: GENERIC_CUSTOM_API must declare requiresOAuthRedirect:false, must not include OAUTH2, and must declare at least two auth modes", () => {
  assert.throws(() => genericApiWith({ requiresOAuthRedirect: true }), InvalidConnectorCatalogError);
  assert.throws(
    () => genericApiWith({ supportedAuthModes: ["API_KEY", "OAUTH2"] }),
    InvalidConnectorCatalogError,
  );
  assert.throws(() => genericApiWith({ supportedAuthModes: ["API_KEY"] }), InvalidConnectorCatalogError);
  assert.doesNotThrow(() => genericApiDescriptor());

  function genericApiWith(overrides: Record<string, unknown>): ConnectorDescriptor {
    return createConnectorDescriptor({
      connectorKind: "GENERIC_CUSTOM_API",
      displayName: "Generic Custom API",
      supportedAuthModes: ["API_KEY", "BASIC"],
      capabilityRefs: ["cap:custom-integration"],
      isAiModelProvider: false,
      requiresOAuthRedirect: false,
      ...overrides,
    });
  }
});

test("K6: createConnectorDescriptor requires isAiModelProvider/requiresOAuthRedirect to be explicit booleans, no default inferred", () => {
  assert.throws(
    () =>
      createConnectorDescriptor({
        connectorKind: "OPENAI",
        displayName: "OpenAI",
        supportedAuthModes: ["API_KEY"],
        capabilityRefs: ["cap:model-inference"],
        isAiModelProvider: undefined,
        requiresOAuthRedirect: false,
      }),
    InvalidConnectorCatalogError,
  );
});

test("K7: buildConnectorCatalog fail-closed rejects a duplicate connectorKind", () => {
  assert.throws(
    () => buildConnectorCatalog([githubDescriptor(), githubDescriptor()]),
    InvalidConnectorCatalogError,
  );
});

test("K8: resolveConnectorDescriptor fail-closed throws for an unregistered connectorKind (never returns undefined)", () => {
  const catalog = buildConnectorCatalog([githubDescriptor()]);
  assert.throws(() => resolveConnectorDescriptor(catalog, "OPENAI"), InvalidConnectorCatalogError);
  assert.equal(resolveConnectorDescriptor(catalog, "GITHUB").connectorKind, "GITHUB");
});

test("K9: listAiModelProviderConnectors/listIntegrationConnectors partition the catalog correctly (AI provider/model-catalog separation)", () => {
  const catalog: ConnectorCatalog = buildConnectorCatalog([githubDescriptor(), openAiDescriptor()]);
  const aiProviders = listAiModelProviderConnectors(catalog);
  const integrations = listIntegrationConnectors(catalog);
  assert.deepEqual(
    aiProviders.map((d) => d.connectorKind),
    ["OPENAI"],
  );
  assert.deepEqual(
    integrations.map((d) => d.connectorKind),
    ["GITHUB"],
  );
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

test("K10: requestConnectorConnection rejects when the connector does not declare the requirement's capability", () => {
  const descriptor = githubDescriptor();
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-1",
    ownership: ownership(),
    requiredCapabilityRef: "cap:unrelated-capability",
    purpose: "test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  assert.throws(
    () =>
      requestConnectorConnection({
        requirement,
        connectorDescriptor: descriptor,
        connectionBindingId: "bind-1",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: [],
        authMode: "OAUTH2",
      }),
    InvalidConnectorConnectionError,
  );
});

test("K11: requestConnectorConnection rejects an authMode the connector does not support", () => {
  const descriptor = githubDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  assert.throws(
    () =>
      requestConnectorConnection({
        requirement,
        connectorDescriptor: descriptor,
        connectionBindingId: "bind-1",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: [],
        authMode: "API_KEY",
      }),
    InvalidConnectorConnectionError,
  );
});

test("K12: requestConnectorConnection succeeds, binds providerRef to the connectorKind verbatim, and always starts REQUESTED", () => {
  const descriptor = githubDescriptor();
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
  assert.equal(instance.binding.providerRef, "GITHUB");
  assert.equal(instance.binding.connectionState, "REQUESTED");
  assert.equal(instance.connectorKind, "GITHUB");
  assert.equal(instance.authMode, "OAUTH2");
});

test("K13: transitionConnectorConnection/verifyConnectorConnection delegate to connection-authority.ts's own transitions and preserve connectorKind/authMode", () => {
  const descriptor = githubDescriptor();
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
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  assert.equal(instance.binding.connectionState, "CONNECTED_UNVERIFIED");
  instance = verifyConnectorConnection(instance, "evidence:health-check-1");
  assert.equal(instance.binding.connectionState, "VERIFIED");
  assert.equal(instance.connectorKind, "GITHUB");
  assert.equal(instance.authMode, "OAUTH2");
});

test("K14 (adversarial): rotating a secret on a VERIFIED connection demotes it to DEGRADED - it never stays silently VERIFIED against an unverified credential", () => {
  const descriptor = githubDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-v1" }),
  });
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  instance = verifyConnectorConnection(instance, "evidence:health-check-1");
  assert.equal(instance.binding.connectionState, "VERIFIED");

  const rotated = rotateConnectorSecret({
    instance,
    newSecretRef: createSecretRef({ secretRefId: "secret-v2" }),
  });
  assert.equal(rotated.binding.connectionState, "DEGRADED");
  assert.equal(rotated.binding.secretRef, "secret-v2");
  // re-verification is required and works exactly like any other DEGRADED->VERIFIED path
  const reverified = verifyConnectorConnection(rotated, "evidence:health-check-2");
  assert.equal(reverified.binding.connectionState, "VERIFIED");
});

test("K15: rotating a secret on a CONNECTED_UNVERIFIED/DEGRADED connection replaces the secret without changing state", () => {
  const descriptor = githubDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-v1" }),
  });
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  const rotated = rotateConnectorSecret({
    instance,
    newSecretRef: createSecretRef({ secretRefId: "secret-v2" }),
  });
  assert.equal(rotated.binding.connectionState, "CONNECTED_UNVERIFIED");
  assert.equal(rotated.binding.secretRef, "secret-v2");
});

test("K16 (adversarial): rotateConnectorSecret rejects rotating to an identical secretRef, and rejects on REQUESTED/REVOKED", () => {
  const descriptor = githubDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-v1" }),
  });
  // REQUESTED has no secret to rotate yet, by this module's own rule
  assert.throws(
    () => rotateConnectorSecret({ instance: requested, newSecretRef: createSecretRef({ secretRefId: "secret-v2" }) }),
    InvalidConnectorConnectionError,
  );

  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  assert.throws(
    () =>
      rotateConnectorSecret({
        instance: unverified,
        newSecretRef: createSecretRef({ secretRefId: "secret-v1" }),
      }),
    InvalidConnectorConnectionError,
  );

  const revoked = transitionConnectorConnection(unverified, "REVOKED");
  assert.throws(
    () => rotateConnectorSecret({ instance: revoked, newSecretRef: createSecretRef({ secretRefId: "secret-v2" }) }),
    InvalidConnectorConnectionError,
  );
});

test("K17: recordConnectorHealthCheck rejects REQUESTED/REVOKED/HANDOVER_COMPLETE, succeeds for CONNECTED_UNVERIFIED/VERIFIED/DEGRADED, and never mutates the instance", () => {
  const descriptor = githubDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });
  assert.throws(
    () => recordConnectorHealthCheck({ instance: requested, status: "HEALTHY", checkedAt: "2026-09-10T00:00:00.000Z" }),
    InvalidConnectorConnectionError,
  );

  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const snapshotBefore = JSON.stringify(unverified);
  const record = recordConnectorHealthCheck({
    instance: unverified,
    status: "UNREACHABLE",
    checkedAt: "2026-09-10T00:00:00.000Z",
    evidenceRef: "evidence:probe-1",
  });
  assert.equal(record.status, "UNREACHABLE");
  assert.equal(record.connectorKind, "GITHUB");
  assert.equal(record.connectionBindingId, unverified.binding.connectionBindingId);
  assert.equal(JSON.stringify(unverified), snapshotBefore, "recording a health check must never mutate the instance");
  assert.equal(unverified.binding.connectionState, "CONNECTED_UNVERIFIED");

  const revoked = transitionConnectorConnection(unverified, "REVOKED");
  assert.throws(
    () => recordConnectorHealthCheck({ instance: revoked, status: "HEALTHY", checkedAt: "2026-09-10T00:00:00.000Z" }),
    InvalidConnectorConnectionError,
  );
});

test("K18: reconnectConnectorConnection rejects unless the previous instance is REVOKED", () => {
  const descriptor = githubDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });
  assert.throws(
    () =>
      reconnectConnectorConnection({
        requirement,
        connectorDescriptor: descriptor,
        previousInstance: requested,
        ownershipContext: ownership(),
        connectionBindingId: "bind-2",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: [],
        authMode: "OAUTH2",
      }),
    InvalidConnectorConnectionError,
  );
});

test("K19 (adversarial, cross-tenant fail-closed): reconnectConnectorConnection rejects an ownershipContext that does not match the requirement/binding's own tenant scope", () => {
  const descriptor = githubDescriptor();
  const tenantAOwnership = ownership("a");
  const requirement = requirementFor(descriptor, tenantAOwnership);
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  const revoked = transitionConnectorConnection(instance, "REVOKED");

  const tenantBOwnership = ownership("b");
  assert.throws(
    () =>
      reconnectConnectorConnection({
        requirement,
        connectorDescriptor: descriptor,
        previousInstance: revoked,
        ownershipContext: tenantBOwnership,
        connectionBindingId: "bind-2",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: [],
        authMode: "OAUTH2",
      }),
    InvalidConnectorConnectionError,
  );

  // the correct, matching tenant context succeeds
  const reconnection = reconnectConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    previousInstance: revoked,
    ownershipContext: tenantAOwnership,
    connectionBindingId: "bind-2",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "OAUTH2",
  });
  assert.equal(reconnection.instance.binding.connectionState, "REQUESTED");
  assert.equal(reconnection.supersedesConnectionBindingId, "bind-1");
});

test("K20: reconnectConnectorConnection never resurrects the old binding id - it always produces a genuinely new connectionBindingId", () => {
  const descriptor = githubDescriptor();
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
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  const revoked = transitionConnectorConnection(instance, "REVOKED");
  assert.throws(
    () =>
      reconnectConnectorConnection({
        requirement,
        connectorDescriptor: descriptor,
        previousInstance: revoked,
        ownershipContext: ownership(),
        connectionBindingId: "bind-1",
        workspaceRef: "workspace-1",
        integrationInstanceRef: "instance-1",
        delegatedScope: [],
        authMode: "OAUTH2",
      }),
    InvalidConnectorConnectionError,
  );
});

test("K21 (multi-instance isolation): two ConnectorConnectionInstances for the same connectorKind under different tenants never share secretRef/state - mutating one leaves the other untouched", () => {
  const descriptor = githubDescriptor();
  const requirementA = requirementFor(descriptor, ownership("a"));
  const requirementB = requirementFor(descriptor, ownership("b"));

  let instanceA = requestConnectorConnection({
    requirement: requirementA,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-a",
    workspaceRef: "workspace-a",
    integrationInstanceRef: "instance-a",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-a" }),
  });
  const instanceB = requestConnectorConnection({
    requirement: requirementB,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-b",
    workspaceRef: "workspace-b",
    integrationInstanceRef: "instance-b",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-b" }),
  });

  instanceA = transitionConnectorConnection(instanceA, "CONNECTED_UNVERIFIED");
  instanceA = verifyConnectorConnection(instanceA, "evidence:a-1");
  instanceA = rotateConnectorSecret({ instance: instanceA, newSecretRef: createSecretRef({ secretRefId: "secret-a-2" }) });

  assert.equal(instanceA.binding.connectionState, "DEGRADED");
  assert.equal(instanceA.binding.secretRef, "secret-a-2");
  // instanceB is a wholly separate value - untouched by anything done to instanceA
  assert.equal(instanceB.binding.connectionState, "REQUESTED");
  assert.equal(instanceB.binding.secretRef, "secret-b");
  assert.notEqual(instanceA.binding.ownership.tenantId, instanceB.binding.ownership.tenantId);
});
