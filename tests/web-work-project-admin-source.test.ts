import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOrganizationMembership, createAssignmentReference } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { requireInternalOsAccess } from "../src/web/internal-os-access.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { createDurableWorkProjectSource } from "../src/web/work-project-admin-source.js";
import { resolveWorkView, resolveWorkProjectDetailView } from "../src/web/internal-os-view-state.js";

/**
 * PROJ-DURABLE-001: proves `createDurableWorkProjectSource` genuinely
 * connects the long-standing `WorkProjectSource` port to the real
 * `FileDurableProjectStore` - no longer only an abstract fixture-backed
 * source - end to end through `resolveWorkView`/`resolveWorkProjectDetailView`.
 */

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "proj-durable-001-adapter-"));
}

test("createDurableWorkProjectSource surfaces a real project for the exact tenant/customer/project triple", () => {
  const dir = freshStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-work-adapter-1");
    const customer = createCustomer({ tenantScope, customerId: "customer-work-1", displayName: "Work Customer" });
    const project = createProject({ tenantScope, customer, projectId: "proj-work-1", ownerRef: "owner-ref", state: "ACTIVE" });

    const store = new FileDurableProjectStore(dir);
    store.create(project);

    const source = createDurableWorkProjectSource(store);
    const resolved = source.getProject({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
    assert.ok(resolved !== undefined);
    assert.equal(resolved?.projectId, project.projectId);
    assert.equal(resolved?.state, "ACTIVE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableWorkProjectSource returns undefined for a nonexistent project rather than throwing", () => {
  const dir = freshStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-work-adapter-2");
    const store = new FileDurableProjectStore(dir);
    const source = createDurableWorkProjectSource(store);
    assert.equal(
      source.getProject({ tenantId: tenantScope.tenantId, customerId: "customer-ghost", projectId: "proj-ghost" }),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableWorkProjectSource never surfaces a different tenant's project", () => {
  const dir = freshStoreDir();
  try {
    const tenantA = createTenantScope("tenant-work-adapter-3a");
    const tenantB = createTenantScope("tenant-work-adapter-3b");
    const customerA = createCustomer({ tenantScope: tenantA, customerId: "customer-3a", displayName: "Customer A" });
    const projectA = createProject({ tenantScope: tenantA, customer: customerA, projectId: "proj-3", ownerRef: "owner", state: "ACTIVE" });

    const store = new FileDurableProjectStore(dir);
    store.create(projectA);

    const source = createDurableWorkProjectSource(store);
    assert.equal(
      source.getProject({ tenantId: tenantB.tenantId, customerId: customerA.customerId, projectId: projectA.projectId }),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableWorkProjectSource never surfaces a different customer's project within the same tenant", () => {
  const dir = freshStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-work-adapter-4");
    const customerA = createCustomer({ tenantScope, customerId: "customer-4a", displayName: "Customer 4A" });
    const customerB = createCustomer({ tenantScope, customerId: "customer-4b", displayName: "Customer 4B" });
    const projectA = createProject({ tenantScope, customer: customerA, projectId: "proj-4", ownerRef: "owner", state: "ACTIVE" });

    const store = new FileDurableProjectStore(dir);
    store.create(projectA);

    const source = createDurableWorkProjectSource(store);
    assert.equal(
      source.getProject({ tenantId: tenantScope.tenantId, customerId: customerB.customerId, projectId: projectA.projectId }),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: resolveWorkView renders a real durably-stored project for a staff member with real assignment evidence, through the real adapter", () => {
  const dir = freshStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-work-adapter-5");
    const organization: Organization = activateOrganization({
      organization: createOrganization({ organizationId: "org-work-5", tenantScope, displayName: "Work Org 5", createdAt: "2026-01-01T00:00:00.000Z" }),
      activatedAt: "2026-01-01T00:00:00.000Z",
    });
    const customer = createCustomer({ tenantScope, customerId: "customer-5", displayName: "Customer 5" });
    const project = createProject({ tenantScope, customer, projectId: "proj-5", ownerRef: "owner", state: "ACTIVE" });

    const store = new FileDurableProjectStore(dir);
    store.create(project);
    const source = createDurableWorkProjectSource(store);

    const principal = createAuthenticatedStaffPrincipal({ principalId: "viewer-5", displayName: "Viewer 5" });
    const membership = createOrganizationMembership({ membershipId: "m-viewer-5", tenantScope, principalRef: principal.principalId, role: "STAFF" });
    const assignment = createAssignmentReference({ assignmentId: "assignment-5", membership, customerId: customer.customerId, projectId: project.projectId });
    const grant = {
      membership,
      authority: createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false }),
      assignments: [assignment],
    };
    const sessionToken = "token-viewer-5";
    const provider = createDevFixtureStaffSessionProvider({
      fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
      isProduction: false,
    });
    const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });

    const workView = resolveWorkView({ context, projectSource: source, jobSource: undefined });
    assert.equal(workView.kind, "READY");
    if (workView.kind === "READY") {
      assert.equal(workView.projects.length, 1);
      assert.equal(workView.projects[0]?.projectId, project.projectId);
      assert.equal(workView.projects[0]?.state, "ACTIVE");
    }

    const detailView = resolveWorkProjectDetailView({
      organization,
      context,
      projectSource: source,
      jobSource: undefined,
      customerId: customer.customerId,
      projectId: project.projectId,
    });
    assert.equal(detailView.kind, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
