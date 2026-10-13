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
import { requestCustomerOffboarding, completeCustomerOffboarding } from "../src/domain/customer-offboarding.js";
import {
  startCustomerOffboardingExecution,
  advanceCustomerOffboardingExecution,
} from "../src/domain/customer-offboarding-execution.js";
import {
  projectCustomerLifecycleReadiness,
  InvalidCustomerLifecycleReadinessError,
} from "../src/domain/customer-lifecycle-readiness.js";

/**
 * V2-CUST-SURFACE-001: proves the customer lifecycle/offboarding/backup
 * readiness composition - a pure, zero-persistence read model over
 * already-accepted `CustomerOffboardingRequest`/`CustomerOffboardingExecutionState`
 * values, mirroring `subscription-usage-status.ts`'s own composition
 * discipline exactly.
 */

const TENANT = createTenantScope("tenant-lifecycle-readiness");
const OTHER_TENANT = createTenantScope("tenant-lifecycle-readiness-other");

function activeOrg(tenantScope: ReturnType<typeof createTenantScope>, id: string): Organization {
  return activateOrganization({
    organization: createOrganization({ organizationId: id, tenantScope, displayName: `Org ${id}`, createdAt: "2026-10-13T00:00:00.000Z" }),
    activatedAt: "2026-10-13T00:00:01.000Z",
  });
}

