import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createOrganizationMembership, createAssignmentReference } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { requireInternalOsAccess } from "../src/web/internal-os-access.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import {
  resolveNavVisibility,
  isDestinationVisible,
  resolveHomeView,
  resolveWorkView,
  resolveWorkProjectDetailView,
  resolvePeopleView,
  resolveProductsView,
  resolveAdminView,
  NAV_DESTINATIONS,
  type WorkProjectSource,
  type WorkJobSource,
} from "../src/web/internal-os-view-state.js";

const tenantScope = createTenantScope("tenant-os-v0-08-view");
const organization: Organization = activateOrganization({
  organization: createOrganization({ organizationId: "org-view", tenantScope, displayName: "View Test Org", createdAt: "2026-01-01T00:00:00.000Z" }),
  activatedAt: "2026-01-01T00:00:00.000Z",
});
const customer = createCustomer({ tenantScope, customerId: "customer-view", displayName: "View Customer" });
const projectAlpha = createProject({ tenantScope, customer, projectId: "project-alpha", ownerRef: "owner-a", state: "active" });
const projectBeta = createProject({ tenantScope, customer, projectId: "project-beta", ownerRef: "owner-b", state: "active" });
const jobAlpha = createOutcomeJob({
  tenantScope, customer, project: projectAlpha, jobId: "job-alpha-1", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver",
});

let viewerCounter = 0;

function contextFor(
  assignedProjectIds: ReadonlyArray<string>,
  options?: { permissions?: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">; canPerformProtectedActions?: boolean },
) {
  viewerCounter += 1;
  const principalId = `viewer-${viewerCounter}`;
  const principal = createAuthenticatedStaffPrincipal({ principalId, displayName: "Viewer" });
  const membership = createOrganizationMembership({ membershipId: `m-${principalId}`, tenantScope, principalRef: principal.principalId, role: "STAFF" });
  const assignments = assignedProjectIds.map((projectId, index) =>
    createAssignmentReference({ assignmentId: `assignment-${principalId}-${index}`, membership, customerId: customer.customerId, projectId }),
  );
  const grant = {
    membership,
    authority: createAuthorityContext({
      tenantScope,
      permissions: options?.permissions ?? ["READ"],
      canPerformProtectedActions: options?.canPerformProtectedActions ?? false,
    }),
    assignments,
  };
  const sessionToken = `token-${principalId}`;
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
    isProduction: false,
  });
  return requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });
}

function projectSourceFor(projects: ReadonlyArray<ReturnType<typeof createProject>>): WorkProjectSource {
  return {
    getProject(input) {
      return projects.find((project) => project.tenantId === input.tenantId && project.customerId === input.customerId && project.projectId === input.projectId);
    },
  };
}

function jobSourceFor(jobs: ReadonlyArray<ReturnType<typeof createOutcomeJob>>): WorkJobSource {
  return {
    listJobs(project) {
      return jobs.filter((job) => job.customerId === project.customerId && job.projectId === project.projectId);
    },
  };
}

test("Rev170 F1: resolveNavVisibility returns all 9 destinations for a Founder/high-access fixture (READ+WRITE+EXECUTE, protected actions, real assignment)", () => {
  const context = contextFor([projectAlpha.projectId], { permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true });
  const nav = resolveNavVisibility(context);
  assert.equal(nav.length, 9);
  assert.deepEqual(nav, NAV_DESTINATIONS);
});

test("Rev170 F1: resolveNavVisibility returns only home/work/people/products for a READ-only Member with exactly one assignment - materially fewer than Founder", () => {
  const context = contextFor([projectAlpha.projectId], { permissions: ["READ"], canPerformProtectedActions: false });
  const nav = resolveNavVisibility(context);
  assert.deepEqual(nav.map((destination) => destination.key), ["home", "work", "people", "products"]);
});

test("Rev170 F1: resolveNavVisibility returns only home/people/products for a READ-only Restricted fixture with zero assignments - materially fewer than Member (no Work without assignment evidence)", () => {
  const context = contextFor([], { permissions: ["READ"], canPerformProtectedActions: false });
  const nav = resolveNavVisibility(context);
  assert.deepEqual(nav.map((destination) => destination.key), ["home", "people", "products"]);
});

test("Rev170 F1: resolveNavVisibility returns an empty array when access is not GRANTED", () => {
  const context = contextFor([projectAlpha.projectId], { permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true });
  const deniedContext = { ...context, access: { ...context.access, decision: "DENIED" as const } };
  assert.deepEqual(resolveNavVisibility(deniedContext), []);
});

test("Rev170 F1: isDestinationVisible - work requires real assignment evidence, independent of permission level", () => {
  const withAssignment = contextFor([projectAlpha.projectId]);
  const withoutAssignment = contextFor([]);
  assert.equal(isDestinationVisible("work", withAssignment), true);
  assert.equal(isDestinationVisible("work", withoutAssignment), false);
});

test("Rev170 F1: isDestinationVisible - admin/ai-capabilities/connections/knowledge require WRITE, not merely READ or an OWNER/ADMIN label", () => {
  const readOnly = contextFor([]);
  const withWrite = contextFor([], { permissions: ["READ", "WRITE"] });
  for (const key of ["admin", "ai-capabilities", "connections", "knowledge"] as const) {
    assert.equal(isDestinationVisible(key, readOnly), false);
    assert.equal(isDestinationVisible(key, withWrite), true);
  }
});

