import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import {
  createOrganization,
  activateOrganization,
  type Organization,
} from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import {
  requestCustomerOffboarding,
  completeCustomerOffboarding,
  denyCustomerOffboarding,
  InvalidCustomerOffboardingError,
  CustomerOffboardingDecisionError,
} from "../src/domain/customer-offboarding.js";

/**
 * CUS-OFFBOARD-001: proves the request -> (complete | deny) offboarding
 * lifecycle for a Customer composes correctly and fails closed on every
 * adversarial substitution (foreign customer, foreign tenant, self-
 * completion, resurrection from a terminal state) - mirroring this
 * corridor's own established admission-gate rigor
 * (`organization-onboarding.ts`, `OS-V1-04`'s `organization-lifecycle-
 * archive.ts`).
 */

const TENANT = createTenantScope("tenant-cus-offboard");
const OTHER_TENANT = createTenantScope("tenant-cus-offboard-other");

function activeOrg(tenantScope: ReturnType<typeof createTenantScope>, id: string): Organization {
  return activateOrganization({
    organization: createOrganization({ organizationId: id, tenantScope, displayName: `Org ${id}`, createdAt: "2026-10-13T00:00:00.000Z" }),
    activatedAt: "2026-10-13T00:00:01.000Z",
  });
}

function grantedAccess(tenantScope: ReturnType<typeof createTenantScope>, orgId: string, membershipId: string) {
  const organization = activeOrg(tenantScope, orgId);
  const membership = createOrganizationMembership({ membershipId, tenantScope, principalRef: `principal-${membershipId}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["WRITE", "EXECUTE"], canPerformProtectedActions: true });
  return resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
}

function readOnlyAccess(tenantScope: ReturnType<typeof createTenantScope>, orgId: string, membershipId: string) {
  const organization = activeOrg(tenantScope, orgId);
  const membership = createOrganizationMembership({ membershipId, tenantScope, principalRef: `principal-${membershipId}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  return resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
}

test("C1: a REQUESTED offboarding, once completed by a distinct authorized staff principal, produces a COMPLETED request and a scope-limited export snapshot", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-1", displayName: "Golden Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-1",
    customer,
    requestedByRef: "prospect:cust-1",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  assert.equal(request.status, "REQUESTED");

  const access = grantedAccess(TENANT, "org-1", "staff-1");
  const { completedRequest, snapshot } = completeCustomerOffboarding({
    request,
    customer,
    currentAccess: access,
    completedAt: "2026-10-13T00:10:00.000Z",
  });

  assert.equal(completedRequest.status, "COMPLETED");
  assert.equal(completedRequest.decidedByRef, "staff-1");
  assert.equal(snapshot.tenantId, TENANT.tenantId);
  assert.equal(snapshot.customerId, "cust-1");
  assert.equal(snapshot.displayName, "Golden Customer");
  assert.equal(snapshot.learningEligibility, "NONE");
  assert.equal(snapshot.offboardingRequestId, "req-1");
  assert.equal(snapshot.completedByPrincipalRef, "staff-1");
});

test("C2: a REQUESTED offboarding can be denied, terminally, with a recorded reason", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-2", displayName: "Denied Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-2",
    customer,
    requestedByRef: "prospect:cust-2",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access = grantedAccess(TENANT, "org-2", "staff-2");
  const denied = denyCustomerOffboarding({
    request,
    currentAccess: access,
    reason: "failed verification",
    deniedAt: "2026-10-13T00:05:00.000Z",
  });
  assert.equal(denied.status, "DENIED");
  assert.equal(denied.denialReason, "failed verification");
  assert.equal(denied.decidedByRef, "staff-2");
});

