import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createCustomer } from "../src/domain/customer.js";
import { requestCustomerOffboarding, CustomerOffboardingDecisionError } from "../src/domain/customer-offboarding.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { type StaffAccessGrant } from "../src/web/internal-os-access.js";
import { NoStaffMembershipError } from "../src/web/staff-membership-guard.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import { FileDurableCustomerOffboardingRequestStore, CustomerOffboardingRequestVersionConflictError } from "../src/domain/durable-customer-offboarding-request-store.js";
import { FileDurableCustomerRepository } from "../src/application/durable-customer-repository.js";
import {
  completeCustomerOffboardingAsAuthenticatedStaff,
  denyCustomerOffboardingAsAuthenticatedStaff,
  CustomerOffboardingRequestNotFoundError,
  CustomerNotFoundForOffboardingDecisionError,
  CustomerOffboardingTenantScopeMismatchError,
} from "../src/web/customer-offboarding-decision-access.js";

/**
 * REV216: `completeCustomerOffboardingAsAuthenticatedStaff`/
 * `denyCustomerOffboardingAsAuthenticatedStaff` (`src/web/customer-
 * offboarding-decision-access.ts`) are the missing authenticated ingress
 * boundary in front of `completeCustomerOffboarding`/`denyCustomerOffboarding`
 * - a forged identity must fail inside `requireInternalOsAccess` itself,
 * before either domain function or durable store is ever reached. Mirrors
 * `connector-connection-admin-access.test.ts`'s own exact adversarial
 * methodology (Rev188 F2).
 */

const TENANT = createTenantScope("tenant-offboard-decision-access");
const TENANT_B = createTenantScope("tenant-offboard-decision-access-b");

function freshRequestStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "offboard-decision-access-requests-"));
}

function freshCustomerStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "offboard-decision-access-customers-"));
}

function organizationFixture(): Organization {
  return activateOrganization({
    organization: createOrganization({ organizationId: "org-offboard-decision-access", tenantScope: TENANT, displayName: "Offboard Decision Org", createdAt: "2026-10-15T00:00:00.000Z" }),
    activatedAt: "2026-10-15T00:00:01.000Z",
  });
}

function staffFixture(options?: { canPerformProtectedActions?: boolean; membershipId?: string; principalId?: string }) {
  const membershipId = options?.membershipId ?? "membership-decider";
  const principalId = options?.principalId ?? "principal-decider";
  const membership = createOrganizationMembership({ membershipId, tenantScope: TENANT, principalRef: principalId, role: "STAFF" });
  const authority = createAuthorityContext({
    tenantScope: TENANT,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: options?.canPerformProtectedActions ?? true,
  });
  const principal = createAuthenticatedStaffPrincipal({ principalId, displayName: "Decider" });
  const sessionToken = `token-${membershipId}`;
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-15T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const grant: StaffAccessGrant = { membership, authority, assignments: [] };
  return { provider, sessionToken, grants: [grant], membership };
}

function seedRequest(
  requestStore: FileDurableCustomerOffboardingRequestStore,
  requestId: string,
  requestedByRef = "membership-requester",
  tenantScope: TenantScope = TENANT,
) {
  const customer = createCustomer({ tenantScope, customerId: `customer-${requestId}`, displayName: `Customer ${requestId}` });
  const request = requestCustomerOffboarding({ requestId, customer, requestedByRef, requestedAt: "2026-10-15T00:00:00.000Z" });
  const stored = requestStore.createRequested(request);
  return { customer, stored };
}

test("golden path: an authenticated staff member with protected-action authority completes an offboarding request, persisting the real durable transition and snapshot", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-golden");
    customerRepository.save(customer);
    const { provider, sessionToken, grants } = staffFixture({ canPerformProtectedActions: true });

    const result = completeCustomerOffboardingAsAuthenticatedStaff({
      organization,
      provider,
      sessionToken,
      grants,
      requestStore,
      customerRepository,
      tenantScope: TENANT,
      requestId: stored.request.requestId,
      expectedVersion: stored.version,
      completedAt: "2026-10-15T01:00:00.000Z",
    });

    assert.equal(result.stored.request.status, "COMPLETED");
    assert.equal(result.stored.version, 2);
    assert.equal(result.snapshot.customerId, customer.customerId);
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "COMPLETED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("golden path: an authenticated staff member (no protected-action authority needed) denies an offboarding request", () => {
  const requestDir = freshRequestStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const { stored } = seedRequest(requestStore, "req-deny-golden");
    const { provider, sessionToken, grants } = staffFixture({ canPerformProtectedActions: false });

    const result = denyCustomerOffboardingAsAuthenticatedStaff({
      organization,
      provider,
      sessionToken,
      grants,
      requestStore,
      tenantScope: TENANT,
      requestId: stored.request.requestId,
      expectedVersion: stored.version,
      reason: "customer withdrew",
      deniedAt: "2026-10-15T01:00:00.000Z",
    });

    assert.equal(result.request.status, "DENIED");
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "DENIED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
  }
});

