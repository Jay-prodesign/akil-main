import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, type ConnectionRequirement } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import {
  createGenericApiConnectorDefinition,
  createGenericOAuthConnectorDefinition,
  resolveEndpointForCapability,
  bindGenericApiDefinition,
  bindGenericOAuthDefinition,
  InvalidGenericConnectorDefinitionError,
} from "../src/domain/generic-connector-definition.js";

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: "akilta-tenant-a",
    customerId: "customer-a",
    projectId: "project-a",
  });
}

function genericApiDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Generic Custom API",
    supportedAuthModes: ["API_KEY", "BASIC"],
    capabilityRefs: ["cap:custom-a", "cap:custom-b"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
}

function genericOAuthDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_OAUTH",
    displayName: "Generic Custom OAuth",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:custom-oauth-a"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
}

function requirementFor(descriptor: ConnectorDescriptor, ownershipRef: ProjectOwnershipRef): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: `req-${descriptor.connectorKind}`,
    ownership: ownershipRef,
    requiredCapabilityRef: descriptor.capabilityRefs[0] as string,
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
}

function validApiEndpoints() {
  return [
    { capabilityRef: "cap:custom-a", method: "GET", path: "/v1/resource" },
    { capabilityRef: "cap:custom-b", method: "POST", path: "/v1/resource" },
  ];
}

test("P1: createGenericApiConnectorDefinition rejects an invalid baseUrl", () => {
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "not-a-url",
        authMode: "API_KEY",
        endpoints: validApiEndpoints(),
      }),
    InvalidGenericConnectorDefinitionError,
  );
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "ftp://example.com",
        authMode: "API_KEY",
        endpoints: validApiEndpoints(),
      }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P2 (adversarial): createGenericApiConnectorDefinition rejects OAUTH2 as an auth mode - that is exclusively the Generic OAuth Connector's territory", () => {
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "https://api.example.com",
        authMode: "OAUTH2",
        endpoints: validApiEndpoints(),
      }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P3 (adversarial): endpoints with a duplicate capabilityRef are rejected - capability resolution would otherwise be ambiguous", () => {
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "https://api.example.com",
        authMode: "API_KEY",
        endpoints: [
          { capabilityRef: "cap:custom-a", method: "GET", path: "/v1/a" },
          { capabilityRef: "cap:custom-a", method: "POST", path: "/v1/a-again" },
        ],
      }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P4: endpoints must have a recognized method and a path starting with '/'", () => {
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "https://api.example.com",
        authMode: "API_KEY",
        endpoints: [{ capabilityRef: "cap:custom-a", method: "TRACE", path: "/v1/a" }],
      }),
    InvalidGenericConnectorDefinitionError,
  );
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "https://api.example.com",
        authMode: "API_KEY",
        endpoints: [{ capabilityRef: "cap:custom-a", method: "GET", path: "v1/a" }],
      }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P5 (adversarial): validationEndpointCapabilityRef must reference an endpoint the definition actually declares", () => {
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "https://api.example.com",
        authMode: "API_KEY",
        endpoints: validApiEndpoints(),
        validationEndpointCapabilityRef: "cap:does-not-exist",
      }),
    InvalidGenericConnectorDefinitionError,
  );

  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-1",
    baseUrl: "https://api.example.com",
    authMode: "API_KEY",
    endpoints: validApiEndpoints(),
    validationEndpointCapabilityRef: "cap:custom-a",
  });
  assert.equal(definition.validationEndpointCapabilityRef, "cap:custom-a");
});

test("P6: rateLimitPerMinute/retryMaxAttempts must be positive integers when supplied, and are omitted entirely when not", () => {
  assert.throws(
    () =>
      createGenericApiConnectorDefinition({
        connectionBindingId: "bind-1",
        baseUrl: "https://api.example.com",
        authMode: "API_KEY",
        endpoints: validApiEndpoints(),
        rateLimitPerMinute: -1,
      }),
    InvalidGenericConnectorDefinitionError,
  );
  const withoutOptional = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-1",
    baseUrl: "https://api.example.com",
    authMode: "API_KEY",
    endpoints: validApiEndpoints(),
  });
  assert.equal("rateLimitPerMinute" in withoutOptional, false);
  assert.equal("retryMaxAttempts" in withoutOptional, false);
});

test("P7: resolveEndpointForCapability fail-closed throws for an undeclared capability, never returns undefined", () => {
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-1",
    baseUrl: "https://api.example.com",
    authMode: "API_KEY",
    endpoints: validApiEndpoints(),
  });
  assert.throws(
    () => resolveEndpointForCapability(definition, "cap:unregistered"),
    InvalidGenericConnectorDefinitionError,
  );
  const resolved = resolveEndpointForCapability(definition, "cap:custom-b");
  assert.equal(resolved.method, "POST");
});

