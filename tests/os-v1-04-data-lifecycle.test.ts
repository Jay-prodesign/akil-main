import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createOrganization,
  activateOrganization,
  suspendOrganization,
  reactivateOrganization,
  offboardOrganization,
  InvalidOrganizationTransitionError,
  type Organization,
} from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
import { createOrganizationResourceBinding, resolveOrganizationResourceBindingStatus } from "../src/domain/organization-resource-binding.js";
import type { WorkerRoutingDecision } from "../src/domain/worker-routing-policy.js";
import {
  exportOrganizationLifecycleSnapshot,
  restoreOrganizationLifecycleFromSnapshot,
  InvalidOrganizationLifecycleSnapshotError,
  OrganizationLifecycleRestoreDeniedError,
  type OrganizationLifecycleSnapshot,
} from "../src/domain/organization-lifecycle-archive.js";

/**
 * OS-V1-04 ("Data Lifecycle / Backup / Restore / Migration", AA-005
 * REV209's own detailed text): prove backup/restore/export/delete/suspend/
 * migration preserve scope, authority and evidence; restore cannot
 * resurrect revoked access; export is scope-limited; offboarding
 * invalidates dependent projections; migration preserves provenance;
 * restart/replay is idempotent.
 */

const TENANT = createTenantScope("tenant-os-v1-04");
const OTHER_TENANT = createTenantScope("tenant-os-v1-04-other");

