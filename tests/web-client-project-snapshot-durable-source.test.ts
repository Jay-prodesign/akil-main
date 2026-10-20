import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, transitionOutcomeJob } from "../src/domain/outcome-job.js";
import { createAuditEvent } from "../src/domain/audit-event.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createAuthenticatedPrincipal, createSessionContext } from "../src/web/session-context.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableOutcomeJobStore, persistWiredOutcomeJobs } from "../src/domain/durable-outcome-job-store.js";
import { FileDurableAuditLog } from "../src/application/durable-audit-log.js";
import { createDurableClientProjectSnapshotSource } from "../src/web/client-project-snapshot-durable-source.js";
import { resolveProtectedSnapshotView } from "../src/web/snapshot-view-state.js";

/**
 * CLIENT-SNAPSHOT-DURABLE-001: proves `createDurableClientProjectSnapshotSource`
 * genuinely connects the long-standing `ClientProjectSnapshotSource` port to
 * the real `FileDurableProjectStore` + `FileDurableOutcomeJobStore`
 * (PROJ-DURABLE-001/WORK-JOB-SOURCE-001) - no longer only an abstract
 * single-record fixture - end to end through the real, unmodified
 * `resolveProtectedSnapshotView` resolver, and that a corrupted project
 * store degrades to a safe `undefined`/NOT_FOUND rather than crashing.
 *
 * AUDIT-DURABLE-001 (Brain continuation, PR #145 comment `6205619559`):
 * also proves the adapter's new `auditLog` wiring - the exact current
 * project's own real audit events reach `buildClientProjectSnapshot`'s
 * `timeline`, and a different project's/tenant's events in the SAME
 * tenant-wide `findByTenant` result are filtered out before ever reaching
 * `buildDeliveryTimeline` (which would otherwise fail closed on them).
 */

function freshProjectStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "client-snapshot-durable-001-projects-"));
}

function freshJobStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "client-snapshot-durable-001-jobs-"));
}

function freshAuditLogDir(): string {
  return mkdtempSync(join(tmpdir(), "client-snapshot-durable-001-audit-"));
}

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