test("Rev170 F1: isDestinationVisible - attention requires EXECUTE or canPerformProtectedActions", () => {
  const readOnly = contextFor([]);
  const withExecute = contextFor([], { permissions: ["READ", "EXECUTE"] });
  const withProtected = contextFor([], { permissions: ["READ"], canPerformProtectedActions: true });
  assert.equal(isDestinationVisible("attention", readOnly), false);
  assert.equal(isDestinationVisible("attention", withExecute), true);
  assert.equal(isDestinationVisible("attention", withProtected), true);
});

test("Rev170 F1: isDestinationVisible - home/people/products are always visible to any GRANTED staff member regardless of permission tier", () => {
  const readOnly = contextFor([]);
  for (const key of ["home", "people", "products"] as const) {
    assert.equal(isDestinationVisible(key, readOnly), true);
  }
});

test("resolveWorkView with no projectSource renders NOT_ACTIVE - missing data source degrades honestly, never fabricates content", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveWorkView({ context, projectSource: undefined, jobSource: undefined });
  assert.equal(view.kind, "NOT_ACTIVE");
});

test("resolveWorkView with a projectSource but zero assigned projects renders EMPTY", () => {
  const context = contextFor([]);
  const view = resolveWorkView({ context, projectSource: projectSourceFor([projectAlpha, projectBeta]), jobSource: undefined });
  assert.equal(view.kind, "EMPTY");
});

test("resolveWorkView lists ONLY the projects the current membership is assigned to, never the full project set", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveWorkView({ context, projectSource: projectSourceFor([projectAlpha, projectBeta]), jobSource: jobSourceFor([jobAlpha]) });
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") throw new Error("unreachable");
  assert.equal(view.projects.length, 1);
  assert.equal(view.projects[0]?.projectId, projectAlpha.projectId);
  assert.equal(view.projects[0]?.jobs.kind, "READY");
});

test("resolveWorkView with a projectSource but no jobSource renders each project's jobs as NOT_ACTIVE, never an empty fabricated list", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveWorkView({ context, projectSource: projectSourceFor([projectAlpha]), jobSource: undefined });
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") throw new Error("unreachable");
  assert.equal(view.projects[0]?.jobs.kind, "NOT_ACTIVE");
});

test("resolveWorkProjectDetailView: NOT_FOUND is returned before assignment is ever checked - a nonexistent project never leaks a FORBIDDEN vs NOT_FOUND distinction based on assignment", () => {
  const context = contextFor([]);
  const view = resolveWorkProjectDetailView({
    organization, context, projectSource: projectSourceFor([projectAlpha]), jobSource: undefined,
    customerId: customer.customerId, projectId: "project-does-not-exist",
  });
  assert.equal(view.kind, "NOT_FOUND");
});

test("resolveWorkProjectDetailView: a real project the caller is NOT assigned to renders FORBIDDEN - deep-linking a hidden project fails server-side", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveWorkProjectDetailView({
    organization, context, projectSource: projectSourceFor([projectAlpha, projectBeta]), jobSource: undefined,
    customerId: customer.customerId, projectId: projectBeta.projectId,
  });
  assert.equal(view.kind, "FORBIDDEN");
});

test("resolveWorkProjectDetailView: a real, assigned project renders READY with its own jobs", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveWorkProjectDetailView({
    organization, context, projectSource: projectSourceFor([projectAlpha]), jobSource: jobSourceFor([jobAlpha]),
    customerId: customer.customerId, projectId: projectAlpha.projectId,
  });
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") throw new Error("unreachable");
  assert.equal(view.project.projectId, projectAlpha.projectId);
  assert.equal(view.project.jobs.kind, "READY");
});

test("resolveWorkProjectDetailView with no projectSource renders NOT_ACTIVE, never attempting a fabricated access check", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveWorkProjectDetailView({
    organization, context, projectSource: undefined, jobSource: undefined,
    customerId: customer.customerId, projectId: projectAlpha.projectId,
  });
  assert.equal(view.kind, "NOT_ACTIVE");
});

test("resolveHomeView surfaces real organization + access summary, and embeds the same Work view logic", () => {
  const context = contextFor([projectAlpha.projectId]);
  const view = resolveHomeView({ organization, context, projectSource: projectSourceFor([projectAlpha]), jobSource: undefined });
  assert.equal(view.organization.displayName, organization.displayName);
  assert.equal(view.access.role, "MEMBER");
  assert.equal(view.work.kind, "READY");
});

test("resolvePeopleView shows only the current viewer's own membership - no directory fabrication", () => {
  const context = contextFor([]);
  const view = resolvePeopleView({ context });
  assert.equal(view.self.principalDisplayName, "Viewer");
  assert.equal(view.self.membershipState, "ACTIVE");
});

test("resolveProductsView declares only this shell as ACTIVE, everything else NOT_ACTIVE - no commercial/purchase implication", () => {
  const view = resolveProductsView();
  const activeProducts = view.products.filter((product) => product.status === "ACTIVE");
  assert.equal(activeProducts.length, 1);
  assert.match(activeProducts[0]!.name, /AKILTA OS/);
});

test("resolveAdminView exposes the caller's own real organization/access truth plus explicit NOT_ACTIVE concepts - no separate elevated-only data source", () => {
  const context = contextFor([]);
  const view = resolveAdminView({ organization, context });
  assert.equal(view.organization.displayName, organization.displayName);
  assert.equal(view.access.role, "MEMBER");
  assert.ok(view.notActiveConcepts.length > 0);
});