function activeOrg(id = "org-v1-04"): Organization {
  return activateOrganization({
    organization: createOrganization({ organizationId: id, tenantScope: TENANT, displayName: "Org V1-04", createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
}

function suspendedOrg(id = "org-v1-04-susp"): Organization {
  return suspendOrganization({ organization: activeOrg(id), suspendedAt: "2026-10-09T01:00:00.000Z" });
}

function grantedAccess(organization: Organization) {
  const membership = createOrganizationMembership({ membershipId: `membership-${organization.organizationId}`, tenantScope: TENANT, principalRef: `principal-${organization.organizationId}`, role: "STAFF" });
  const authority = createAuthorityContext({ tenantScope: TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  return resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority });
}

// --- organization.ts: offboardOrganization ---

test("OS-V1-04 O1: offboardOrganization transitions SUSPENDED -> OFFBOARDED, carrying offboardedAt", () => {
  const offboarded = offboardOrganization({ organization: suspendedOrg(), offboardedAt: "2026-10-09T02:00:00.000Z" });
  assert.equal(offboarded.state, "OFFBOARDED");
  assert.equal(offboarded.offboardedAt, "2026-10-09T02:00:00.000Z");
});

test("OS-V1-04 O2: offboardOrganization rejects a non-SUSPENDED organization", () => {
  assert.throws(() => offboardOrganization({ organization: activeOrg(), offboardedAt: "2026-10-09T02:00:00.000Z" }), InvalidOrganizationTransitionError);
});

test("OS-V1-04 O3: offboardOrganization rejects double-offboard and an offboardedAt before suspendedAt", () => {
  const susp = suspendedOrg();
  const offboarded = offboardOrganization({ organization: susp, offboardedAt: "2026-10-09T02:00:00.000Z" });
  assert.throws(() => offboardOrganization({ organization: offboarded, offboardedAt: "2026-10-09T03:00:00.000Z" }), InvalidOrganizationTransitionError);
  assert.throws(() => offboardOrganization({ organization: susp, offboardedAt: "2026-10-09T00:30:00.000Z" }), InvalidOrganizationTransitionError);
});

test("OS-V1-04 O4: reactivateOrganization still rejects an OFFBOARDED organization - no accidental resurrection via the existing reactivation path", () => {
  const offboarded = offboardOrganization({ organization: suspendedOrg(), offboardedAt: "2026-10-09T02:00:00.000Z" });
  assert.throws(() => reactivateOrganization({ organization: offboarded, reactivatedAt: "2026-10-09T03:00:00.000Z" }));
});

// --- organization-resource-binding.ts: OFFBOARDED gate ---

function bindingWorkerDecisions(): ReadonlyArray<{ routeRef: string; decision: WorkerRoutingDecision }> {
  return [];
}

test("OS-V1-04 O5 (offboarding invalidates dependent projections): an OFFBOARDED organization's resource binding is BLOCKED/ORGANIZATION_OFFBOARDED, even though the binding's own historical ref list is untouched", () => {
  const organization = suspendedOrg("org-v1-04-binding");
  const customer = createCustomer({ tenantScope: TENANT, customerId: "cust-v1-04", displayName: "Customer V1-04" });
  const project = createProject({ tenantScope: TENANT, customer, projectId: "proj-v1-04", ownerRef: "owner-v1-04", state: "active" });
  const ownership = createProjectOwnershipRef({ tenantId: TENANT.tenantId, customerId: customer.customerId, projectId: project.projectId });
  const membership = createOrganizationMembership({ membershipId: "membership-v1-04-binding", tenantScope: TENANT, principalRef: "principal-v1-04-binding", role: "STAFF" });
  const binding = createOrganizationResourceBinding({ organization, memberships: [membership], project, ownership, boundAt: "2026-10-09T01:30:00.000Z" });

  const offboarded = offboardOrganization({ organization, offboardedAt: "2026-10-09T02:00:00.000Z" });
  const status = resolveOrganizationResourceBindingStatus({
    binding,
    organization: offboarded,
    currentMemberships: [membership],
    currentServicePrincipals: [],
    currentConnections: [],
    currentProject: project,
    currentEffectiveConfigRefs: [],
    currentEffectivePolicyRefs: [],
    currentWorkerRouteDecisions: bindingWorkerDecisions(),
    currentKnowledgeEvidenceRefs: [],
  });
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.nextRequiredAction?.code, "ORGANIZATION_OFFBOARDED");
  assert.deepEqual(binding.membershipRefs, [membership.membershipId]);
});

// --- organization-lifecycle-archive.ts: export ---

test("OS-V1-04 E1: exportOrganizationLifecycleSnapshot is a scope-limited projection of the organization's own lifecycle fields only", () => {
  const organization = activeOrg("org-v1-04-export");
  const access = grantedAccess(organization);
  const snapshot = exportOrganizationLifecycleSnapshot({ organization, currentAccess: access, exportedAt: "2026-10-09T05:00:00.000Z" });
  assert.equal(snapshot.tenantId, organization.tenantId);
  assert.equal(snapshot.organizationId, organization.organizationId);
  assert.equal(snapshot.state, "ACTIVE");
  assert.equal(snapshot.createdAt, organization.createdAt);
  assert.equal(snapshot.activatedAt, organization.activatedAt);
  assert.equal(snapshot.exportedByPrincipalRef, access.membershipId);
  assert.deepEqual(Object.keys(snapshot).sort(), ["activatedAt", "createdAt", "displayName", "exportedAt", "exportedByPrincipalRef", "organizationId", "state", "tenantId"].sort());
});

test("OS-V1-04 E2: exportOrganizationLifecycleSnapshot is denied when currentAccess is not GRANTED", () => {
  const organization = activeOrg("org-v1-04-export-denied");
  const denied = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: "principal-nonexistent",
    authority: createAuthorityContext({ tenantScope: TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
  });
  assert.throws(() => exportOrganizationLifecycleSnapshot({ organization, currentAccess: denied, exportedAt: "2026-10-09T05:00:00.000Z" }), InvalidOrganizationLifecycleSnapshotError);
});

// --- organization-lifecycle-archive.ts: restore / migration ---

function snapshotFor(organization: Organization, access: ReturnType<typeof grantedAccess>): OrganizationLifecycleSnapshot {
  return exportOrganizationLifecycleSnapshot({ organization, currentAccess: access, exportedAt: "2026-10-09T05:00:00.000Z" });
}

test("OS-V1-04 R1: restoreOrganizationLifecycleFromSnapshot deterministically reconstructs an identical ACTIVE organization, and is idempotent on replay", () => {
  const organization = activeOrg("org-v1-04-restore");
  const access = grantedAccess(organization);
  const snapshot = snapshotFor(organization, access);

  const first = restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: organization.organizationId, currentAccess: access });
  const second = restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: organization.organizationId, currentAccess: access });
  assert.deepEqual(first, second, "restore/replay must be idempotent - identical inputs produce a deep-equal result");
  assert.deepEqual(first.organization, organization);
  assert.equal(first.migratedFrom, undefined);
});

test("OS-V1-04 R2 (partial restore): a BOOTSTRAPPING-only snapshot (no activatedAt/suspendedAt) restores to a BOOTSTRAPPING organization only - never fabricating further lifecycle state", () => {
  const organization = createOrganization({ organizationId: "org-v1-04-partial", tenantScope: TENANT, displayName: "Org Partial", createdAt: "2026-10-09T00:00:00.000Z" });
  // A BOOTSTRAPPING org has no real membership yet to authenticate export
  // with in production, but this witness only needs to prove the pure
  // restore-reconstruction's own partial-state behavior, so a synthetic
  // GRANTED access is supplied directly as already-resolved evidence.
  const access = grantedAccess(activeOrg("org-v1-04-partial-actor"));
  const snapshot: OrganizationLifecycleSnapshot = {
    tenantId: organization.tenantId,
    organizationId: organization.organizationId,
    displayName: organization.displayName,
    state: organization.state,
    createdAt: organization.createdAt,
    exportedAt: "2026-10-09T05:00:00.000Z",
    exportedByPrincipalRef: "principal-export",
  };
  const result = restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: organization.organizationId, currentAccess: access });
  assert.equal(result.organization.state, "BOOTSTRAPPING");
  assert.equal(result.organization.activatedAt, undefined);
  assert.equal(result.organization.suspendedAt, undefined);
});

