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
  rotateConnectorSecret,
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
  type CurrentConnectorConnectionReader,
} from "../src/domain/connector-execution.js";
import { InvalidGenericConnectorDefinitionError } from "../src/domain/generic-connector-definition.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityAdmission } from "../src/domain/capability-admission.js";

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

/**
 * OS-V0-06: a minimal, tenant-scoped `CurrentConnectorConnectionReader` fake
 * - it only returns a record when BOTH the queried tenantId and
 * connectionBindingId match, exactly like a real per-tenant durable store
 * would (a lookup under the wrong tenant or a different binding id finds
 * nothing) - so tests exercise the same fail-closed shape a real store
 * produces, without needing a real store for every unit test.
 */
function currentStoreFor(instance: ConnectorConnectionInstance): CurrentConnectorConnectionReader {
  return {
    get(tenantId, connectionBindingId) {
      if (tenantId !== instance.binding.ownership.tenantId) {
        return undefined;
      }
      if (connectionBindingId !== instance.binding.connectionBindingId) {
        return undefined;
      }
      return { instance, version: 1 };
    },
  };
}

function definitionFor(): GenericApiConnectorDefinition {
  return definitionForBinding("bind-akilta-tenant-a");
}

/** Like `definitionFor()`, but for a caller-supplied `connectionBindingId` - needed once tests stop hardcoding a single shared tenant/binding id. */
function definitionForBinding(connectionBindingId: string): GenericApiConnectorDefinition {
  return createGenericApiConnectorDefinition({
    connectionBindingId,
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
    connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(degraded),
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
        connectionStore: currentStoreFor(revoked),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
        connectionStore: currentStoreFor(instance),
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
    connectionStore: currentStoreFor(instance),
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
    connectionStore: currentStoreFor(instance),
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
    connectionStore: currentStoreFor(instance),
    secretResolver: new FixedSecretResolver(SECRET_VALUE),
    transport,
  });

  assert.ok(!JSON.stringify(result).includes(SECRET_VALUE));
});

// ---------------------------------------------------------------------------
// OS-V0-06: execution-time currentness witnesses (Rev171 pre-admission
// packet's 12 mandatory adversarial witnesses). T1-T13 above already prove
// witnesses 9 (secretResolver throws/empty -> no transport, T8/T9) and 10
// (successful current VERIFIED path invokes transport once with no secret
// leak, T1/T13) once `connectionStore` is wired through - no separate test
// duplicates those. The remaining witnesses are new below.
// ---------------------------------------------------------------------------

/** Proves the secret resolver is never even called - not merely that its return value is ignored. */
class ExplodingSecretResolver implements SecretResolver {
  resolve(secretRefId: string): string {
    throw new Error(`SecretResolver.resolve must never be called in this scenario - was called with secretRefId="${secretRefId}"`);
  }
}

class RecordingSecretResolver implements SecretResolver {
  public readonly seenSecretRefIds: string[] = [];
  constructor(private readonly valuesBySecretRefId: Readonly<Record<string, string>>) {}
  resolve(secretRefId: string): string {
    this.seenSecretRefIds.push(secretRefId);
    const value = this.valuesBySecretRefId[secretRefId];
    if (value === undefined) {
      throw new Error(`RecordingSecretResolver has no fixture value for secretRefId "${secretRefId}"`);
    }
    return value;
  }
}

/**
 * A raw fake store that returns exactly the given instance regardless of the
 * queried tenantId/connectionBindingId - unlike `currentStoreFor`, this
 * simulates a store record actually existing under a colliding/foreign key
 * (used only for the ownership/collision witnesses below, where the point is
 * that `executeConnectorCapability`'s OWN ownership check, not the store's
 * lookup semantics, must be what fails it closed).
 */
function storeAlwaysReturning(instance: ConnectorConnectionInstance): CurrentConnectorConnectionReader {
  return { get: () => ({ instance, version: 1 }) };
}

