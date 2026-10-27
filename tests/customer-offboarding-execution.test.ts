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
  assert.equal(advanced.resourceDispositions.length, 9);
  const kinds = advanced.resourceDispositions.map((d) => d.kind).sort();
  assert.deepEqual(kinds, [
    "AUDIT_EVENT",
    "BILLING_REFERENCE",
    "COMMERCIAL_ORDER",
    "CUSTOMER_EVIDENCE",
    "EVIDENCE_REFERENCE",
    "OUTCOME_JOB",
    "OUTCOME_JOB_EXECUTION",
    "PLAN_ADMISSION",
    "PROJECT",
  ]);
  for (const disposition of advanced.resourceDispositions) {
    assert.equal(
      disposition.status,
      disposition.kind === "CUSTOMER_EVIDENCE" ? "NO_AKILTA_DURABLE_RECORD" : "BLOCKED_UNSUPPORTED",
    );
    assert.equal(disposition.evidenceRef, "internal://tests/cus-offboard-002/evidence-1");
    assert.ok(disposition.reason.length > 0);
  }
});

test("E11 (E3 truthful interim): CUSTOMER_EVIDENCE is always NO_AKILTA_DURABLE_RECORD, never BLOCKED_UNSUPPORTED, and the separate durable EVIDENCE_REFERENCE kind is unaffected", () => {
  const completedRequest = completedRequestFor("cust-e11");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const advanced = advanceCustomerOffboardingExecution({ state: started, evidenceRef: "internal://tests/cus-offboard-002/evidence-e11" });

  const byKind = new Map(advanced.resourceDispositions.map((d) => [d.kind, d]));
  assert.equal(byKind.get("CUSTOMER_EVIDENCE")?.status, "NO_AKILTA_DURABLE_RECORD");
  assert.equal(byKind.get("EVIDENCE_REFERENCE")?.status, "BLOCKED_UNSUPPORTED");
});

test("E12 (adversarial, structural): NO_AKILTA_DURABLE_RECORD is never reachable for any kind other than CUSTOMER_EVIDENCE", () => {
  const completedRequest = completedRequestFor("cust-e12");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const advanced = advanceCustomerOffboardingExecution({
    state: started,
    evidenceRef: "internal://tests/cus-offboard-002/evidence-e12",
    projectExportEvidenceRef: "internal://tests/cus-offboard-002/project-export-e12",
  });
  const misplaced = advanced.resourceDispositions.filter(
    (d) => d.kind !== "CUSTOMER_EVIDENCE" && d.status === "NO_AKILTA_DURABLE_RECORD",
  );
  assert.deepEqual(misplaced, []);
});

test("E7 (E2): supplying projectExportEvidenceRef makes PROJECT's disposition EXPORTED, with every other kind unaffected and still BLOCKED_UNSUPPORTED", () => {
  const completedRequest = completedRequestFor("cust-e7");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const advanced = advanceCustomerOffboardingExecution({
    state: started,
    evidenceRef: "internal://tests/cus-offboard-002/evidence-e7",
    projectExportEvidenceRef: "internal://tests/cus-offboard-002/project-export-e7",
  });

  const byKind = new Map(advanced.resourceDispositions.map((d) => [d.kind, d]));
  const project = byKind.get("PROJECT");
  assert.equal(project?.status, "EXPORTED");
  assert.equal(project?.evidenceRef, "internal://tests/cus-offboard-002/project-export-e7");

  for (const [kind, disposition] of byKind) {
    if (kind === "PROJECT") continue;
    if (kind === "CUSTOMER_EVIDENCE") {
      assert.equal(disposition.status, "NO_AKILTA_DURABLE_RECORD");
    } else {
      assert.equal(disposition.status, "BLOCKED_UNSUPPORTED", `${kind} must remain BLOCKED_UNSUPPORTED`);
    }
    assert.equal(disposition.evidenceRef, "internal://tests/cus-offboard-002/evidence-e7");
  }
});

test("E8 (adversarial, structural): EXPORTED is never reachable for any kind other than PROJECT, even with projectExportEvidenceRef supplied", () => {
  const completedRequest = completedRequestFor("cust-e8");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const advanced = advanceCustomerOffboardingExecution({
    state: started,
    evidenceRef: "internal://tests/cus-offboard-002/evidence-e8",
    projectExportEvidenceRef: "internal://tests/cus-offboard-002/project-export-e8",
  });
  const nonProjectExported = advanced.resourceDispositions.filter((d) => d.kind !== "PROJECT" && d.status === "EXPORTED");
  assert.deepEqual(nonProjectExported, []);
});

test("E9 (adversarial): omitting projectExportEvidenceRef keeps PROJECT BLOCKED_UNSUPPORTED (backward-compatible default)", () => {
  const completedRequest = completedRequestFor("cust-e9");
  const started = startCustomerOffboardingExecution({ completedRequest });
  const advanced = advanceCustomerOffboardingExecution({ state: started, evidenceRef: "internal://tests/cus-offboard-002/evidence-e9" });
  const project = advanced.resourceDispositions.find((d) => d.kind === "PROJECT");
  assert.equal(project?.status, "BLOCKED_UNSUPPORTED");
});

test("E10 (adversarial): a whitespace-only projectExportEvidenceRef is rejected fail-closed, same discipline as evidenceRef", () => {
  const completedRequest = completedRequestFor("cust-e10");
  const started = startCustomerOffboardingExecution({ completedRequest });
  assert.throws(
    () =>
      advanceCustomerOffboardingExecution({
        state: started,
        evidenceRef: "internal://tests/cus-offboard-002/evidence-e10",
        projectExportEvidenceRef: "   ",
      }),
    InvalidCustomerOffboardingExecutionError,
  );
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