test("C3 (adversarial): completing a request with a DIFFERENT customer than it was made for is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-3", displayName: "Real Customer" });
  const foreignCustomer = createCustomer({ tenantScope: TENANT, customerId: "cust-3-foreign", displayName: "Foreign Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-3",
    customer,
    requestedByRef: "prospect:cust-3",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access = grantedAccess(TENANT, "org-3", "staff-3");
  assert.throws(
    () => completeCustomerOffboarding({ request, customer: foreignCustomer, currentAccess: access, completedAt: "2026-10-13T00:10:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C4 (adversarial): completing a request using access bound to a DIFFERENT tenant than the request is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-4", displayName: "Tenant-Bound Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-4",
    customer,
    requestedByRef: "prospect:cust-4",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const foreignAccess = grantedAccess(OTHER_TENANT, "org-4-other", "staff-4");
  assert.throws(
    () => completeCustomerOffboarding({ request, customer, currentAccess: foreignAccess, completedAt: "2026-10-13T00:10:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C5 (adversarial): completing a request with a DENIED currentAccess is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-5", displayName: "Denied Access Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-5",
    customer,
    requestedByRef: "prospect:cust-5",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const organization = activeOrg(TENANT, "org-5");
  const deniedAccess = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: "nobody",
    authority: createAuthorityContext({ tenantScope: TENANT, permissions: [], canPerformProtectedActions: false }),
  });
  assert.equal(deniedAccess.decision, "DENIED");
  assert.throws(
    () => completeCustomerOffboarding({ request, customer, currentAccess: deniedAccess, completedAt: "2026-10-13T00:10:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C6 (adversarial): completing a request with a GRANTED but non-protected-action-authorized currentAccess is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-6", displayName: "Read-Only Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-6",
    customer,
    requestedByRef: "prospect:cust-6",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access = readOnlyAccess(TENANT, "org-6", "staff-6");
  assert.equal(access.decision, "GRANTED");
  assert.equal(access.canPerformProtectedActions, false);
  assert.throws(
    () => completeCustomerOffboarding({ request, customer, currentAccess: access, completedAt: "2026-10-13T00:10:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C7 (adversarial): the requester cannot complete their own offboarding request - self-completion is structurally impossible", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-7", displayName: "Self Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-7",
    customer,
    requestedByRef: "staff-7",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const selfAccess = grantedAccess(TENANT, "org-7", "staff-7");
  assert.throws(
    () => completeCustomerOffboarding({ request, customer, currentAccess: selfAccess, completedAt: "2026-10-13T00:10:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C8 (adversarial): an already-COMPLETED request can never be completed again - no resurrection", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-8", displayName: "Once Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-8",
    customer,
    requestedByRef: "prospect:cust-8",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access = grantedAccess(TENANT, "org-8", "staff-8");
  const { completedRequest } = completeCustomerOffboarding({ request, customer, currentAccess: access, completedAt: "2026-10-13T00:10:00.000Z" });
  const access2 = grantedAccess(TENANT, "org-8b", "staff-8b");
  assert.throws(
    () => completeCustomerOffboarding({ request: completedRequest, customer, currentAccess: access2, completedAt: "2026-10-13T00:20:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C9 (adversarial): an already-DENIED request can never be completed - no resurrection", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-9", displayName: "Denied Then Completed Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-9",
    customer,
    requestedByRef: "prospect:cust-9",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const denyAccess9 = grantedAccess(TENANT, "org-9-deny", "staff-9");
  const denied = denyCustomerOffboarding({ request, currentAccess: denyAccess9, reason: "no evidence", deniedAt: "2026-10-13T00:05:00.000Z" });
  const access = grantedAccess(TENANT, "org-9", "staff-9b");
  assert.throws(
    () => completeCustomerOffboarding({ request: denied, customer, currentAccess: access, completedAt: "2026-10-13T00:10:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C10 (adversarial): denying an already-REQUESTED-then-denied request a second time is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-10", displayName: "Twice Denied Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-10",
    customer,
    requestedByRef: "prospect:cust-10",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access10 = grantedAccess(TENANT, "org-10", "staff-10");
  const denied = denyCustomerOffboarding({ request, currentAccess: access10, reason: "first denial", deniedAt: "2026-10-13T00:05:00.000Z" });
  const access10b = grantedAccess(TENANT, "org-10b", "staff-10b");
  assert.throws(
    () => denyCustomerOffboarding({ request: denied, currentAccess: access10b, reason: "second denial", deniedAt: "2026-10-13T00:06:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("D1 (adversarial, REV216 F2): denying a request with a READ-only (no WRITE) currentAccess is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-d1", displayName: "Read-Only Deny Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-d1",
    customer,
    requestedByRef: "prospect:cust-d1",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access = readOnlyAccess(TENANT, "org-d1", "staff-d1");
  assert.equal(access.decision, "GRANTED");
  assert.equal(access.permissions.has("WRITE"), false);
  assert.throws(
    () => denyCustomerOffboarding({ request, currentAccess: access, reason: "x", deniedAt: "2026-10-13T00:05:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("D2 (adversarial, REV216 F2): denying a request using access bound to a DIFFERENT tenant than the request is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-d2", displayName: "Cross-Tenant Deny Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-d2",
    customer,
    requestedByRef: "prospect:cust-d2",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const foreignAccess = grantedAccess(OTHER_TENANT, "org-d2-other", "staff-d2");
  assert.throws(
    () => denyCustomerOffboarding({ request, currentAccess: foreignAccess, reason: "x", deniedAt: "2026-10-13T00:05:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("D3 (adversarial, REV216 F2): denying a request with a DENIED currentAccess is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-d3", displayName: "Denied Access Deny Customer" });
  const request = requestCustomerOffboarding({
    requestId: "req-d3",
    customer,
    requestedByRef: "prospect:cust-d3",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const organization = activeOrg(TENANT, "org-d3");
  const deniedAccess = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: "nobody",
    authority: createAuthorityContext({ tenantScope: TENANT, permissions: [], canPerformProtectedActions: false }),
  });
  assert.equal(deniedAccess.decision, "DENIED");
  assert.throws(
    () => denyCustomerOffboarding({ request, currentAccess: deniedAccess, reason: "x", deniedAt: "2026-10-13T00:05:00.000Z" }),
    CustomerOffboardingDecisionError,
  );
});

test("C11 (adversarial): requestCustomerOffboarding rejects an empty/whitespace requestedByRef", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-11", displayName: "Invalid Request Customer" });
  assert.throws(
    () => requestCustomerOffboarding({ requestId: "req-11", customer, requestedByRef: "   ", requestedAt: "2026-10-13T00:00:00.000Z" }),
    InvalidCustomerOffboardingError,
  );
});

test("B1 (boundary scan, structural): customer-offboarding.ts imports only from tenant-scope.js, customer.js, and effective-organization-access.js - no authority.ts or organization-membership.ts direct coupling, no new runtime dependency", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const content = readFileSync(join(REPO_ROOT, "src/domain/customer-offboarding.ts"), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set(["./tenant-scope.js", "./customer.js", "./effective-organization-access.js"]);
  for (const specifier of importedModules) {
    assert.ok(allowed.has(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
});