test("createDurableClientProjectSnapshotSource surfaces a real snapshot composed from real durable project + jobs", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-1");
    const customer = createCustomer({ tenantScope, customerId: "customer-snapshot-1", displayName: "Snapshot Customer" });
    const project = createProject({ tenantScope, customer, projectId: "proj-snapshot-1", ownerRef: "owner", state: "ACTIVE" });
    const job = createOutcomeJob({ tenantScope, customer, project, jobId: "job-snapshot-1", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });
    const verifiedJob = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(job, "QUALIFIED"), "READY"), "EXECUTING");

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    persistWiredOutcomeJobs(jobStore, [job]);
    const auditLog = new FileDurableAuditLog(auditDir);

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
    const snapshot = source.getSnapshot(ownership);

    assert.ok(snapshot !== undefined);
    assert.deepEqual(snapshot?.ownership, ownership);
    assert.equal(snapshot?.nextAction.owner, "NO_ACTION_NEEDED");
    assert.deepEqual(snapshot?.eta, { status: "UNKNOWN" });
    assert.deepEqual(snapshot?.capabilities, []);
    assert.deepEqual(snapshot?.recentCommunications, []);
    assert.equal(snapshot?.workingArtifact, undefined);
    assert.deepEqual(snapshot?.timeline.entries, []);
    void verifiedJob;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("createDurableClientProjectSnapshotSource returns undefined for a nonexistent project (NOT_FOUND, never throwing)", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-2");
    const projectStore = new FileDurableProjectStore(projectDir);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    const auditLog = new FileDurableAuditLog(auditDir);
    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-ghost", projectId: "proj-ghost" });
    assert.equal(source.getSnapshot(ownership), undefined);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("createDurableClientProjectSnapshotSource never surfaces a different tenant's project", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantA = createTenantScope("tenant-snapshot-3a");
    const tenantB = createTenantScope("tenant-snapshot-3b");
    const customerA = createCustomer({ tenantScope: tenantA, customerId: "customer-3a", displayName: "Customer A" });
    const projectA = createProject({ tenantScope: tenantA, customer: customerA, projectId: "proj-3", ownerRef: "owner", state: "ACTIVE" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(projectA);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    const auditLog = new FileDurableAuditLog(auditDir);

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const foreignOwnership = createProjectOwnershipRef({ tenantId: tenantB.tenantId, customerId: customerA.customerId, projectId: projectA.projectId });
    assert.equal(source.getSnapshot(foreignOwnership), undefined);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("createDurableClientProjectSnapshotSource propagates a corrupted project-store read as a thrown error, never silently as undefined/NOT_FOUND", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-4");
    const customer = createCustomer({ tenantScope, customerId: "customer-snapshot-4", displayName: "Snapshot Customer 4" });
    const project = createProject({ tenantScope, customer, projectId: "proj-snapshot-4", ownerRef: "owner", state: "ACTIVE" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    writeFileSync(tenantFilePath(projectDir, tenantScope.tenantId), "{ not valid json garbage", "utf8");
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    const auditLog = new FileDurableAuditLog(auditDir);

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
    assert.throws(() => source.getSnapshot(ownership));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("end to end: resolveProtectedSnapshotView renders ERROR (never NOT_FOUND) for a genuinely corrupted durable project store", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-4b");
    const customer = createCustomer({ tenantScope, customerId: "customer-snapshot-4b", displayName: "Snapshot Customer 4b" });
    const project = createProject({ tenantScope, customer, projectId: "proj-snapshot-4b", ownerRef: "owner", state: "ACTIVE" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    writeFileSync(tenantFilePath(projectDir, tenantScope.tenantId), "{ not valid json garbage", "utf8");
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    const auditLog = new FileDurableAuditLog(auditDir);

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });

    const principal = createAuthenticatedPrincipal({
      principalId: "principal-snapshot-4b",
      tenantId: tenantScope.tenantId,
      customerId: customer.customerId,
      displayName: "Snapshot Viewer 4b",
    });
    const session = createSessionContext({ principal, projectId: project.projectId, issuedAt: "2026-01-01T00:00:00.000Z" });

    const view = resolveProtectedSnapshotView({ session, requestedOwnership: ownership, source });
    assert.equal(view.kind, "ERROR");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("end to end: resolveProtectedSnapshotView renders READY with a real durably-composed snapshot for a correctly-scoped session", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-5");
    const customer = createCustomer({ tenantScope, customerId: "customer-snapshot-5", displayName: "Snapshot Customer 5" });
    const project = createProject({ tenantScope, customer, projectId: "proj-snapshot-5", ownerRef: "owner", state: "ACTIVE" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    const auditLog = new FileDurableAuditLog(auditDir);

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });

    const principal = createAuthenticatedPrincipal({
      principalId: "principal-snapshot-5",
      tenantId: tenantScope.tenantId,
      customerId: customer.customerId,
      displayName: "Snapshot Viewer 5",
    });
    const session = createSessionContext({ principal, projectId: project.projectId, issuedAt: "2026-01-01T00:00:00.000Z" });

    const view = resolveProtectedSnapshotView({ session, requestedOwnership: ownership, source });
    assert.equal(view.kind, "READY");
    if (view.kind === "READY") {
      assert.deepEqual(view.snapshot.ownership, ownership);
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("AUDIT-DURABLE-001: a real durable audit event for the exact current project reaches the snapshot's own delivery timeline", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-6");
    const customer = createCustomer({ tenantScope, customerId: "customer-snapshot-6", displayName: "Snapshot Customer 6" });
    const project = createProject({ tenantScope, customer, projectId: "proj-snapshot-6", ownerRef: "owner", state: "ACTIVE" });
    const job = createOutcomeJob({ tenantScope, customer, project, jobId: "job-snapshot-6", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    persistWiredOutcomeJobs(jobStore, [job]);
    const auditLog = new FileDurableAuditLog(auditDir);
    auditLog.append(
      createAuditEvent({
        job,
        eventId: "evt-snapshot-6-1",
        actorRef: "engineer:claude",
        eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
        timestamp: "2026-10-16T00:00:00.000Z",
      }),
    );

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
    const snapshot = source.getSnapshot(ownership);

    assert.ok(snapshot !== undefined);
    assert.equal(snapshot?.timeline.entries.length, 1);
    assert.equal(snapshot?.timeline.entries[0]?.eventId, "evt-snapshot-6-1");
    assert.equal(snapshot?.timeline.entries[0]?.category, "BLOCKER");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("AUDIT-DURABLE-001: a DIFFERENT project's audit event in the same tenant-wide findByTenant result is filtered out, never leaking into this project's timeline", () => {
  const projectDir = freshProjectStoreDir();
  const jobDir = freshJobStoreDir();
  const auditDir = freshAuditLogDir();
  try {
    const tenantScope = createTenantScope("tenant-snapshot-7");
    const customer = createCustomer({ tenantScope, customerId: "customer-snapshot-7", displayName: "Snapshot Customer 7" });
    const project = createProject({ tenantScope, customer, projectId: "proj-snapshot-7", ownerRef: "owner", state: "ACTIVE" });
    const otherProject = createProject({ tenantScope, customer, projectId: "proj-snapshot-7-other", ownerRef: "owner", state: "ACTIVE" });
    const job = createOutcomeJob({ tenantScope, customer, project, jobId: "job-snapshot-7", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });
    const otherJob = createOutcomeJob({ tenantScope, customer, project: otherProject, jobId: "job-snapshot-7-other", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" });

    const projectStore = new FileDurableProjectStore(projectDir);
    projectStore.create(project);
    projectStore.create(otherProject);
    const jobStore = new FileDurableOutcomeJobStore(jobDir);
    persistWiredOutcomeJobs(jobStore, [job]);
    persistWiredOutcomeJobs(jobStore, [otherJob]);
    const auditLog = new FileDurableAuditLog(auditDir);
    auditLog.append(
      createAuditEvent({
        job: otherJob,
        eventId: "evt-snapshot-7-other-1",
        actorRef: "engineer:claude",
        eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
        timestamp: "2026-10-16T00:00:00.000Z",
      }),
    );

    const source = createDurableClientProjectSnapshotSource(projectStore, jobStore, auditLog);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
    const snapshot = source.getSnapshot(ownership);

    assert.ok(snapshot !== undefined);
    assert.deepEqual(snapshot?.timeline.entries, []);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});