function sameTenantOwnership(customerSuffix: string, projectSuffix: string): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: "akilta-tenant-shared",
    customerId: `customer-${customerSuffix}`,
    projectId: `project-${projectSuffix}`,
  });
}

test("R1 (OS-V0-06 witness 1, adversarial): a stale caller-held VERIFIED instance is rejected when the current durable connection is REVOKED - zero secret resolution, zero transport", () => {
  const ownershipRef = ownership("r1");
  const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const currentRevoked: ConnectorConnectionInstance = {
    ...staleVerified,
    binding: transitionConnectionBinding(staleVerified.binding, "REVOKED"),
  };
  const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: currentStoreFor(currentRevoked),
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R2 (OS-V0-06 witness 2, adversarial): a stale caller-held VERIFIED instance is rejected when the current durable connection is DEGRADED - zero secret resolution, zero transport", () => {
  const ownershipRef = ownership("r2");
  const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const currentDegraded: ConnectorConnectionInstance = {
    ...staleVerified,
    binding: transitionConnectionBinding(staleVerified.binding, "DEGRADED"),
  };
  const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: currentStoreFor(currentDegraded),
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R3 (OS-V0-06 witness 3, adversarial): stale caller secretRef A is never resolved when the current durable connection was rotated to secretRef B and demoted to DEGRADED pending re-verification", () => {
  const ownershipRef = ownership("r3");
  const staleVerifiedWithA = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-A" });
  const rotatedToB = rotateConnectorSecret({
    instance: staleVerifiedWithA,
    newSecretRef: createSecretRef({ secretRefId: "secret-ref-B" }),
  });
  assert.equal(rotatedToB.binding.connectionState, "DEGRADED", "rotating a VERIFIED binding's secret must demote it to DEGRADED");
  const definition = definitionForBinding(staleVerifiedWithA.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerifiedWithA, definition });
  const transport = new RecordingMockTransport();
  const resolver = new ExplodingSecretResolver();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: currentStoreFor(rotatedToB),
        secretResolver: resolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0, "secret-ref-A must never be resolved once the current durable connection has moved on");
});

test("R4 (OS-V0-06 witness 4, positive path): after rotation is genuinely re-verified and durably current, execution resolves secretRef B and never the caller's stale secretRef A", () => {
  const ownershipRef = ownership("r4");
  const staleVerifiedWithA = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-A" });
  const rotatedToB = rotateConnectorSecret({
    instance: staleVerifiedWithA,
    newSecretRef: createSecretRef({ secretRefId: "secret-ref-B" }),
  });
  const reverifiedWithB = verifyConnectorConnection(rotatedToB, "evidence:re-handshake-after-rotation");
  assert.equal(reverifiedWithB.binding.connectionState, "VERIFIED");
  assert.equal(reverifiedWithB.binding.secretRef, "secret-ref-B");

  const definition = definitionForBinding(staleVerifiedWithA.binding.connectionBindingId);
  // Caller still only holds its original pre-rotation VERIFIED(A) snapshot.
  const bound = bindGenericApiDefinition({ instance: staleVerifiedWithA, definition });
  const transport = new RecordingMockTransport("SUCCESS", { pong: true });
  const resolver = new RecordingSecretResolver({ "secret-ref-A": "VALUE-A", "secret-ref-B": "VALUE-B" });

  const result = executeConnectorCapability({
    bound,
    capabilityRef: "cap:generic-ping",
    requestingOwnership: ownershipRef,
    connectionStore: currentStoreFor(reverifiedWithB),
    secretResolver: resolver,
    transport,
  });

  assert.deepEqual(resolver.seenSecretRefIds, ["secret-ref-B"]);
  assert.equal(transport.seenRequests[0]?.authSecretValue, "VALUE-B");
  assert.ok(!JSON.stringify(result).includes("VALUE-A"));
});