function grantedAccess(tenantScope: ReturnType<typeof createTenantScope>, orgId: string, membershipId: string) {
  const organization = activeOrg(tenantScope, orgId);
  const membership = createOrganizationMembership({ membershipId, tenantScope, principalRef: `principal-${membershipId}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  return resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
}

test("L1: a customer with no offboarding request composes NOT_REQUESTED, backupReadiness AVAILABLE, no execution status", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l1", displayName: "Lifecycle Customer One" });
  const projection = projectCustomerLifecycleReadiness({ customer });
  assert.equal(projection.tenantId, TENANT.tenantId);
  assert.equal(projection.customerId, "cust-l1");
  assert.equal(projection.offboardingStatus, "NOT_REQUESTED");
  assert.equal(projection.offboardingExecutionStatus, undefined);
  assert.equal(projection.backupReadiness, "AVAILABLE");
});

test("L2: a REQUESTED offboarding composes offboardingStatus REQUESTED, no execution status yet", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l2", displayName: "Lifecycle Customer Two" });
  const request = requestCustomerOffboarding({
    requestId: "offboard-l2",
    customer,
    requestedByRef: "prospect:l2",
    requestedAt: "2026-10-13T00:05:00.000Z",
  });
  const projection = projectCustomerLifecycleReadiness({ customer, offboardingRequest: request });
  assert.equal(projection.offboardingStatus, "REQUESTED");
  assert.equal(projection.offboardingExecutionStatus, undefined);
});

test("L3: a COMPLETED offboarding with a COMPLETED execution composes both statuses through verbatim", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l3", displayName: "Lifecycle Customer Three" });
  const request = requestCustomerOffboarding({
    requestId: "offboard-l3",
    customer,
    requestedByRef: "prospect:l3",
    requestedAt: "2026-10-13T00:05:00.000Z",
  });
  const deciderAccess = grantedAccess(TENANT, "org-l3", "staff-l3-decider");
  const { completedRequest } = completeCustomerOffboarding({
    request,
    customer,
    currentAccess: deciderAccess,
    completedAt: "2026-10-13T00:10:00.000Z",
  });
  const executionStart = startCustomerOffboardingExecution({ completedRequest });
  const executionDone = advanceCustomerOffboardingExecution({
    state: executionStart,
    evidenceRef: "internal://tests/customer-lifecycle-readiness/execution-evidence",
  });

  const projection = projectCustomerLifecycleReadiness({
    customer,
    offboardingRequest: completedRequest,
    offboardingExecution: executionDone,
  });
  assert.equal(projection.offboardingStatus, "COMPLETED");
  assert.equal(projection.offboardingExecutionStatus, "COMPLETED");
  assert.equal(projection.backupReadiness, "AVAILABLE");
});

test("L4 (adversarial): an offboardingRequest for a DIFFERENT customer than the given customer is rejected fail-closed, never silently composed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l4", displayName: "Lifecycle Customer Four" });
  const otherCustomer = createCustomer({ tenantScope: TENANT, customerId: "cust-l4-other", displayName: "Lifecycle Customer Four Other" });
  const foreignRequest = requestCustomerOffboarding({
    requestId: "offboard-l4-foreign",
    customer: otherCustomer,
    requestedByRef: "prospect:l4-other",
    requestedAt: "2026-10-13T00:05:00.000Z",
  });
  assert.throws(
    () => projectCustomerLifecycleReadiness({ customer, offboardingRequest: foreignRequest }),
    InvalidCustomerLifecycleReadinessError,
  );
});

test("L5 (adversarial): an offboardingRequest for a DIFFERENT tenant is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l5", displayName: "Lifecycle Customer Five" });
  const otherTenantCustomer = createCustomer({ tenantScope: OTHER_TENANT, customerId: "cust-l5", displayName: "Lifecycle Customer Five Other Tenant" });
  const foreignRequest = requestCustomerOffboarding({
    requestId: "offboard-l5-foreign",
    customer: otherTenantCustomer,
    requestedByRef: "prospect:l5-other",
    requestedAt: "2026-10-13T00:05:00.000Z",
  });
  assert.throws(
    () => projectCustomerLifecycleReadiness({ customer, offboardingRequest: foreignRequest }),
    InvalidCustomerLifecycleReadinessError,
  );
});

test("L6 (adversarial): an offboardingExecution supplied WITHOUT its own offboardingRequest is rejected fail-closed, never composed on its own", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l6", displayName: "Lifecycle Customer Six" });
  const request = requestCustomerOffboarding({
    requestId: "offboard-l6",
    customer,
    requestedByRef: "prospect:l6",
    requestedAt: "2026-10-13T00:05:00.000Z",
  });
  const deciderAccess = grantedAccess(TENANT, "org-l6", "staff-l6-decider");
  const { completedRequest } = completeCustomerOffboarding({
    request,
    customer,
    currentAccess: deciderAccess,
    completedAt: "2026-10-13T00:10:00.000Z",
  });
  const executionDone = advanceCustomerOffboardingExecution({
    state: startCustomerOffboardingExecution({ completedRequest }),
    evidenceRef: "internal://tests/customer-lifecycle-readiness/l6-evidence",
  });
  assert.throws(
    () => projectCustomerLifecycleReadiness({ customer, offboardingExecution: executionDone }),
    InvalidCustomerLifecycleReadinessError,
  );
});

test("L7 (adversarial): an offboardingExecution referencing a DIFFERENT offboardingRequest's own requestId is rejected fail-closed", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-l7", displayName: "Lifecycle Customer Seven" });
  const request = requestCustomerOffboarding({
    requestId: "offboard-l7",
    customer,
    requestedByRef: "prospect:l7",
    requestedAt: "2026-10-13T00:05:00.000Z",
  });
  const unrelatedRequest = requestCustomerOffboarding({
    requestId: "offboard-l7-unrelated",
    customer,
    requestedByRef: "prospect:l7-unrelated",
    requestedAt: "2026-10-13T00:06:00.000Z",
  });
  const deciderAccess = grantedAccess(TENANT, "org-l7", "staff-l7-decider");
  const { completedRequest: completedUnrelated } = completeCustomerOffboarding({
    request: unrelatedRequest,
    customer,
    currentAccess: deciderAccess,
    completedAt: "2026-10-13T00:10:00.000Z",
  });
  const executionForUnrelated = advanceCustomerOffboardingExecution({
    state: startCustomerOffboardingExecution({ completedRequest: completedUnrelated }),
    evidenceRef: "internal://tests/customer-lifecycle-readiness/l7-evidence",
  });
  assert.throws(
    () =>
      projectCustomerLifecycleReadiness({
        customer,
        offboardingRequest: request,
        offboardingExecution: executionForUnrelated,
      }),
    InvalidCustomerLifecycleReadinessError,
  );
});

test("B1 (boundary scan, structural): customer-lifecycle-readiness.ts imports only tenant-scope.js, customer.js, customer-offboarding.js, and customer-offboarding-execution.js (type-only) - no authority.ts, organization-membership.ts, or billing-reference.ts coupling", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const content = readFileSync(join(REPO_ROOT, "src/domain/customer-lifecycle-readiness.ts"), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set([
    "./tenant-scope.js",
    "./customer.js",
    "./customer-offboarding.js",
    "./customer-offboarding-execution.js",
  ]);
  for (const specifier of importedModules) {
    assert.ok(allowed.has(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/billing-reference\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/subscription-entitlement\.js["']/);
});