test("adversarial (forged identity): a sessionToken with no matching session fails inside requireInternalOsAccess itself, before any store is reached - zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-forged");
    customerRepository.save(customer);
    const { provider, grants } = staffFixture();

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken: "a-forged-unrelated-session-token",
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      StaffUnauthenticatedError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (revoked membership): a membership no longer ACTIVE matches no staff membership at all - zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-revoked");
    customerRepository.save(customer);
    const { provider, sessionToken, grants } = staffFixture();
    const revokedGrant: StaffAccessGrant = { ...grants[0]!, membership: { ...grants[0]!.membership, state: "REVOKED" } as StaffAccessGrant["membership"] };

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants: [revokedGrant],
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      NoStaffMembershipError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (authority): an authenticated staff member WITHOUT canPerformProtectedActions passes requireInternalOsAccess but completeCustomerOffboarding's own protected-action check still blocks it - zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-noprotected");
    customerRepository.save(customer);
    const { provider, sessionToken, grants } = staffFixture({ canPerformProtectedActions: false });

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingDecisionError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (self-completion): the deciding membership equal to the request's own requestedByRef is blocked by completeCustomerOffboarding's own check - zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-self", "membership-decider");
    customerRepository.save(customer);
    const { provider, sessionToken, grants } = staffFixture({ canPerformProtectedActions: true, membershipId: "membership-decider" });

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingDecisionError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (not found): completing a nonexistent request throws CustomerOffboardingRequestNotFoundError", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { provider, sessionToken, grants } = staffFixture();

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: "req-does-not-exist" as never,
          expectedVersion: 1,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingRequestNotFoundError,
    );
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (customer not found): completing a request whose customer was never saved to the repository throws CustomerNotFoundForOffboardingDecisionError - zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { stored } = seedRequest(requestStore, "req-complete-nocustomer");
    // deliberately never calling customerRepository.save(customer)
    const { provider, sessionToken, grants } = staffFixture();

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerNotFoundForOffboardingDecisionError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (version conflict): a stale expectedVersion fails closed with CustomerOffboardingRequestVersionConflictError even though the domain decision itself was valid", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-staleversion");
    customerRepository.save(customer);
    const { provider, sessionToken, grants } = staffFixture();

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: 999,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingRequestVersionConflictError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

test("adversarial (deny, not found): denying a nonexistent request throws CustomerOffboardingRequestNotFoundError", () => {
  const requestDir = freshRequestStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const { provider, sessionToken, grants } = staffFixture();

    assert.throws(
      () =>
        denyCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken,
          grants,
          requestStore,
          tenantScope: TENANT,
          requestId: "req-does-not-exist" as never,
          expectedVersion: 1,
          reason: "x",
          deniedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingRequestNotFoundError,
    );
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
  }
});

test("adversarial (deny, forged identity): a sessionToken with no matching session fails inside requireInternalOsAccess itself - zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  try {
    const organization = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const { stored } = seedRequest(requestStore, "req-deny-forged");
    const { provider, grants } = staffFixture();

    assert.throws(
      () =>
        denyCustomerOffboardingAsAuthenticatedStaff({
          organization,
          provider,
          sessionToken: undefined,
          grants,
          requestStore,
          tenantScope: TENANT,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          reason: "x",
          deniedAt: "2026-10-15T01:00:00.000Z",
        }),
      StaffUnauthenticatedError,
    );
    assert.equal(requestStore.get(TENANT.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
  }
});

test("adversarial (cross-tenant deny, REV216 F1): an authenticated Tenant-A staff principal cannot deny Tenant B's REQUESTED request by supplying tenantScope B directly - fails on the tenant-scope binding BEFORE any store read, zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  try {
    const organizationA = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const { stored } = seedRequest(requestStore, "req-deny-crosstenant", "membership-requester", TENANT_B);
    const { provider, sessionToken, grants } = staffFixture();

    assert.throws(
      () =>
        denyCustomerOffboardingAsAuthenticatedStaff({
          organization: organizationA,
          provider,
          sessionToken,
          grants,
          requestStore,
          tenantScope: TENANT_B,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          reason: "x",
          deniedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingTenantScopeMismatchError,
    );
    assert.equal(requestStore.get(TENANT_B.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
  }
});

test("adversarial (cross-tenant complete, REV216 F1): an authenticated Tenant-A staff principal cannot complete Tenant B's REQUESTED request by supplying tenantScope B directly - fails on the tenant-scope binding BEFORE any store read, zero mutation", () => {
  const requestDir = freshRequestStoreDir();
  const customerDir = freshCustomerStoreDir();
  try {
    const organizationA = organizationFixture();
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const { customer, stored } = seedRequest(requestStore, "req-complete-crosstenant", "membership-requester", TENANT_B);
    customerRepository.save(customer);
    const { provider, sessionToken, grants } = staffFixture({ canPerformProtectedActions: true });

    assert.throws(
      () =>
        completeCustomerOffboardingAsAuthenticatedStaff({
          organization: organizationA,
          provider,
          sessionToken,
          grants,
          requestStore,
          customerRepository,
          tenantScope: TENANT_B,
          requestId: stored.request.requestId,
          expectedVersion: stored.version,
          completedAt: "2026-10-15T01:00:00.000Z",
        }),
      CustomerOffboardingTenantScopeMismatchError,
    );
    assert.equal(requestStore.get(TENANT_B.tenantId, stored.request.requestId)?.request.status, "REQUESTED");
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});