test("R5 (OS-V0-06 witness 5, adversarial): a missing current durable connection record fails closed", () => {
  const ownershipRef = ownership("r5");
  const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
  const transport = new RecordingMockTransport();
  const emptyStore: CurrentConnectorConnectionReader = { get: () => undefined };

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: emptyStore,
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R6 (OS-V0-06 witness 6, adversarial): a current durable record whose exact ownership does not match the requesting ownership fails closed, even though a record was found for the queried id", () => {
  const ownershipRef = ownership("r6-requester");
  const foreignOwnership = ownership("r6-foreign");
  const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const currentUnderForeignOwnership: ConnectorConnectionInstance = {
    ...staleVerified,
    binding: { ...staleVerified.binding, ownership: foreignOwnership },
  };
  const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: storeAlwaysReturning(currentUnderForeignOwnership),
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R7 (OS-V0-06 witness 7, adversarial): a colliding connectionBindingId belonging to a different customer/project under the SAME tenant cannot authorize execution", () => {
  const projectXOwnership = sameTenantOwnership("x", "x");
  const projectYOwnership = sameTenantOwnership("y", "y");
  const descriptor = genericApiDescriptor();
  const requirementY = requirementFor(descriptor, projectYOwnership);
  const instanceY = requestConnectorConnection({
    requirement: requirementY,
    connectorDescriptor: descriptor,
    connectionBindingId: "colliding-bind-id",
    workspaceRef: "workspace-y",
    integrationInstanceRef: "instance-y",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-ref-y" }),
  });
  const verifiedY = verifyConnectorConnection(transitionConnectorConnection(instanceY, "CONNECTED_UNVERIFIED"), "evidence:y");

  // Project X's own (stale) caller context, using the SAME connectionBindingId string by coincidence/replay.
  const requirementX = requirementFor(descriptor, projectXOwnership);
  const staleInstanceX = requestConnectorConnection({
    requirement: requirementX,
    connectorDescriptor: descriptor,
    connectionBindingId: "colliding-bind-id",
    workspaceRef: "workspace-x",
    integrationInstanceRef: "instance-x",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-ref-x" }),
  });
  const verifiedX = verifyConnectorConnection(transitionConnectorConnection(staleInstanceX, "CONNECTED_UNVERIFIED"), "evidence:x");

  const definition = definitionForBinding(verifiedX.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: verifiedX, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: projectXOwnership,
        connectionStore: storeAlwaysReturning(verifiedY),
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R8 (OS-V0-06 witness 8, adversarial): a previously produced VERIFIED_AVAILABLE CapabilityAdmission has no bearing on execution once the connection is currently revoked", () => {
  const ownershipRef = ownership("r8");
  const descriptor = genericApiDescriptor();
  const requirement = requirementFor(descriptor, ownershipRef);
  const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });

  // A CapabilityAdmission legitimately constructed while the binding was
  // still VERIFIED - this object continues to exist and claims
  // VERIFIED_AVAILABLE, but `executeConnectorCapability` never accepts a
  // CapabilityAdmission as input at all, so it structurally cannot rescue
  // execution once the underlying connection is later revoked.
  const staleAdmission = createCapabilityAdmission({
    capabilityAdmissionId: "admission-r8",
    ownership: ownershipRef,
    requiredCapabilityRef: requirement.requiredCapabilityRef,
    status: "VERIFIED_AVAILABLE",
    binding: staleVerified.binding,
    requirement,
    evidenceRef: "evidence:admission",
  });
  assert.equal(staleAdmission.status, "VERIFIED_AVAILABLE");

  const currentRevoked: ConnectorConnectionInstance = {
    ...staleVerified,
    binding: transitionConnectionBinding(staleVerified.binding, "REVOKED"),
  };
  const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: currentStoreFor(currentRevoked),
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R11 (OS-V0-06 witness 11, adversarial): a current durable record whose connectorKind no longer matches the bound definition's expected connectorKind fails before secret/transport", () => {
  const ownershipRef = ownership("r11");
  const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });
  const currentWithSwitchedProvider: ConnectorConnectionInstance = {
    ...staleVerified,
    connectorKind: "GITHUB",
  };
  const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
  const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
  const transport = new RecordingMockTransport();

  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: ownershipRef,
        connectionStore: currentStoreFor(currentWithSwitchedProvider),
        secretResolver: new ExplodingSecretResolver(),
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.seenRequests.length, 0);
});

