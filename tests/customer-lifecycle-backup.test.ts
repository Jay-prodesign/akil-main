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
import { createOrganizationMembership, revokeOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import { requestCustomerOffboarding, completeCustomerOffboarding } from "../src/domain/customer-offboarding.js";
import {
  exportCustomerLifecycleSnapshot,
  exportCustomerProjectsSnapshot,
  restoreCustomerLifecycleFromSnapshot,
  InvalidCustomerLifecycleSnapshotError,
  CustomerLifecycleRestoreDeniedError,
} from "../src/domain/customer-lifecycle-backup.js";
import { createProject } from "../src/domain/project.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableCustomerOffboardingRequestStore } from "../src/domain/durable-customer-offboarding-request-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * CUS-BACKUP-001: proves the export -> restore lifecycle for a Customer
 * composes correctly and fails closed on every adversarial substitution
 * (non-GRANTED access, foreign tenant, already-offboarded customer) -
 * mirroring `organization-lifecycle-archive.ts`'s own OS-V1-04 rigor,
 * ported to `Customer`.
 */

const TENANT = createTenantScope("tenant-cus-backup");
const OTHER_TENANT = createTenantScope("tenant-cus-backup-other");

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

function readOnlyAccess(tenantScope: ReturnType<typeof createTenantScope>, orgId: string, membershipId: string) {
  const organization = activeOrg(tenantScope, orgId);
  const membership = createOrganizationMembership({ membershipId, tenantScope, principalRef: `principal-${membershipId}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  return resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
}

test("B1: exportCustomerLifecycleSnapshot is a scope-limited projection of the customer's own public fields only", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-b1", displayName: "Backup Customer One" });
  const access = grantedAccess(TENANT, "org-b1", "staff-b1");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: access, exportedAt: "2026-10-13T01:00:00.000Z" });
  assert.equal(snapshot.tenantId, TENANT.tenantId);
  assert.equal(snapshot.customerId, "cust-b1");
  assert.equal(snapshot.displayName, "Backup Customer One");
  assert.equal(snapshot.learningEligibility, "NONE");
  assert.equal(snapshot.exportedByPrincipalRef, "staff-b1");
});

test("B2 (adversarial): export is denied when currentAccess is not GRANTED, even when the DENIED resolution still carries a membershipId (a revoked membership)", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-b2", displayName: "Backup Customer Two" });
  const organization = activeOrg(TENANT, "org-b2");
  const membership = createOrganizationMembership({ membershipId: "staff-b2-revoked", tenantScope: TENANT, principalRef: "principal-staff-b2-revoked", role: "STAFF" });
  const revoked = revokeOrganizationMembership({ membership, revokedAt: "2026-10-13T00:30:00.000Z", revokedReason: "test revocation" });
  const authority = createAuthorityContext({ tenantScope: TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const deniedAccess = resolveEffectiveOrganizationAccess({ organization, membership: revoked, currentPrincipalRef: revoked.principalRef, authority });
  assert.equal(deniedAccess.decision, "DENIED");
  assert.equal(deniedAccess.membershipId, "staff-b2-revoked");
  assert.throws(
    () => exportCustomerLifecycleSnapshot({ customer, currentAccess: deniedAccess, exportedAt: "2026-10-13T01:00:00.000Z" }),
    InvalidCustomerLifecycleSnapshotError,
  );
});

test("B3 (adversarial): export is denied when currentAccess belongs to a DIFFERENT tenant than the customer", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-b3", displayName: "Backup Customer Three" });
  const foreignAccess = grantedAccess(OTHER_TENANT, "org-b3-foreign", "staff-b3-foreign");
  assert.throws(
    () => exportCustomerLifecycleSnapshot({ customer, currentAccess: foreignAccess, exportedAt: "2026-10-13T01:00:00.000Z" }),
    InvalidCustomerLifecycleSnapshotError,
  );
});

test("B4 (adversarial): export is denied when currentAccess is GRANTED but not bound to a real OrganizationMembership (membershipId undefined)", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-b4", displayName: "Backup Customer Four" });
  const grantedNoMembership = {
    decision: "GRANTED" as const,
    tenantId: TENANT.tenantId,
    organizationId: "org-b4" as Organization["organizationId"],
    permissions: new Set<never>(),
    canPerformProtectedActions: true,
    reasons: [],
  };
  assert.throws(
    () => exportCustomerLifecycleSnapshot({ customer, currentAccess: grantedNoMembership, exportedAt: "2026-10-13T01:00:00.000Z" }),
    InvalidCustomerLifecycleSnapshotError,
  );
});

test("R1: restoreCustomerLifecycleFromSnapshot deterministically reconstructs an identical Customer, and is idempotent on replay", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r1", displayName: "Backup Customer R1" });
  const exportAccess = grantedAccess(TENANT, "org-r1", "staff-r1-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const restoreAccess = grantedAccess(TENANT, "org-r1", "staff-r1-restore");
  const first = restoreCustomerLifecycleFromSnapshot({
    snapshot,
    targetTenantScope: TENANT,
    targetCustomerId: "cust-r1",
    currentAccess: restoreAccess,
  });
  const second = restoreCustomerLifecycleFromSnapshot({
    snapshot,
    targetTenantScope: TENANT,
    targetCustomerId: "cust-r1",
    currentAccess: restoreAccess,
  });
  assert.deepEqual(first, second);
  assert.equal(first.customer.tenantId, TENANT.tenantId);
  assert.equal(first.customer.customerId, "cust-r1");
  assert.equal(first.customer.displayName, "Backup Customer R1");
  assert.equal(first.customer.learningEligibility, "NONE");
  assert.equal(first.migratedFrom, undefined);
});

test("R2 (migration preserves provenance): restoring a snapshot under a DIFFERENT targetCustomerId in the SAME tenant records migratedFrom, never silently discarding the original identity", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r2-original", displayName: "Backup Customer R2" });
  const exportAccess = grantedAccess(TENANT, "org-r2", "staff-r2-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const restoreAccess = grantedAccess(TENANT, "org-r2", "staff-r2-restore");
  const result = restoreCustomerLifecycleFromSnapshot({
    snapshot,
    targetTenantScope: TENANT,
    targetCustomerId: "cust-r2-rekeyed",
    currentAccess: restoreAccess,
  });
  assert.equal(result.customer.customerId, "cust-r2-rekeyed");
  assert.deepEqual(result.migratedFrom, { tenantId: TENANT.tenantId, customerId: "cust-r2-original" });
});

test("R3a (adversarial): restore is denied when currentAccess lacks canPerformProtectedActions, even though the decision itself is GRANTED", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r3a", displayName: "Backup Customer R3a" });
  const exportAccess = grantedAccess(TENANT, "org-r3a", "staff-r3a-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const readOnly = readOnlyAccess(TENANT, "org-r3a", "staff-r3a-readonly");
  assert.equal(readOnly.decision, "GRANTED");
  assert.equal(readOnly.canPerformProtectedActions, false);
  assert.throws(
    () =>
      restoreCustomerLifecycleFromSnapshot({
        snapshot,
        targetTenantScope: TENANT,
        targetCustomerId: "cust-r3a",
        currentAccess: readOnly,
      }),
    CustomerLifecycleRestoreDeniedError,
  );
});

test("R3b (adversarial, restore cannot resurrect revoked access): a caller whose own currentAccess decision is DENIED is denied, regardless of the snapshot's own content - checked independently of canPerformProtectedActions (the real resolver always sets canPerformProtectedActions=false alongside DENIED, but this interface permits a caller to supply any conforming object, so the decision check must hold on its own, defense-in-depth, not merely as a side effect of the canPerformProtectedActions check)", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r3b", displayName: "Backup Customer R3b" });
  const exportAccess = grantedAccess(TENANT, "org-r3b", "staff-r3b-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const deniedAccess = {
    decision: "DENIED" as const,
    tenantId: TENANT.tenantId,
    organizationId: "org-r3b" as Organization["organizationId"],
    permissions: new Set<never>(),
    canPerformProtectedActions: true,
    reasons: ["membership revoked"],
  };
  assert.throws(
    () =>
      restoreCustomerLifecycleFromSnapshot({
        snapshot,
        targetTenantScope: TENANT,
        targetCustomerId: "cust-r3b",
        currentAccess: deniedAccess,
      }),
    CustomerLifecycleRestoreDeniedError,
  );
});

test("R4 (adversarial, foreign export/restore denied): a snapshot cannot be restored into a DIFFERENT tenant than the one it was exported from", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r4", displayName: "Backup Customer R4" });
  const exportAccess = grantedAccess(TENANT, "org-r4", "staff-r4-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const foreignAccess = grantedAccess(OTHER_TENANT, "org-r4-foreign", "staff-r4-foreign");
  assert.throws(
    () =>
      restoreCustomerLifecycleFromSnapshot({
        snapshot,
        targetTenantScope: OTHER_TENANT,
        targetCustomerId: "cust-r4",
        currentAccess: foreignAccess,
      }),
    CustomerLifecycleRestoreDeniedError,
  );
});

test("R4b (adversarial): restore is denied when currentAccess belongs to a DIFFERENT tenant than targetTenantScope, even though the snapshot's own tenantId matches targetTenantScope", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r4b", displayName: "Backup Customer R4b" });
  const exportAccess = grantedAccess(TENANT, "org-r4b", "staff-r4b-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const foreignCallerAccess = grantedAccess(OTHER_TENANT, "org-r4b-foreign", "staff-r4b-foreign");
  assert.throws(
    () =>
      restoreCustomerLifecycleFromSnapshot({
        snapshot,
        targetTenantScope: TENANT,
        targetCustomerId: "cust-r4b",
        currentAccess: foreignCallerAccess,
      }),
    CustomerLifecycleRestoreDeniedError,
  );
});

test("R5 (adversarial, deleted-data reappearance denied): a customer whose offboarding request already reached COMPLETED can never be restored", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r5", displayName: "Backup Customer R5" });
  const exportAccess = grantedAccess(TENANT, "org-r5", "staff-r5-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const offboardingRequest = requestCustomerOffboarding({
    requestId: "offboard-r5",
    customer,
    requestedByRef: "prospect:r5",
    requestedAt: "2026-10-13T01:05:00.000Z",
  });
  const deciderAccess = grantedAccess(TENANT, "org-r5", "staff-r5-decider");
  const { completedRequest } = completeCustomerOffboarding({
    request: offboardingRequest,
    customer,
    currentAccess: deciderAccess,
    completedAt: "2026-10-13T01:10:00.000Z",
  });

  const restoreAccess = grantedAccess(TENANT, "org-r5", "staff-r5-restore");
  assert.throws(
    () =>
      restoreCustomerLifecycleFromSnapshot({
        snapshot,
        targetTenantScope: TENANT,
        targetCustomerId: "cust-r5",
        currentAccess: restoreAccess,
        relatedOffboardingRequest: completedRequest,
      }),
    CustomerLifecycleRestoreDeniedError,
  );
});

test("R6: restore succeeds when a relatedOffboardingRequest is supplied but is still REQUESTED (not yet COMPLETED)", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r6", displayName: "Backup Customer R6" });
  const exportAccess = grantedAccess(TENANT, "org-r6", "staff-r6-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const pendingRequest = requestCustomerOffboarding({
    requestId: "offboard-r6",
    customer,
    requestedByRef: "prospect:r6",
    requestedAt: "2026-10-13T01:05:00.000Z",
  });

  const restoreAccess = grantedAccess(TENANT, "org-r6", "staff-r6-restore");
  const result = restoreCustomerLifecycleFromSnapshot({
    snapshot,
    targetTenantScope: TENANT,
    targetCustomerId: "cust-r6",
    currentAccess: restoreAccess,
    relatedOffboardingRequest: pendingRequest,
  });
  assert.equal(result.customer.customerId, "cust-r6");
});

test("R7 (adversarial): a relatedOffboardingRequest for a DIFFERENT (tenantId, customerId) than the snapshot is rejected, never silently ignored", () => {
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-r7", displayName: "Backup Customer R7" });
  const exportAccess = grantedAccess(TENANT, "org-r7", "staff-r7-export");
  const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-13T01:00:00.000Z" });

  const otherCustomer = createCustomer({ tenantScope: TENANT, customerId: "cust-r7-other", displayName: "Backup Customer R7 Other" });
  const unrelatedRequest = requestCustomerOffboarding({
    requestId: "offboard-r7-other",
    customer: otherCustomer,
    requestedByRef: "prospect:r7-other",
    requestedAt: "2026-10-13T01:05:00.000Z",
  });

  const restoreAccess = grantedAccess(TENANT, "org-r7", "staff-r7-restore");
  assert.throws(
    () =>
      restoreCustomerLifecycleFromSnapshot({
        snapshot,
        targetTenantScope: TENANT,
        targetCustomerId: "cust-r7",
        currentAccess: restoreAccess,
        relatedOffboardingRequest: unrelatedRequest,
      }),
    CustomerLifecycleRestoreDeniedError,
  );
});

test("boundary scan (structural): customer-lifecycle-backup.ts imports only tenant-scope.js, customer.js, effective-organization-access.js, customer-offboarding.js, project.js, durable-project-store.js, and durable-customer-offboarding-request-store.js (all type-only except customer.js) - no organization.ts/authority.ts coupling, no widening of Customer itself", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const content = readFileSync(join(REPO_ROOT, "src/domain/customer-lifecycle-backup.ts"), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set([
    "./tenant-scope.js",
    "./customer.js",
    "./effective-organization-access.js",
    "./customer-offboarding.js",
    "./project.js",
    "./durable-project-store.js",
    "./durable-customer-offboarding-request-store.js",
  ]);
  for (const specifier of importedModules) {
    assert.ok(allowed.has(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  assert.doesNotMatch(content, /from ["']\.\/organization\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
});

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "cus-backup-001-project-export-"));
}

function tmpOffboardingRequestDir(): string {
  return mkdtempSync(join(tmpdir(), "cus-backup-001-offboarding-restore-"));
}

test("P1 (E2): exportCustomerProjectsSnapshot is a read-only projection over DurableProjectStore.listByCustomer, scoped to exactly this customer's projects", () => {
  const dir = tmpProjectDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-p1", displayName: "Export Customer One" });
    const otherCustomer = createCustomer({ tenantScope: TENANT, customerId: "cust-p1-other", displayName: "Export Customer Other" });
    store.create({ tenantId: TENANT.tenantId, customerId: customer.customerId, projectId: "proj-a" as never, ownerRef: "owner-1", state: "ACTIVE" });
    store.create({ tenantId: TENANT.tenantId, customerId: customer.customerId, projectId: "proj-b" as never, ownerRef: "owner-1", state: "ACTIVE" });
    store.create({ tenantId: TENANT.tenantId, customerId: otherCustomer.customerId, projectId: "proj-c" as never, ownerRef: "owner-2", state: "ACTIVE" });

    const access = grantedAccess(TENANT, "org-p1", "staff-p1");
    const snapshot = exportCustomerProjectsSnapshot({
      tenantId: TENANT.tenantId,
      customerId: customer.customerId,
      currentAccess: access,
      projectStore: store,
      exportedAt: "2026-10-23T00:00:00.000Z",
    });
    assert.equal(snapshot.customerId, "cust-p1");
    assert.equal(snapshot.projects.length, 2);
    assert.deepEqual(snapshot.projects.map((p) => p.projectId).sort(), ["proj-a", "proj-b"]);
    assert.equal(snapshot.exportedByPrincipalRef, "staff-p1");

    // Non-destructive: both projects still present afterward, unmodified.
    assert.equal(store.listByCustomer(TENANT.tenantId, customer.customerId).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2 (adversarial): exportCustomerProjectsSnapshot is denied when currentAccess is not GRANTED", () => {
  const dir = tmpProjectDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-p2", displayName: "Export Customer Two" });
    const readOnly = readOnlyAccess(TENANT, "org-p2", "staff-p2");
    assert.throws(
      () =>
        exportCustomerProjectsSnapshot({
          tenantId: TENANT.tenantId,
          customerId: customer.customerId,
          currentAccess: { ...readOnly, decision: "DENIED" as never },
          projectStore: store,
          exportedAt: "2026-10-23T00:00:00.000Z",
        }),
      InvalidCustomerLifecycleSnapshotError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P3 (adversarial): exportCustomerProjectsSnapshot is denied when currentAccess belongs to a different tenant", () => {
  const dir = tmpProjectDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-p3", displayName: "Export Customer Three" });
    const foreignAccess = grantedAccess(OTHER_TENANT, "org-p3-foreign", "staff-p3-foreign");
    assert.throws(
      () =>
        exportCustomerProjectsSnapshot({
          tenantId: TENANT.tenantId,
          customerId: customer.customerId,
          currentAccess: foreignAccess,
          projectStore: store,
          exportedAt: "2026-10-23T00:00:00.000Z",
        }),
      InvalidCustomerLifecycleSnapshotError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4 (adversarial): exportCustomerProjectsSnapshot is denied when currentAccess is GRANTED but has no bound membershipId", () => {
  const dir = tmpProjectDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-p4", displayName: "Export Customer Four" });
    const grantedNoMembership = {
      decision: "GRANTED" as const,
      tenantId: TENANT.tenantId,
      organizationId: "org-p4" as Organization["organizationId"],
      permissions: new Set<never>(),
      canPerformProtectedActions: true,
      reasons: [],
    };
    assert.throws(
      () =>
        exportCustomerProjectsSnapshot({
          tenantId: TENANT.tenantId,
          customerId: customer.customerId,
          currentAccess: grantedNoMembership,
          projectStore: store,
          exportedAt: "2026-10-23T00:00:00.000Z",
        }),
      InvalidCustomerLifecycleSnapshotError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1 (E4): restore is denied when offboardingRequestStore records a COMPLETED request for this customer, EVEN IF the caller omits relatedOffboardingRequest entirely", () => {
  const dir = tmpOffboardingRequestDir();
  try {
    const requestStore = new FileDurableCustomerOffboardingRequestStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-s1", displayName: "Restore Customer S1" });
    const exportAccess = grantedAccess(TENANT, "org-s1", "staff-s1-export");
    const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-23T00:00:00.000Z" });

    const request = requestCustomerOffboarding({
      requestId: "offboard-s1",
      customer,
      requestedByRef: "prospect:s1",
      requestedAt: "2026-10-23T00:05:00.000Z",
    });
    const created = requestStore.createRequested(request);
    const decideAccess = grantedAccess(TENANT, "org-s1", "staff-s1-decide");
    const { completedRequest } = completeCustomerOffboarding({ request, customer, currentAccess: decideAccess, completedAt: "2026-10-23T00:10:00.000Z" });
    requestStore.transitionToTerminal({ tenantId: TENANT.tenantId, requestId: "offboard-s1" as never, expectedVersion: created.version, next: completedRequest });

    const restoreAccess = grantedAccess(TENANT, "org-s1", "staff-s1-restore");
    // Caller supplies NO relatedOffboardingRequest - only the store, which must catch it anyway.
    assert.throws(
      () =>
        restoreCustomerLifecycleFromSnapshot({
          snapshot,
          targetTenantScope: TENANT,
          targetCustomerId: "cust-s1",
          currentAccess: restoreAccess,
          offboardingRequestStore: requestStore,
        }),
      CustomerLifecycleRestoreDeniedError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: restore succeeds when offboardingRequestStore is supplied but has no COMPLETED request for this customer", () => {
  const dir = tmpOffboardingRequestDir();
  try {
    const requestStore = new FileDurableCustomerOffboardingRequestStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-s2", displayName: "Restore Customer S2" });
    const exportAccess = grantedAccess(TENANT, "org-s2", "staff-s2-export");
    const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-23T00:00:00.000Z" });

    const restoreAccess = grantedAccess(TENANT, "org-s2", "staff-s2-restore");
    const result = restoreCustomerLifecycleFromSnapshot({
      snapshot,
      targetTenantScope: TENANT,
      targetCustomerId: "cust-s2",
      currentAccess: restoreAccess,
      offboardingRequestStore: requestStore,
    });
    assert.equal(result.customer.customerId, "cust-s2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 (backward-compatible): omitting offboardingRequestStore entirely preserves the original caller-supplied-only behavior exactly (restore succeeds with no relatedOffboardingRequest, even if a COMPLETED request exists in a store the caller didn't pass)", () => {
  const dir = tmpOffboardingRequestDir();
  try {
    const requestStore = new FileDurableCustomerOffboardingRequestStore(dir);
    const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-s3", displayName: "Restore Customer S3" });
    const exportAccess = grantedAccess(TENANT, "org-s3", "staff-s3-export");
    const snapshot = exportCustomerLifecycleSnapshot({ customer, currentAccess: exportAccess, exportedAt: "2026-10-23T00:00:00.000Z" });

    const request = requestCustomerOffboarding({
      requestId: "offboard-s3",
      customer,
      requestedByRef: "prospect:s3",
      requestedAt: "2026-10-23T00:05:00.000Z",
    });
    const created = requestStore.createRequested(request);
    const decideAccess = grantedAccess(TENANT, "org-s3", "staff-s3-decide");
    const { completedRequest } = completeCustomerOffboarding({ request, customer, currentAccess: decideAccess, completedAt: "2026-10-23T00:10:00.000Z" });
    requestStore.transitionToTerminal({ tenantId: TENANT.tenantId, requestId: "offboard-s3" as never, expectedVersion: created.version, next: completedRequest });

    const restoreAccess = grantedAccess(TENANT, "org-s3", "staff-s3-restore");
    const result = restoreCustomerLifecycleFromSnapshot({
      snapshot,
      targetTenantScope: TENANT,
      targetCustomerId: "cust-s3",
      currentAccess: restoreAccess,
      // offboardingRequestStore deliberately omitted
    });
    assert.equal(result.customer.customerId, "cust-s3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
