import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import {
  requestCustomerOffboarding,
  completeCustomerOffboarding,
  denyCustomerOffboarding,
} from "../src/domain/customer-offboarding.js";
import {
  createOrganization,
  activateOrganization,
} from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import {
  startCustomerOffboardingExecution,
  advanceCustomerOffboardingExecution,
  InvalidCustomerOffboardingExecutionError,
} from "../src/domain/customer-offboarding-execution.js";

/**
 * CUS-OFFBOARD-002: proves the durable, idempotent, restart-safe execution
 * record on top of CUS-OFFBOARD-001's own request/decision gate - a truthful
 * BLOCKED_UNSUPPORTED disposition for every customer-scoped resource kind
 * that genuinely exists on current main (PROJECT/CUSTOMER_EVIDENCE/
 * COMMERCIAL_ORDER), never a fabricated delete/export success.
 */

const TENANT = createTenantScope("tenant-cus-offboard-002");

function grantedAccess(orgId: string, membershipId: string) {
  const organization = activateOrganization({
    organization: createOrganization({ organizationId: orgId, tenantScope: TENANT, displayName: `Org ${orgId}`, createdAt: "2026-10-13T00:00:00.000Z" }),
    activatedAt: "2026-10-13T00:00:01.000Z",
  });
  const membership = createOrganizationMembership({ membershipId, tenantScope: TENANT, principalRef: `principal-${membershipId}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope: TENANT, permissions: ["WRITE", "EXECUTE"], canPerformProtectedActions: true });
  return resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
}

function completedRequestFor(customerId: string) {
  const customer = createCustomer({ tenantScope: TENANT, customerId, displayName: `Customer ${customerId}` });
  const request = requestCustomerOffboarding({
    requestId: `req-exec-${customerId}`,
    customer,
    requestedByRef: `prospect:${customerId}`,
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const access = grantedAccess(`org-exec-${customerId}`, `staff-exec-${customerId}`);
  const { completedRequest } = completeCustomerOffboarding({
    request,
    customer,
    currentAccess: access,
    completedAt: "2026-10-13T00:10:00.000Z",
  });
  return completedRequest;
}

test("E1: execution starts NOT_STARTED with no dispositions from an already-COMPLETED request", () => {
  const completedRequest = completedRequestFor("cust-e1");
  const state = startCustomerOffboardingExecution({ completedRequest });
  assert.equal(state.status, "NOT_STARTED");
  assert.equal(state.tenantId, TENANT.tenantId);
  assert.equal(state.customerId, "cust-e1");
  assert.equal(state.offboardingRequestId, completedRequest.requestId);
  assert.deepEqual(state.resourceDispositions, []);
});

test("E2 (adversarial): execution cannot start from a merely-REQUESTED request", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-e2", displayName: "Customer E2" });
  const request = requestCustomerOffboarding({
    requestId: "req-exec-e2",
    customer,
    requestedByRef: "prospect:cust-e2",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  assert.throws(
    () => startCustomerOffboardingExecution({ completedRequest: request }),
    InvalidCustomerOffboardingExecutionError,
  );
});

test("E3 (adversarial): execution cannot start from a DENIED request", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-e3", displayName: "Customer E3" });
  const request = requestCustomerOffboarding({
    requestId: "req-exec-e3",
    customer,
    requestedByRef: "prospect:cust-e3",
    requestedAt: "2026-10-13T00:00:00.000Z",
  });
  const denyAccess = grantedAccess("org-exec-e3", "staff-e3");
  const denied = denyCustomerOffboarding({ request, currentAccess: denyAccess, reason: "no evidence", deniedAt: "2026-10-13T00:05:00.000Z" });
  assert.throws(
    () => startCustomerOffboardingExecution({ completedRequest: denied }),
    InvalidCustomerOffboardingExecutionError,
  );
});

test("E4: advancing a NOT_STARTED execution produces a truthful BLOCKED_UNSUPPORTED disposition for every real customer-scoped resource kind, never a fabricated delete/export success", () => {
  const completedRequest = completedRequestFor("cust-e4");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const advanced = advanceCustomerOffboardingExecution({ state: started, evidenceRef: "internal://tests/cus-offboard-002/evidence-1" });

  assert.equal(advanced.status, "COMPLETED");
  assert.equal(advanced.resourceDispositions.length, 3);
  const kinds = advanced.resourceDispositions.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ["COMMERCIAL_ORDER", "CUSTOMER_EVIDENCE", "PROJECT"]);
  for (const disposition of advanced.resourceDispositions) {
    assert.equal(disposition.status, "BLOCKED_UNSUPPORTED");
    assert.equal(disposition.evidenceRef, "internal://tests/cus-offboard-002/evidence-1");
    assert.ok(disposition.reason.length > 0);
  }
});

test("E5 (idempotency/restart-safety): advancing an already-COMPLETED execution is an exact no-op - a different evidenceRef on replay never overwrites the original evidence trail", () => {
  const completedRequest = completedRequestFor("cust-e5");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const firstAdvance = advanceCustomerOffboardingExecution({ state: started, evidenceRef: "internal://tests/cus-offboard-002/evidence-first" });
  const replayedAdvance = advanceCustomerOffboardingExecution({ state: firstAdvance, evidenceRef: "internal://tests/cus-offboard-002/evidence-REPLAY-DIFFERENT" });

  assert.deepEqual(replayedAdvance, firstAdvance);
  for (const disposition of replayedAdvance.resourceDispositions) {
    assert.equal(disposition.evidenceRef, "internal://tests/cus-offboard-002/evidence-first");
  }
});

test("E6 (adversarial): advancing with an empty evidenceRef is rejected fail-closed", () => {
  const completedRequest = completedRequestFor("cust-e6");
  const started = startCustomerOffboardingExecution({ completedRequest });
  assert.throws(
    () => advanceCustomerOffboardingExecution({ state: started, evidenceRef: "   " }),
    InvalidCustomerOffboardingExecutionError,
  );
});

test("B1 (boundary scan, structural): customer-offboarding-execution.ts imports only from tenant-scope.js, customer.js, and customer-offboarding.js - no authority.ts, organization-membership.ts, or project.ts/customer-evidence.ts/commercial-order.ts coupling (the resource-kind inventory is a closed string literal, never a live import of the resources themselves)", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const content = readFileSync(join(REPO_ROOT, "src/domain/customer-offboarding-execution.ts"), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set(["./tenant-scope.js", "./customer.js", "./customer-offboarding.js"]);
  for (const specifier of importedModules) {
    assert.ok(allowed.has(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/project\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/customer-evidence\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/commercial-order\.js["']/);
});