test("P8: createGenericOAuthConnectorDefinition rejects invalid URLs, empty/duplicate scopes", () => {
  assert.throws(
    () =>
      createGenericOAuthConnectorDefinition({
        connectionBindingId: "bind-1",
        authorizationUrl: "not-a-url",
        tokenUrl: "https://api.example.com/token",
        scopes: ["read"],
        endpoints: validApiEndpoints(),
      }),
    InvalidGenericConnectorDefinitionError,
  );
  assert.throws(
    () =>
      createGenericOAuthConnectorDefinition({
        connectionBindingId: "bind-1",
        authorizationUrl: "https://api.example.com/authorize",
        tokenUrl: "https://api.example.com/token",
        scopes: [],
        endpoints: validApiEndpoints(),
      }),
    InvalidGenericConnectorDefinitionError,
  );
  assert.throws(
    () =>
      createGenericOAuthConnectorDefinition({
        connectionBindingId: "bind-1",
        authorizationUrl: "https://api.example.com/authorize",
        tokenUrl: "https://api.example.com/token",
        scopes: ["read", "read"],
        endpoints: validApiEndpoints(),
      }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P9: bindGenericApiDefinition fail-closed rejects a mismatched connectorKind, connectionBindingId, or authMode", () => {
  const descriptor = genericApiDescriptor();
  const requirement = requirementFor(descriptor, ownership());
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "API_KEY",
  });
  const matchingDefinition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-1",
    baseUrl: "https://api.example.com",
    authMode: "API_KEY",
    endpoints: validApiEndpoints(),
  });
  assert.doesNotThrow(() => bindGenericApiDefinition({ instance, definition: matchingDefinition }));

  const wrongBindingId = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-other",
    baseUrl: "https://api.example.com",
    authMode: "API_KEY",
    endpoints: validApiEndpoints(),
  });
  assert.throws(
    () => bindGenericApiDefinition({ instance, definition: wrongBindingId }),
    InvalidGenericConnectorDefinitionError,
  );

  const wrongAuthMode = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-1",
    baseUrl: "https://api.example.com",
    authMode: "BASIC",
    endpoints: validApiEndpoints(),
  });
  assert.throws(
    () => bindGenericApiDefinition({ instance, definition: wrongAuthMode }),
    InvalidGenericConnectorDefinitionError,
  );

  // an OpenAI-style instance (not GENERIC_CUSTOM_API at all) can never bind a Generic API definition
  const otherDescriptor = createConnectorDescriptor({
    connectorKind: "OPENAI",
    displayName: "OpenAI",
    supportedAuthModes: ["API_KEY"],
    capabilityRefs: ["cap:model-inference"],
    isAiModelProvider: true,
    requiresOAuthRedirect: false,
  });
  const otherRequirement = requirementFor(otherDescriptor, ownership());
  const otherInstance = requestConnectorConnection({
    requirement: otherRequirement,
    connectorDescriptor: otherDescriptor,
    connectionBindingId: "bind-openai",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "API_KEY",
  });
  assert.throws(
    () =>
      bindGenericApiDefinition({
        instance: otherInstance,
        definition: createGenericApiConnectorDefinition({
          connectionBindingId: "bind-openai",
          baseUrl: "https://api.example.com",
          authMode: "API_KEY",
          endpoints: validApiEndpoints(),
        }),
      }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P10: bindGenericOAuthDefinition fail-closed rejects a mismatched connectorKind or connectionBindingId, and succeeds on a genuine match", () => {
  const descriptor = genericOAuthDescriptor();
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
  const definition = createGenericOAuthConnectorDefinition({
    connectionBindingId: "bind-1",
    authorizationUrl: "https://api.example.com/authorize",
    tokenUrl: "https://api.example.com/token",
    scopes: ["read", "write"],
    endpoints: [{ capabilityRef: "cap:custom-oauth-a", method: "GET", path: "/v1/resource" }],
  });
  assert.doesNotThrow(() => bindGenericOAuthDefinition({ instance, definition }));

  const wrongBindingId = createGenericOAuthConnectorDefinition({
    connectionBindingId: "bind-other",
    authorizationUrl: "https://api.example.com/authorize",
    tokenUrl: "https://api.example.com/token",
    scopes: ["read"],
    endpoints: [{ capabilityRef: "cap:custom-oauth-a", method: "GET", path: "/v1/resource" }],
  });
  assert.throws(
    () => bindGenericOAuthDefinition({ instance, definition: wrongBindingId }),
    InvalidGenericConnectorDefinitionError,
  );
});

test("P11 (multi-instance): two independent GenericApiConnectorDefinitions for different connectionBindingIds coexist with no shared state", () => {
  const definitionA = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-a",
    baseUrl: "https://a.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:custom-a", method: "GET", path: "/v1/a" }],
  });
  const definitionB = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-b",
    baseUrl: "https://b.example.com",
    authMode: "BASIC",
    endpoints: [{ capabilityRef: "cap:custom-b", method: "POST", path: "/v1/b" }],
  });
  assert.notEqual(definitionA.baseUrl, definitionB.baseUrl);
  assert.notEqual(definitionA.authMode, definitionB.authMode);
  assert.throws(() => resolveEndpointForCapability(definitionA, "cap:custom-b"), InvalidGenericConnectorDefinitionError);
  assert.throws(() => resolveEndpointForCapability(definitionB, "cap:custom-a"), InvalidGenericConnectorDefinitionError);
});
