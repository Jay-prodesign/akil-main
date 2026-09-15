import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  createSecretRef,
  type ConnectionRequirement,
} from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import {
  createGenericApiConnectorDefinition,
  bindGenericApiDefinition,
  type GenericApiConnectorDefinition,
} from "../src/domain/generic-connector-definition.js";
import { resolvePrebuiltConnectorDefinition, bindPrebuiltDefinition } from "../src/domain/prebuilt-connector-definitions.js";
import {
  executeConnectorCapability,
  ConnectorExecutionNotAuthorizedError,
  UnresolvedConnectorSecretError,
  ConnectorExecutionAuthorizationError,
  ConnectorExecutionTransportError,
  type ConnectorTransport,
  type ConnectorTransportRequest,
  type SecretResolver,
} from "../src/domain/connector-execution.js";
import { InvalidGenericConnectorDefinitionError } from "../src/domain/generic-connector-definition.js";

function ownership(suffix = "a"): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: `akilta-tenant-${suffix}`,
    customerId: `customer-${suffix}`,
    projectId: `project-${suffix}`,
  });
}

function genericApiDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Generic API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:generic-ping"],
    isAiModelProvider: false,
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

function verifiedInstance(input: {
  ownershipRef: ProjectOwnershipRef;
  secretRefId?: string;
}): ConnectorConnectionInstance {
  const descriptor = genericApiDescriptor();
  const requirement = requirementFor(descriptor, input.ownershipRef);
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: `bind-${input.ownershipRef.tenantId}`,
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "API_KEY",
    ...(input.secretRefId !== undefined
      ? { secretRef: createSecretRef({ secretRefId: input.secretRefId }) }
      : {}),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectorConnection(unverified, "evidence:handshake");
}

function definitionFor(): GenericApiConnectorDefinition {
  return createGenericApiConnectorDefinition({
    connectionBindingId: "bind-akilta-tenant-a",
    baseUrl: "https://api.generic-example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:generic-ping", method: "GET", path: "/ping" }],
  });
}

class RecordingMockTransport implements ConnectorTransport {
  public readonly seenRequests: ConnectorTransportRequest[] = [];
  constructor(
    private readonly outcome: "SUCCESS" | "AUTHORIZATION_FAILED" | "TRANSPORT_ERROR" = "SUCCESS",
    private readonly data: unknown = { pong: true },
  ) {}
  execute(request: ConnectorTransportRequest) {
    this.seenRequests.push(request);
    if (this.outcome === "SUCCESS") {
      return { outcome: "SUCCESS" as const, data: this.data };
    }
    return { outcome: this.outcome, errorMessage: `mock ${this.outcome}` };
  }
}

class FixedSecretResolver implements SecretResolver {
  constructor(private readonly value: string) {}
  resolve(): string {
    return this.value;
  }
}

test("T1: a successful execution returns a ConnectorExecutionResult carrying the mock transport's data, and the resolved secret is passed to the transport but never appears in the result", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport("SUCCESS", { pong: true });
  const secretResolver = new FixedSecretResolver("sk-live-super-secret-value");

  const result = executeConnectorCapability({
    bound,
    capabilityRef: "cap:generic-ping",
    requestingOwnership: ownershipRef,
    secretResolver,
    transport,
  });

  assert.equal(result.connectorKind, "GENERIC_CUSTOM_API");
  assert.equal(result.capabilityRef, "cap:generic-ping");
  assert.deepEqual(result.data, { pong: true });

  // The secret WAS handed to the transport (as authSecretValue)...
  assert.equal(transport.seenRequests[0]?.authSecretValue, "sk-live-super-secret-value");
  // ...but never appears anywhere in the returned result.
  assert.ok(!JSON.stringify(result).includes("sk-live-super-secret-value"));
});

test("T2 (adversarial): requestingOwnership that does not match the connection's own tenant/customer/project fails closed, even with a valid capability and VERIFIED state", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport();

  const wrongOwnership = ownership("b");
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: wrongOwnership,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0, "transport must never be called when authorization fails");
});

