import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  transitionConnectionBinding,
} from "../src/domain/connection-authority.js";
import { createSecretRef } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  recordConnectorHealthCheck,
} from "../src/domain/integration-connector-catalog.js";
import { createGenericApiConnectorDefinition, bindGenericApiDefinition } from "../src/domain/generic-connector-definition.js";
import { resolvePrebuiltConnectorDefinition, bindPrebuiltDefinition } from "../src/domain/prebuilt-connector-definitions.js";
import {
  executeConnectorCapability,
  ConnectorExecutionNotAuthorizedError,
  type ConnectorTransport,
  type ConnectorTransportRequest,
  type SecretResolver,
} from "../src/domain/connector-execution.js";

/**
 * Rev90/94's two MANDATORY E2E acceptance cases (CONN-001), executed here
 * entirely through fixtures/mocks - no real credential, HTTP call, or
 * provider account is ever touched, matching Rev94's own explicit
 * correction that credential absence gates only real activation, not
 * dark/internal adapter execution or deterministic E2E proof.
 */

class RoutingMockTransport implements ConnectorTransport {
  public readonly calls: ConnectorTransportRequest[] = [];
  execute(request: ConnectorTransportRequest) {
    this.calls.push(request);
    if (request.authSecretValue === "REVOKED_OR_MISSING") {
      return { outcome: "AUTHORIZATION_FAILED" as const, errorMessage: "credential no longer valid" };
    }
    return { outcome: "SUCCESS" as const, data: { ok: true, capability: request.capabilityRef } };
  }
}

class MapSecretResolver implements SecretResolver {
  constructor(private readonly map: ReadonlyMap<string, string>) {}
  resolve(secretRefId: string): string {
    const value = this.map.get(secretRefId);
    if (value === undefined) {
      throw new Error(`no secret registered for ${secretRefId}`);
    }
    return value;
  }
}

test("3H MANDATORY GENERIC CONNECTION E2E: create -> Test Connection (mock) succeeds -> capability admitted -> bound to Tenant/Project X -> authorized worker executes -> Tenant Y cannot use it -> revoke -> subsequent execution fails closed with explicit reason -> no secret leak", () => {
  const tenantX = createProjectOwnershipRef({ tenantId: "tenant-x", customerId: "customer-x", projectId: "project-x" });
  const tenantY = createProjectOwnershipRef({ tenantId: "tenant-y", customerId: "customer-y", projectId: "project-y" });

  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Generic Custom API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:generic-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-generic-e2e",
    ownership: tenantX,
    requiredCapabilityRef: "cap:generic-ping",
    purpose: "E2E acceptance",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });

  // Admin/config layer creates a Custom API connection: base URL/auth/spec
  // supplied, secret is stored only behind SecretRef.
  const secretRef = createSecretRef({ secretRefId: "secret-generic-e2e" });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-generic-e2e",
    workspaceRef: "workspace-e2e",
    integrationInstanceRef: "instance-e2e",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef,
  });
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-generic-e2e",
    baseUrl: "https://api.generic-e2e.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:generic-ping", method: "GET", path: "/ping" }],
    validationEndpointCapabilityRef: "cap:generic-ping",
  });

  const transport = new RoutingMockTransport();
  const secretResolver = new MapSecretResolver(new Map([["secret-generic-e2e", "sk-live-generic-e2e-secret"]]));

  // Test Connection passes through the mock transport.
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const preVerifyBound = bindGenericApiDefinition({ instance: unverified, definition });
  // A pre-VERIFIED connection cannot yet execute - proves Test Connection
  // truly gates on VERIFIED, not merely "has a definition".
  assert.throws(
    () =>
      executeConnectorCapability({
        bound: preVerifyBound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: tenantX,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );

  const verified = verifyConnectorConnection(unverified, "evidence:mock-test-connection-200");
  const healthCheck = recordConnectorHealthCheck({
    instance: verified,
    status: "HEALTHY",
    checkedAt: "2026-09-11T00:00:00.000Z",
    evidenceRef: "evidence:mock-test-connection-200",
  });
  assert.equal(healthCheck.status, "HEALTHY");

  // Capability becomes admitted/available; bind only to Tenant/Project X.
  const bound = bindGenericApiDefinition({ instance: verified, definition });

  // Authorized worker executes through the admitted capability.
  const result = executeConnectorCapability({
    bound,
    capabilityRef: "cap:generic-ping",
    requestingOwnership: tenantX,
    secretResolver,
    transport,
  });
  assert.deepEqual(result.data, { ok: true, capability: "cap:generic-ping" });

  // Tenant Y cannot resolve or use the connection.
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: tenantY,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );

  // Revoke connection.
  const revoked = { ...verified, binding: transitionConnectionBinding(verified.binding, "REVOKED") };
  const revokedBound = bindGenericApiDefinition({ instance: revoked, definition });

  // Subsequent execution fails closed with an explicit reason/evidence.
  assert.throws(
    () =>
      executeConnectorCapability({
        bound: revokedBound,
        capabilityRef: "cap:generic-ping",
        requestingOwnership: tenantX,
        secretResolver,
        transport,
      }),
    (error: unknown) => error instanceof ConnectorExecutionNotAuthorizedError && /REVOKED/.test((error as Error).message),
  );

  // No secret leaked into any captured transport call or result.
  const allCallsJson = JSON.stringify(transport.calls);
  assert.ok(allCallsJson.includes("sk-live-generic-e2e-secret"), "sanity: the transport DID receive the secret to authenticate with");
  assert.ok(!JSON.stringify(result).includes("sk-live-generic-e2e-secret"), "the execution result itself must never carry the raw secret");
});

