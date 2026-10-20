import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableOutcomeJobStore, persistWiredOutcomeJobs } from "../src/domain/durable-outcome-job-store.js";
import { createDurableWorkProjectSource } from "../src/web/work-project-admin-source.js";
import { createDurableWorkJobSource } from "../src/web/work-job-admin-source.js";
import { resolveWorkView, resolveWorkProjectDetailView } from "../src/web/internal-os-view-state.js";

/**
 * WORK-JOB-SOURCE-001: proves `createDurableWorkJobSource` genuinely
 * connects the long-standing `WorkJobSource` port to the real, already-
 * accepted `FileDurableOutcomeJobStore` (OS-V0-03) - no longer only an
 * abstract fixture-backed source - end to end through
 * `resolveWorkView`/`resolveWorkProjectDetailView`, composed with
 * `PROJ-DURABLE-001`'s `createDurableWorkProjectSource`.
 */

function freshJobStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "work-job-source-001-jobs-"));
}

function freshProjectStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "work-job-source-001-projects-"));
}

test("createDurableWorkJobSource surfaces real jobs for the exact project", () => {
  const jobDir = freshJobStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-job-adapter-1");
    const customer = createCustomer({ tenantScope, customerId: "customer-job-1", displayName: "Job Customer" });
    const project = createProject({ tenantScope, customer, projectId: "proj-job-1", ownerRef: "owner", state: "ACTIVE" });
    const job = createOutcomeJob({ tenantScope, customer, project, jobId: "job-1", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });

    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    persistWiredOutcomeJobs(jobStore, [job]);

    const source = createDurableWorkJobSource(jobStore);
    const jobs = source.listJobs(project);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.jobId, "job-1");
    assert.equal(jobs[0]?.state, "DRAFT");
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("createDurableWorkJobSource returns an empty list for a project with no jobs, never throwing", () => {
  const jobDir = freshJobStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-job-adapter-2");
    const customer = createCustomer({ tenantScope, customerId: "customer-job-2", displayName: "Job Customer 2" });
    const project = createProject({ tenantScope, customer, projectId: "proj-job-2", ownerRef: "owner", state: "ACTIVE" });

    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    const source = createDurableWorkJobSource(jobStore);
    assert.deepEqual(source.listJobs(project), []);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("createDurableWorkJobSource never surfaces a different project's jobs within the same tenant/customer", () => {
  const jobDir = freshJobStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-job-adapter-3");
    const customer = createCustomer({ tenantScope, customerId: "customer-job-3", displayName: "Job Customer 3" });
    const projectA = createProject({ tenantScope, customer, projectId: "proj-job-3a", ownerRef: "owner", state: "ACTIVE" });
    const projectB = createProject({ tenantScope, customer, projectId: "proj-job-3b", ownerRef: "owner", state: "ACTIVE" });
    const jobA = createOutcomeJob({ tenantScope, customer, project: projectA, jobId: "job-3a", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });

    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    persistWiredOutcomeJobs(jobStore, [jobA]);

    const source = createDurableWorkJobSource(jobStore);
    assert.deepEqual(source.listJobs(projectB), []);
    assert.equal(source.listJobs(projectA).length, 1);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("end to end: resolveWorkView renders real durably-stored jobs for a real durably-stored project, through both real adapters composed together", () => {
  const jobDir = freshJobStoreDir();
  const projectDir = freshProjectStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-job-adapter-4");
    const organization: Organization = activateOrganization({
      organization: createOrganization({ organizationId: "org-job-4", tenantScope, displayName: "Job Org 4", createdAt: "2026-01-01T00:00:00.000Z" }),
      activatedAt: "2026-01-01T00:00:00.000Z",
    });
    const customer = createCustomer({ tenantScope, customerId: "customer-job-4", displayName: "Job Customer 4" });
    const project = createProject({ tenantScope, customer, projectId: "proj-job-4", ownerRef: "owner", state: "ACTIVE" });
    const job = createOutcomeJob({ tenantScope, customer, project, jobId: "job-4", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    persistWiredOutcomeJobs(jobStore, [job]);

    const projectSource = createDurableWorkProjectSource(projectStore);
    const jobSource = createDurableWorkJobSource(jobStore);

    const principal = createAuthenticatedStaffPrincipal({ principalId: "viewer-4", displayName: "Viewer 4" });
    const membership = createOrganizationMembership({ membershipId: "m-viewer-4", tenantScope, principalRef: principal.principalId, role: "STAFF" });
    const assignment = createAssignmentReference({ assignmentId: "assignment-4", membership, customerId: customer.customerId, projectId: project.projectId });
    const grant = {
      membership,
      authority: createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false }),
      assignments: [assignment],
    };
    const sessionToken = "token-viewer-4";
    const provider = createDevFixtureStaffSessionProvider({
      fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-01-01T00:00:00.000Z" }]]),
      isProduction: false,
    });
    const context = requireInternalOsAccess({ provider, sessionToken, organization, grants: [grant] });

    const workView = resolveWorkView({ context, projectSource, jobSource });
    assert.equal(workView.kind, "READY");
    if (workView.kind === "READY") {
      assert.equal(workView.projects.length, 1);
      assert.equal(workView.projects[0]?.jobs.kind, "READY");
      if (workView.projects[0]?.jobs.kind === "READY") {
        assert.equal(workView.projects[0].jobs.jobs.length, 1);
        assert.equal(workView.projects[0].jobs.jobs[0]?.jobId, "job-4");
      }
    }

    const detailView = resolveWorkProjectDetailView({
      organization,
      context,
      projectSource,
      jobSource,
      customerId: customer.customerId,
      projectId: project.projectId,
    });
    assert.equal(detailView.kind, "READY");
    if (detailView.kind === "READY") {
      assert.equal(detailView.project.jobs.kind, "READY");
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
