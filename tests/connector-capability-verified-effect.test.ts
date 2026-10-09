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
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import { createGenericApiConnectorDefinition, bindGenericApiDefinition } from "../src/domain/generic-connector-definition.js";
import type { ConnectorTransport, ConnectorTransportRequest, SecretResolver, CurrentConnectorConnectionReader, ConnectorExecutionResult } from "../src/domain/connector-execution.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  executeConnectorCapabilityAsVerifiedEffect,
  InvalidVerifiedConnectorEffectError,
  type ConnectorCapabilityReadback,
} from "../src/domain/connector-capability-verified-effect.js";

const tenantScope = createTenantScope("tenant-ccve-1");

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-ccve", projectId: "project-ccve" });
}

function descriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Generic API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:generic-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
}

function requirementFor(desc: ConnectorDescriptor, ownershipRef: ProjectOwnershipRef): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: `req-${desc.connectorKind}`,
    ownership: ownershipRef,
    requiredCapabilityRef: desc.capabilityRefs[0] as string,
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
}

function verifiedInstance(ownershipRef: ProjectOwnershipRef): ConnectorConnectionInstance {
  const desc = descriptor();
  const requirement = requirementFor(desc, ownershipRef);
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: desc,
    connectionBindingId: "bind-ccve-1",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-ref-ccve" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectorConnection(unverified, "evidence:handshake");
}

function storeFor(instance: ConnectorConnectionInstance): CurrentConnectorConnectionReader {
  return {
    get(tenantId, connectionBindingId) {
      if (tenantId !== instance.binding.ownership.tenantId || connectionBindingId !== instance.binding.connectionBindingId) {
        return undefined;
      }
      return { instance, version: 1 };
    },
  };
}

class FixedSecretResolver implements SecretResolver {
  resolve(): string {
    return "sk-live-super-secret";
  }
}

class ScriptedTransport implements ConnectorTransport {
  public callCount = 0;
  constructor(private readonly behavior: "SUCCESS" | "AUTHORIZATION_FAILED" | "TRANSPORT_ERROR" | "THROW_UNEXPECTED") {}
  execute(request: ConnectorTransportRequest) {
    this.callCount += 1;
    if (this.behavior === "SUCCESS") {
      return { outcome: "SUCCESS" as const, data: { pong: true } };
    }
    if (this.behavior === "AUTHORIZATION_FAILED" || this.behavior === "TRANSPORT_ERROR") {
      return { outcome: this.behavior, errorMessage: `mock ${this.behavior}` };
    }
    throw new Error("unexpected transport crash");
  }
}

function noCurrentConnectionStore(): CurrentConnectorConnectionReader {
  return { get: () => undefined };
}

class ThrowingSecretResolver implements SecretResolver {
  resolve(): string {
    throw new Error("secret backend unreachable");
  }
}

function alwaysConfirmsReadback(): ConnectorCapabilityReadback {
  return {
    confirmsApplied: () => true,
    evidenceRef: (result: ConnectorExecutionResult) => `evidence:readback:${result.capabilityRef}`,
  };
}

function alwaysDisagreesReadback(): ConnectorCapabilityReadback {
  return {
    confirmsApplied: () => false,
    evidenceRef: () => "evidence:readback-disagrees",
  };
}

function protectedAuthority() {
  return createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
}

function baseInput(overrides: Partial<Parameters<typeof executeConnectorCapabilityAsVerifiedEffect>[0]> = {}) {
  const ownershipRef = ownership();
  const instance = verifiedInstance(ownershipRef);
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-ccve-1",
    baseUrl: "https://api.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:generic-ping", method: "GET", path: "/ping" }],
  });
  const bound = bindGenericApiDefinition({ instance, definition });
  return {
    tenantScope,
    authority: protectedAuthority(),
    effectIntentId: "effect-intent-1",
    actionRef: "action:ping",
    retryClassification: "SAFE_TO_RETRY" as const,
    attemptId: "attempt-1",
    bound,
    capabilityRef: "cap:generic-ping",
    requestingOwnership: ownershipRef,
    connectionStore: storeFor(instance),
    secretResolver: new FixedSecretResolver(),
    transport: new ScriptedTransport("SUCCESS"),
    readback: alwaysConfirmsReadback(),
    ...overrides,
  };
}

test("Golden C (mock-only local safety evidence): transport SUCCESS + confirming readback reaches VERIFIED, and readback evidence is independent of the transport's own claim", () => {
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput());
  assert.equal(outcome.kind, "VERIFIED");
  if (outcome.kind === "VERIFIED") {
    assert.equal(outcome.attempt.state, "VERIFIED");
    assert.equal(outcome.attempt.readbackEvidenceRef, "evidence:readback:cap:generic-ping");
  }
});