test("OS-V1-04 R3 (migration preserves provenance): restoring a snapshot under a DIFFERENT targetOrganizationId in the SAME tenant records migratedFrom, never silently discarding the original identity", () => {
  const organization = activeOrg("org-v1-04-migrate-source");
  const access = grantedAccess(organization);
  const snapshot = snapshotFor(organization, access);

  const result = restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: "org-v1-04-migrate-target", currentAccess: access });
  assert.equal(result.organization.organizationId, "org-v1-04-migrate-target");
  assert.equal(result.organization.state, "ACTIVE");
  assert.deepEqual(result.migratedFrom, { tenantId: organization.tenantId, organizationId: organization.organizationId });
});

test("OS-V1-04 R4 (restore cannot resurrect revoked access): a caller whose own currentAccess is not GRANTED is denied, regardless of the snapshot's own content", () => {
  const organization = activeOrg("org-v1-04-revoked-actor");
  const access = grantedAccess(organization);
  const snapshot = snapshotFor(organization, access);

  const deniedAccess = resolveEffectiveOrganizationAccess({
    organization,
    currentPrincipalRef: "principal-no-longer-a-member",
    authority: createAuthorityContext({ tenantScope: TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
  });
  assert.throws(
    () => restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: organization.organizationId, currentAccess: deniedAccess }),
    OrganizationLifecycleRestoreDeniedError,
  );
});

test("OS-V1-04 R5: restore is denied when currentAccess lacks canPerformProtectedActions, even though the decision itself is GRANTED", () => {
  const organization = activeOrg("org-v1-04-no-protected");
  const membership = createOrganizationMembership({ membershipId: "membership-v1-04-no-protected", tenantScope: TENANT, principalRef: "principal-v1-04-no-protected", role: "STAFF" });
  const readOnlyAuthority = createAuthorityContext({ tenantScope: TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: false });
  const access = resolveEffectiveOrganizationAccess({ organization, membership, currentPrincipalRef: membership.principalRef, authority: readOnlyAuthority });
  assert.equal(access.decision, "GRANTED");
  const snapshot = snapshotFor(organization, grantedAccess(organization));

  assert.throws(
    () => restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: organization.organizationId, currentAccess: access }),
    OrganizationLifecycleRestoreDeniedError,
  );
});

test("OS-V1-04 R6 (foreign export/restore denied): a snapshot cannot be restored into a DIFFERENT tenant than the one it was exported from", () => {
  const organization = activeOrg("org-v1-04-cross-tenant");
  const access = grantedAccess(organization);
  const snapshot = snapshotFor(organization, access);

  const otherTenantMembership = createOrganizationMembership({ membershipId: "membership-other-tenant", tenantScope: OTHER_TENANT, principalRef: "principal-other-tenant", role: "STAFF" });
  const otherTenantOrg = activateOrganization({
    organization: createOrganization({ organizationId: "org-other-tenant", tenantScope: OTHER_TENANT, displayName: "Other Tenant Org", createdAt: "2026-10-09T00:00:00.000Z" }),
    activatedAt: "2026-10-09T00:00:01.000Z",
  });
  const otherTenantAccess = resolveEffectiveOrganizationAccess({
    organization: otherTenantOrg,
    membership: otherTenantMembership,
    currentPrincipalRef: otherTenantMembership.principalRef,
    authority: createAuthorityContext({ tenantScope: OTHER_TENANT, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
  });

  assert.throws(
    () => restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: OTHER_TENANT, targetOrganizationId: organization.organizationId, currentAccess: otherTenantAccess }),
    OrganizationLifecycleRestoreDeniedError,
  );
});

test("OS-V1-04 R7 (deleted-data reappearance denied): an OFFBOARDED organization's own snapshot can never be restored", () => {
  const organization = suspendedOrg("org-v1-04-offboarded-export");
  const access = grantedAccess(organization);
  const offboarded = offboardOrganization({ organization, offboardedAt: "2026-10-09T02:00:00.000Z" });
  const snapshot = exportOrganizationLifecycleSnapshot({ organization: offboarded, currentAccess: access, exportedAt: "2026-10-09T05:00:00.000Z" });
  assert.equal(snapshot.state, "OFFBOARDED");

  assert.throws(
    () => restoreOrganizationLifecycleFromSnapshot({ snapshot, targetTenantScope: TENANT, targetOrganizationId: organization.organizationId, currentAccess: access }),
    OrganizationLifecycleRestoreDeniedError,
  );
});
