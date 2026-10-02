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
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { type StaffAccessGrant } from "../src/web/internal-os-access.js";
import { NoStaffMembershipError } from "../src/web/staff-membership-guard.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { mutateConnectorConnectionStateAsAuthenticatedAdmin } from "../src/web/connector-connection-admin-access.js";
import { ConnectorConnectionAdminMutationNotAuthorizedError } from "../src/domain/connector-connection-admin-mutation.js";

/**
 * Rev188 F2: `mutateConnectorConnectionStateAsAuthenticatedAdmin`
 * (`src/web/connector-connection-admin-access.ts`) is the missing
 * authenticated ingress boundary in front of `mutateConnectorConnectionStateAsAdmin`
 * - a forged identity must fail inside `requireInternalOsAccess` itself,
 * before the domain mutation is ever reached, and a stale role continues
 * to fail inside the domain function's own re-resolution (Rev187 F2,
 * unchanged). Either way: zero store mutation.
 */

const tenantScope = createTenantScope("tenant-admin-access-rev188");

function ownership(): ProjectOwnershipRef {
  return createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-admin-access", projectId: "project-admin-access" });
}

function seedVerifiedConnection(store: FileDurableConnectorConnectionStore, connectionBindingId: string) {
  const ownershipRef = ownership();
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "Admin Access API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:admin-access-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement: ConnectionRequirement = createConnectionRequirement({
    connectionRequirementId: "req-admin-access",
    ownership: ownershipRef,
    requiredCapabilityRef: "cap:admin-access-ping",
    purpose: "Rev188 F2 authenticated admin ingress proof",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const requested = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-admin-access",
    integrationInstanceRef: "instance-admin-access",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: "secret-admin-access" }),
  });
  const unverified = transitionConnectorConnection(requested, "CONNECTED_UNVERIFIED");
  const verified = verifyConnectorConnection(unverified, "evidence:admin-access-handshake");
  store.save(verified);
  return verified;
}

function adminFixture(role: "ADMIN" | "MEMBER" = "ADMIN") {
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-admin-access",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: "membership-admin-access",
    tenantScope,
    principalRef: "principal-admin-access",
    role: "STAFF",
  });
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE", "WRITE", "READ"], canPerformProtectedActions: true });
  const roleContext = role === "ADMIN" ? createOrganizationAccessRoleContext({ membership, role: "ADMIN" }) : undefined;
  const principal = createAuthenticatedStaffPrincipal({ principalId: "principal-admin-access", displayName: "Admin Access Principal" });
  const sessionToken = "token-admin-access";
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-02T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const grant: StaffAccessGrant = { membership, authority, assignments: [], ...(roleContext !== undefined ? { roleContext } : {}) };
  return { organization, provider, sessionToken, grants: [grant] };
}

test("Rev188 F2: a valid authenticated ADMIN staff session mutates the connection's lifecycle state through the web-layer wrapper", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-admin-access-golden-"));
  const store = new FileDurableConnectorConnectionStore(baseDir);
  const verified = seedVerifiedConnection(store, "bind-admin-access-golden");
  const { organization, provider, sessionToken, grants } = adminFixture("ADMIN");

  const result = mutateConnectorConnectionStateAsAuthenticatedAdmin({
    tenantScope,
    organization,
    provider,
    sessionToken,
    grants,
    store,
    connectionBindingId: verified.binding.connectionBindingId,
    to: "DEGRADED",
  });
  assert.equal(result.instance.binding.connectionState, "DEGRADED");
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "DEGRADED");
});

test("Rev188 F2 adversarial (forged identity): a sessionToken with no matching session fails inside requireInternalOsAccess itself, before the domain mutation is ever reached - zero store mutation", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-admin-access-forged-"));
  const store = new FileDurableConnectorConnectionStore(baseDir);
  const verified = seedVerifiedConnection(store, "bind-admin-access-forged");
  const { organization, provider, grants } = adminFixture("ADMIN");

  assert.throws(
    () =>
      mutateConnectorConnectionStateAsAuthenticatedAdmin({
        tenantScope,
        organization,
        provider,
        sessionToken: "a-forged-unrelated-session-token",
        grants,
        store,
        connectionBindingId: verified.binding.connectionBindingId,
        to: "DEGRADED",
      }),
    StaffUnauthenticatedError,
  );
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "VERIFIED");
});

test("Rev188 F2 adversarial (forged identity): an undefined sessionToken fails inside requireInternalOsAccess itself - zero store mutation", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-admin-access-no-token-"));
  const store = new FileDurableConnectorConnectionStore(baseDir);
  const verified = seedVerifiedConnection(store, "bind-admin-access-no-token");
  const { organization, provider, grants } = adminFixture("ADMIN");

  assert.throws(
    () =>
      mutateConnectorConnectionStateAsAuthenticatedAdmin({
        tenantScope,
        organization,
        provider,
        sessionToken: undefined,
        grants,
        store,
        connectionBindingId: verified.binding.connectionBindingId,
        to: "DEGRADED",
      }),
    StaffUnauthenticatedError,
  );
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "VERIFIED");
});

test("Rev188 F2 adversarial (stale role): an authenticated MEMBER-role session passes requireInternalOsAccess (READ-granted) but the domain mutation's own ADMIN/OWNER-role check still blocks it - zero store mutation", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-admin-access-member-"));
  const store = new FileDurableConnectorConnectionStore(baseDir);
  const verified = seedVerifiedConnection(store, "bind-admin-access-member");
  const { organization, provider, sessionToken, grants } = adminFixture("MEMBER");

  assert.throws(
    () =>
      mutateConnectorConnectionStateAsAuthenticatedAdmin({
        tenantScope,
        organization,
        provider,
        sessionToken,
        grants,
        store,
        connectionBindingId: verified.binding.connectionBindingId,
        to: "DEGRADED",
      }),
    ConnectorConnectionAdminMutationNotAuthorizedError,
  );
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "VERIFIED");
});

test("Rev188 F2 adversarial (revoked membership): a membership no longer ACTIVE matches no staff membership at all inside requireInternalOsAccess - zero store mutation", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-admin-access-revoked-"));
  const store = new FileDurableConnectorConnectionStore(baseDir);
  const verified = seedVerifiedConnection(store, "bind-admin-access-revoked");
  const { organization, provider, sessionToken, grants } = adminFixture("ADMIN");
  const revokedGrant: StaffAccessGrant = {
    ...grants[0]!,
    membership: { ...grants[0]!.membership, state: "REVOKED" } as StaffAccessGrant["membership"],
  };

  assert.throws(
    () =>
      mutateConnectorConnectionStateAsAuthenticatedAdmin({
        tenantScope,
        organization,
        provider,
        sessionToken,
        grants: [revokedGrant],
        store,
        connectionBindingId: verified.binding.connectionBindingId,
        to: "DEGRADED",
      }),
    NoStaffMembershipError,
  );
  assert.equal(store.get(tenantScope.tenantId, verified.binding.connectionBindingId)!.instance.binding.connectionState, "VERIFIED");
});