test("Golden C (mock-only local safety evidence) Live Gap C1: transport SUCCESS alone never reaches VERIFIED - a disagreeing readback corrects APPLIED to FAILED", () => {
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput({ readback: alwaysDisagreesReadback() }));
  assert.equal(outcome.kind, "FAILED");
  assert.equal(outcome.attempt.state, "FAILED");
});

test("Golden C (mock-only local safety evidence): a classified AUTHORIZATION_FAILED transport outcome is reported FAILED, never UNKNOWN, and readback is never consulted", () => {
  let readbackCalled = false;
  const outcome = executeConnectorCapabilityAsVerifiedEffect(
    baseInput({
      transport: new ScriptedTransport("AUTHORIZATION_FAILED"),
      readback: { confirmsApplied: () => ((readbackCalled = true), true), evidenceRef: () => "unused" },
    }),
  );
  assert.equal(outcome.kind, "FAILED");
  assert.equal(readbackCalled, false);
});

test("Rev186 F4: a classified TRANSPORT_ERROR outcome is reported UNKNOWN, not FAILED - the ConnectorTransport contract never guarantees no effect occurred", () => {
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput({ transport: new ScriptedTransport("TRANSPORT_ERROR") }));
  assert.equal(outcome.kind, "UNKNOWN");
  assert.equal(outcome.attempt.state, "UNKNOWN");
});

test("Golden C (mock-only local safety evidence) adversarial: an unclassified/unexpected transport exception is reported UNKNOWN, never silently retried or treated as success", () => {
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput({ transport: new ScriptedTransport("THROW_UNEXPECTED") }));
  assert.equal(outcome.kind, "UNKNOWN");
  assert.equal(outcome.attempt.state, "UNKNOWN");
});

test("executeConnectorCapabilityAsVerifiedEffect requires protected-action authorization, not merely EXECUTE", () => {
  const nonProtected = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: false });
  assert.throws(() => executeConnectorCapabilityAsVerifiedEffect(baseInput({ authority: nonProtected })));
});

test("Rev186 F3 (Founder implementation clarification): executeConnectorCapabilityAsVerifiedEffect requires ordinary EXECUTE permission separately from canPerformProtectedActions - a READ-only authority cannot cause a material connector effect merely because canPerformProtectedActions is true", () => {
  const readOnlyButProtected = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: true });
  assert.throws(() => executeConnectorCapabilityAsVerifiedEffect(baseInput({ authority: readOnlyButProtected })));
});

test("executeConnectorCapabilityAsVerifiedEffect fails closed on a cross-tenant authority", () => {
  const foreignTenant = createTenantScope("tenant-ccve-foreign");
  const foreignAuthority = createAuthorityContext({ tenantScope: foreignTenant, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  assert.throws(() => executeConnectorCapabilityAsVerifiedEffect(baseInput({ authority: foreignAuthority })));
});

test("Rev189 R2: no current durable connection for the connectionBindingId is a definitive pre-transport no-effect - reported BLOCKED_NO_EFFECT, and transport.execute() is never invoked", () => {
  const transport = new ScriptedTransport("SUCCESS");
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput({ connectionStore: noCurrentConnectionStore(), transport }));
  assert.equal(outcome.kind, "BLOCKED_NO_EFFECT");
  assert.equal(transport.callCount, 0, "a ConnectorExecutionNotAuthorizedError is thrown strictly before transport.execute() - it must never be invoked");
});

test("Rev189 R2: an unresolvable secret (secretResolver throws) is a definitive pre-transport no-effect - reported BLOCKED_NO_EFFECT, and transport.execute() is never invoked", () => {
  const transport = new ScriptedTransport("SUCCESS");
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput({ secretResolver: new ThrowingSecretResolver(), transport }));
  assert.equal(outcome.kind, "BLOCKED_NO_EFFECT");
  assert.equal(transport.callCount, 0, "an UnresolvedConnectorSecretError is thrown strictly before transport.execute() - it must never be invoked");
});

test("Rev189 R2: BLOCKED_NO_EFFECT is distinct from an attempted-but-rejected AUTHORIZATION_FAILED transport outcome - the latter still invoked the transport and remains FAILED, not BLOCKED_NO_EFFECT", () => {
  const transport = new ScriptedTransport("AUTHORIZATION_FAILED");
  const outcome = executeConnectorCapabilityAsVerifiedEffect(baseInput({ transport }));
  assert.equal(outcome.kind, "FAILED");
  assert.equal(transport.callCount, 1, "the transport WAS invoked here - the provider itself rejected the request, which is a different (attempted) class than BLOCKED_NO_EFFECT");
});

test("InvalidVerifiedConnectorEffectError is thrown when the readback's own evidenceRef is empty", () => {
  assert.throws(
    () =>
      executeConnectorCapabilityAsVerifiedEffect(
        baseInput({ readback: { confirmsApplied: () => true, evidenceRef: () => "" } }),
      ),
    InvalidVerifiedConnectorEffectError,
  );
});