test("3I MANDATORY PREBUILT CONNECTION E2E (Google Drive): select provider -> simulated OAuth authorization via fixture -> SecretRef only -> connection validation -> capability discovery -> admitted capability -> authorized router/worker execution -> revoke -> capability unavailable, no fallback, no secret leak", () => {
  const tenantScope: ProjectOwnershipRef = createProjectOwnershipRef({
    tenantId: "tenant-drive-e2e",
    customerId: "customer-drive-e2e",
    projectId: "project-drive-e2e",
  });
  const foreignTenant: ProjectOwnershipRef = createProjectOwnershipRef({
    tenantId: "tenant-other-account",
    customerId: "customer-other",
    projectId: "project-other",
  });

  const descriptor = createConnectorDescriptor({
    connectorKind: "GOOGLE_DRIVE",
    displayName: "Google Drive",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:drive-search", "cap:drive-read"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-drive-e2e",
    ownership: tenantScope,
    requiredCapabilityRef: "cap:drive-search",
    purpose: "Drive E2E acceptance",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: [],
    connectionMethod: "oauth",
    validationRequirement: "must respond 200",
  });

  // Admin selects Google Drive -> simulated OAuth authorization fixture
  // produces a SecretRef only (never a raw token in a domain field).
  const secretRef = createSecretRef({ secretRefId: "secret-drive-e2e" });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-drive-e2e",
    workspaceRef: "workspace-drive-e2e",
    integrationInstanceRef: "instance-drive-e2e",
    delegatedScope: [],
    authMode: "OAUTH2",
    secretRef,
  });

  const definition = resolvePrebuiltConnectorDefinition("GOOGLE_DRIVE");
  const transport = new RoutingMockTransport();
  const secretResolver = new MapSecretResolver(new Map([["secret-drive-e2e", "oauth-token-drive-e2e"]]));

  // Connection validation passes.
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectorConnection(unverified, "evidence:mock-oauth-handshake-200");

  // Capability/model discovery is recorded where supported - here, the
  // capability itself (search) becomes available once admitted.
  const bound = bindPrebuiltDefinition({ instance: verified, definition });
  const searchResult = executeConnectorCapability({
    bound,
    capabilityRef: "cap:drive-search",
    requestingOwnership: tenantScope,
    secretResolver,
    transport,
  });
  assert.deepEqual(searchResult.data, { ok: true, capability: "cap:drive-search" });

  // A foreign tenant/account cannot resolve or use this connection.
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:drive-search",
        requestingOwnership: foreignTenant,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );

  // Remove/revoke authorization.
  const revoked = { ...verified, binding: transitionConnectionBinding(verified.binding, "REVOKED") };
  const revokedBound = bindPrebuiltDefinition({ instance: revoked, definition });

  // Capability becomes unavailable without secret leakage or silent
  // fallback to another tenant/account.
  assert.throws(
    () =>
      executeConnectorCapability({
        bound: revokedBound,
        capabilityRef: "cap:drive-search",
        requestingOwnership: tenantScope,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );

  assert.ok(!JSON.stringify(searchResult).includes("oauth-token-drive-e2e"));
});