test("R12 (OS-V0-06 witness 12, adversarial, real durable store): a fresh store instance opened against the same directory after a simulated process restart reproduces the identical currentness outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "conn-exec-replay-"));
  try {
    const ownershipRef = ownership("r12");
    const staleVerified = verifiedInstance({ ownershipRef, secretRefId: "secret-ref-1" });

    const storeBeforeRestart = new FileDurableConnectorConnectionStore(dir);
    storeBeforeRestart.save(staleVerified);
    const revoked: ConnectorConnectionInstance = {
      ...staleVerified,
      binding: transitionConnectionBinding(staleVerified.binding, "REVOKED"),
    };
    storeBeforeRestart.save(revoked, 1);

    // Simulate a process restart: a brand-new store object over the same directory.
    const storeAfterRestart = new FileDurableConnectorConnectionStore(dir);
    const definition = definitionForBinding(staleVerified.binding.connectionBindingId);
    const bound = bindGenericApiDefinition({ instance: staleVerified, definition });
    const transport = new RecordingMockTransport();

    assert.throws(
      () =>
        executeConnectorCapability({
          bound,
          capabilityRef: "cap:generic-ping",
          requestingOwnership: ownershipRef,
          connectionStore: storeAfterRestart,
          secretResolver: new ExplodingSecretResolver(),
          transport,
        }),
      ConnectorExecutionNotAuthorizedError,
    );
    assert.equal(transport.seenRequests.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R13 (OS-V0-06 Rev172 F1, real durable store, positive path): a prototype-shaped connectionBindingId (\"__proto__\") round-trips through the real FileDurableConnectorConnectionStore and executes normally via the same currentness re-resolution path as any ordinary binding id", () => {
  const dir = mkdtempSync(join(tmpdir(), "conn-exec-proto-shaped-"));
  try {
    const ownershipRef = ownership("r13");
    const descriptor = genericApiDescriptor();
    const requirement = requirementFor(descriptor, ownershipRef);
    const requested = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "__proto__",
      workspaceRef: "workspace-proto",
      integrationInstanceRef: "instance-proto",
      delegatedScope: [],
      authMode: "API_KEY",
      secretRef: createSecretRef({ secretRefId: "secret-ref-proto" }),
    });
    const verified = verifyConnectorConnection(transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED"), "evidence:proto-handshake");

    const store = new FileDurableConnectorConnectionStore(dir);
    store.save(verified);

    const definition = definitionForBinding("__proto__");
    const bound = bindGenericApiDefinition({ instance: verified, definition });
    const transport = new RecordingMockTransport("SUCCESS", { pong: true });
    const resolver = new RecordingSecretResolver({ "secret-ref-proto": "VALUE-PROTO" });

    const result = executeConnectorCapability({
      bound,
      capabilityRef: "cap:generic-ping",
      requestingOwnership: ownershipRef,
      connectionStore: store,
      secretResolver: resolver,
      transport,
    });

    assert.deepEqual(resolver.seenSecretRefIds, ["secret-ref-proto"]);
    assert.equal(transport.seenRequests[0]?.authSecretValue, "VALUE-PROTO");
    assert.equal(result.connectionBindingId, "__proto__");

    // Restart-safety: a fresh store instance over the same directory still
    // finds the record correctly under this prototype-shaped id.
    const storeAfterRestart = new FileDurableConnectorConnectionStore(dir);
    const stillFound = storeAfterRestart.get(ownershipRef.tenantId, verified.binding.connectionBindingId);
    assert.ok(stillFound !== undefined);
    assert.equal(stillFound?.instance.binding.connectionState, "VERIFIED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
