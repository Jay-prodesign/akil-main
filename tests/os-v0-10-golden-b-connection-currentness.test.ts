import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef, type ConnectionRequirement } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { createGenericApiConnectorDefinition, bindGenericApiDefinition } from "../src/domain/generic-connector-definition.js";
import { executeConnectorCapability, ConnectorExecutionNotAuthorizedError, type ConnectorTransport } from "../src/domain/connector-execution.js";

/**
 * OS-V0-10 Golden B: "one admitted internal authority/admin mutation whose
 * revoke/change is honored by subsequent queued/new work." Per the AA-005
 * preflight's own instruction, this proof composes ONLY existing,
 * unmodified primitives (`FileDurableConnectorConnectionStore`,
 * `transitionConnectorConnection`/`verifyConnectorConnection`,
 * `executeConnectorCapability`'s own already-built "always re-read current
 * durable record" discipline) - no new production code is required for
 * Golden B itself.
 */

const tenantScope = createTenantScope("tenant-golden-b");

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-golden-b", projectId: "project-golden-b-org-akilta" });
}

function requirementFor(ownershipRef: ProjectOwnershipRef): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: "req-golden-b",
    ownership: ownershipRef,
    requiredCapabilityRef: "cap:golden-b-ping",
    purpose: "Golden B org_akilta connection currentness proof",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
}

class NoopTransport implements ConnectorTransport {
  public callCount = 0;
  execute() {
    this.callCount += 1;
    return { outcome: "SUCCESS" as const, data: { ok: true } };
  }
}

test("Golden B: a current VERIFIED org_akilta connection authorizes execution; subsequent/new work re-reads current state and causes ZERO connector effect once durably DEGRADED, without deleting historical evidence", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-b-"));
  const store = new FileDurableConnectorConnectionStore(baseDir);
  const ownershipRef = ownership();
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Golden B API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:golden-b-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement = requirementFor(ownershipRef);
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId: "bind-golden-b",
    workspaceRef: "workspace-golden-b",
    integrationInstanceRef: "instance-golden-b",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-golden-b" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const verified: ConnectorConnectionInstance = verifyConnectorConnection(unverified, "evidence:golden-b-handshake");
  store.save(verified);

  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: "bind-golden-b",
    baseUrl: "https://api.golden-b.example.com",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap:golden-b-ping", method: "GET", path: "/ping" }],
  });
  const bound = bindGenericApiDefinition({ instance: verified, definition });
  const transport = new NoopTransport();
  const secretResolver = { resolve: () => "sk-golden-b" };

  // Step 1: a queued execution reference runs normally while current.
  const resultWhileCurrent = executeConnectorCapability({
    bound,
    capabilityRef: "cap:golden-b-ping",
    requestingOwnership: ownershipRef,
    connectionStore: store,
    secretResolver,
    transport,
  });
  assert.deepEqual(resultWhileCurrent.data, { ok: true });
  assert.equal(transport.callCount, 1);

  // Step 2: durably transition to DEGRADED via the separately-authorized
  // admin path (current, saved, authoritative - never a caller snapshot).
  const degraded = transitionConnectorConnection(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance, "DEGRADED");
  const savedDegraded = store.save(degraded, store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.version);
  assert.equal(savedDegraded.instance.binding.connectionState, "DEGRADED");

  // Step 3: subsequent/new work re-reads current state (via the SAME stale
  // `bound` object a queued caller might still be holding) and causes ZERO
  // connector effect - the transport is never invoked again.
  assert.throws(
    () =>
      executeConnectorCapability({
        bound, // deliberately the STALE pre-degrade bound snapshot
        capabilityRef: "cap:golden-b-ping",
        requestingOwnership: ownershipRef,
        connectionStore: store,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.callCount, 1, "the transport must NOT have been invoked a second time after DEGRADED");

  // Historical evidence is preserved, not deleted: the original VERIFIED
  // handshake evidence is still part of the durable record's own lineage
  // (connection-authority.ts never erases evidenceRef on a later transition
  // away from VERIFIED).
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.verificationEvidenceRef, "evidence:golden-b-handshake");

  // Step 4: a REVOKED connection is equally honored - zero effect.
  const revoked = transitionConnectorConnection(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance, "REVOKED");
  store.save(revoked, store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.version);
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap:golden-b-ping",
        requestingOwnership: ownershipRef,
        connectionStore: store,
        secretResolver,
        transport,
      }),
    ConnectorExecutionNotAuthorizedError,
  );
  assert.equal(transport.callCount, 1);
});