test("T3 (adversarial): a non-VERIFIED connection (REQUESTED) cannot execute", () => {
  const ownershipRef = ownership("a");
  const descriptor = genericApiDescriptor();
  const requirement = requirementFor(descriptor, ownershipRef);
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-akilta-tenant-a",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-ref-1" }),
  });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("T4 (adversarial): a DEGRADED connection cannot execute", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const degraded: ConnectorConnectionInstance = {
    ...instance,
    binding: transitionConnectionBinding(instance.binding, "DEGRADED"),
  };
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance: degraded, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("T5 (adversarial): a REVOKED connection cannot execute", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const revoked: ConnectorConnectionInstance = {
    ...instance,
    binding: transitionConnectionBinding(instance.binding, "REVOKED"),
  };
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance: revoked, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("T6 (adversarial): an undeclared capabilityRef fails closed before any transport call", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:never-declared",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    InvalidGenericConnectorDefinitionError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("T7 (adversarial): a connection with no bound secretRef cannot execute (unresolved SecretRef)", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef }); // no secretRefId supplied
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    UnresolvedConnectorSecretError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("T8 (adversarial): a secretResolver that throws surfaces as UnresolvedConnectorSecretError, not a raw crash", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport();
  const throwingResolver: SecretResolver = {
    resolve(): string {
      throw new Error("vault unavailable");
    },
  };

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: throwingResolver,
        transport,
      }),
    UnresolvedConnectorSecretError,
  );
});

test("T9 (adversarial): a secretResolver returning an empty string is treated as unresolved", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver(""),
        transport,
      }),
    UnresolvedConnectorSecretError,
  );
});

test("T10 (adversarial): a transport-reported AUTHORIZATION_FAILED is surfaced as a thrown ConnectorExecutionAuthorizationError, never a silently-successful-shaped result", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport("AUTHORIZATION_FAILED");

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    ConnectorExecutionAuthorizationError,
  );
});

test("T11: a transport-reported TRANSPORT_ERROR is surfaced as a thrown ConnectorExecutionTransportError", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const transport = new RecordingMockTransport("TRANSPORT_ERROR");

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        secretResolver: new FixedSecretResolver("secret"),
        transport,
      }),
    ConnectorExecutionTransportError,
  );
});

test("T12 (GOOGLE_WORKSPACE multi-host): a Sheets endpoint's baseUrlOverride is used for the transport request, not the definition's own Docs baseUrl", () => {
  const ownershipRef = ownership("workspace");
  const descriptor = createConnectorDescriptor({
    connectorKind: "GOOGLE_WORKSPACE",
    displayName: "Google Workspace",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:workspace-sheets-read", "cap:workspace-docs-read"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-workspace",
    ownership: ownershipRef,
    requiredCapabilityRef: "cap:workspace-sheets-read",
    purpose: "workspace test",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "oauth",
    validationRequirement: "must respond 200",
  });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-workspace",
    workspaceRef: "workspace-ws",
    integrationInstanceRef: "instance-ws",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: "secret-workspace" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const instance = verifyConnectorConnection(unverified, "evidence:workspace-handshake");

  const definition = resolvePrebuiltConnectorDefinition("GOOGLE_WORKSPACE");
  const bound = bindPrebuiltDefinition({ instance, definition });
  const transport = new RecordingMockTransport("SUCCESS", { rows: [] });

  const result = executeConnectorCapability({
    bound,
    capabilityRef: "cap:workspace-sheets-read",
    requestingOwnership: ownershipRef,
    secretResolver: new FixedSecretResolver("secret-value"),
    transport,
  });

  assert.equal(result.capabilityRef, "cap:workspace-sheets-read");
  assert.equal(transport.seenRequests[0]?.baseUrl, "https://sheets.googleapis.com/v4");

  // A different capability on the same connection uses the definition's own
  // (Docs) baseUrl, not Sheets' override - proving per-endpoint resolution,
  // not a global override.
  executeConnectorCapability({
    bound,
    capabilityRef: "cap:workspace-docs-read",
    requestingOwnership: ownershipRef,
    secretResolver: new FixedSecretResolver("secret-value"),
    transport,
  });
  assert.equal(transport.seenRequests[1]?.baseUrl, "https://docs.googleapis.com/v1");
});

test("T13 (adversarial secret-leak proof): the resolved secret never appears anywhere in the ConnectorExecutionResult across a run with real-looking secret content", () => {
  const ownershipRef = ownership("a");
  const instance = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionFor();
  const bound = bindGenericApiDefinition({ instance, definition });
  const SECRET_VALUE = "sk-ant-api03-forbidden-leak-marker-zzz";
  const transport = new RecordingMockTransport("SUCCESS", { echo: "ok, not the secret" });

  const result = executeConnectorCapability({
    bound,
    capabilityRef: "cap:generic-ping",
    requestingOwnership: ownershipRef,
    secretResolver: new FixedSecretResolver(SECRET_VALUE),
    transport,
  });

  assert.ok(!JSON.stringify(result).includes(SECRET_VALUE));
});
