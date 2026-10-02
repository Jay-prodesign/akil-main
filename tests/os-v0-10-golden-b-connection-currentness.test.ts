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
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import { createAuthorityContext, InsufficientAuthorityError } from "../src/domain/authority.js";
import {
  mutateConnectorConnectionStateAsAdmin,
  ConnectorConnectionAdminMutationNotAuthorizedError,
} from "../src/domain/connector-connection-admin-mutation.js";

/**
 * OS-V0-10 Golden B: "one admitted internal authority/admin mutation whose
 * revoke/change is honored by subsequent queued/new work." Rev186 F2: the
 * mutation itself must pass through an admitted authority/admin boundary
 * (`mutateConnectorConnectionStateAsAdmin`, the minimum such boundary this
 * exact consumer needs - see its own doc comment), never a raw
 * `transitionConnectorConnection` + `store.save` call with no authenticated
 * staff binding, effective access, or protected-action authority. The
 * valuable stale-snapshot/current-durable-reread witness
 * (`executeConnectorCapability`'s own already-built discipline) is
 * preserved unchanged.
 */

const tenantScope = createTenantScope("tenant-golden-b");

function adminAccess(permissions: ReadonlyArray<"READ" | "WRITE" | "EXECUTE"> = ["EXECUTE", "WRITE", "READ"]) {
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-golden-b",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: "membership-golden-b-admin",
    tenantScope,
    principalRef: "principal-golden-b-admin",
    role: "STAFF",
  });
  const roleContext = createOrganizationAccessRoleContext({ membership, role: "ADMIN" });
  const authority = createAuthorityContext({
    tenantScope,
    permissions,
    canPerformProtectedActions: true,
  });
  const access = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-golden-b-admin",
    authority,
    roleContext,
  });
  return { authority, access };
}

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

  // Step 2: durably transition to DEGRADED via the admitted authority/admin
  // mutation boundary - a real GRANTED ADMIN-role EffectiveAccessResolution
  // plus protected-action authority, never a raw transition+save call.
  const { authority, access } = adminAccess();
  const savedDegraded = mutateConnectorConnectionStateAsAdmin({
    tenantScope,
    authority,
    access,
    store,
    connectionBindingId: verified.binding.connectionBindingId,
    to: "DEGRADED",
  });
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

  // Step 4: a REVOKED connection is equally honored - zero effect. Same
  // admitted admin boundary, same GRANTED ADMIN access.
  mutateConnectorConnectionStateAsAdmin({
    tenantScope,
    authority,
    access,
    store,
    connectionBindingId: verified.binding.connectionBindingId,
    to: "REVOKED",
  });
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

test("Rev186 F2 (adversarial): an ordinary MEMBER-role access cannot mutate a connection's lifecycle state through the admin boundary, even when protected-action authority is otherwise granted", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-b-member-"));
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
    connectionBindingId: "bind-golden-b-member",
    workspaceRef: "workspace-golden-b",
    integrationInstanceRef: "instance-golden-b",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-golden-b" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectorConnection(unverified, "evidence:golden-b-handshake");
  store.save(verified);

  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-golden-b-member",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: "membership-golden-b-member",
    tenantScope,
    principalRef: "principal-golden-b-member",
    role: "STAFF",
  });
  const authority = createAuthorityContext({
    tenantScope,
    permissions: ["EXECUTE", "WRITE", "READ"],
    canPerformProtectedActions: true,
  });
  const memberAccess = resolveEffectiveOrganizationAccess({
    organization,
    membership,
    currentPrincipalRef: "principal-golden-b-member",
    authority,
  });
  assert.equal(memberAccess.decision, "GRANTED");
  assert.equal(memberAccess.role, "MEMBER");

  assert.throws(
    () =>
      mutateConnectorConnectionStateAsAdmin({
        tenantScope,
        authority,
        access: memberAccess,
        store,
        connectionBindingId: verified.binding.connectionBindingId,
        to: "DEGRADED",
      }),
    ConnectorConnectionAdminMutationNotAuthorizedError,
  );
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "VERIFIED");
});

test("Rev186 F2 (Founder implementation clarification): mutateConnectorConnectionStateAsAdmin requires ordinary EXECUTE permission separately from canPerformProtectedActions - a READ-only ADMIN-role access cannot mutate lifecycle state merely because canPerformProtectedActions is true", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-golden-b-readonly-admin-"));
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
    connectionBindingId: "bind-golden-b-readonly-admin",
    workspaceRef: "workspace-golden-b",
    integrationInstanceRef: "instance-golden-b",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-golden-b" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectorConnection(unverified, "evidence:golden-b-handshake");
  store.save(verified);

  const { authority, access } = adminAccess(["READ"]);
  assert.equal(access.decision, "GRANTED");
  assert.equal(access.role, "ADMIN");

  assert.throws(
    () =>
      mutateConnectorConnectionStateAsAdmin({
        tenantScope,
        authority,
        access,
        store,
        connectionBindingId: verified.binding.connectionBindingId,
        to: "DEGRADED",
      }),
    InsufficientAuthorityError,
  );
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "VERIFIED");
});
