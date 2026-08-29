import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../src/domain/project.js";
import { compilePlan } from "../src/domain/project-plan.js";
import { deriveOutcomeJobSpecs } from "../src/domain/outcome-job-spec.js";
import { createApprovalReference } from "../src/domain/approval-reference.js";
import { admitPlan, admitJobs } from "../src/domain/plan-admission.js";
import { wireAdmittedOutcomeJobs } from "../src/domain/outcome-job-wiring.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import {
  FileDurableOutcomeJobStore,
  InvalidDurableOutcomeJobStoreError,
  persistWiredOutcomeJobs,
} from "../src/domain/durable-outcome-job-store.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "del-003-outcome-job-store-"));
}

function admittedWiredJobs() {
  const fixture = buildWebsiteBuildV1Fixture();
  const plan = compilePlan({
    tenantScope: fixture.tenantScope,
    project: fixture.project,
    planId: "plan-durable-job-store",
    blueprint: fixture.blueprint,
    soldScope: fixture.soldScope,
    evidence: fixture.evidence,
    now: "2026-08-19T00:00:00.000Z",
  });
  const approval = createApprovalReference({
    plan,
    approvalId: "approval-durable-job-store",
    approvedAt: "2026-08-19T00:00:00.000Z",
    approverRef: "owner:founder",
  });
  const planAdmission = admitPlan({
    plan,
    blueprint: fixture.blueprint,
    readinessAssertions: buildFullReadinessAssertions(fixture.tenantScope, fixture.project, plan),
    approval,
  });
  assert.equal(planAdmission.status, "ADMITTED");
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);
  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    planAdmission,
    jobAdmissions,
    specs,
  });
  return { fixture, jobs };
}

test("F3: putIfAbsent persists a new job exactly once; replaying the same jobId is a no-op that returns the original job", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;

    const first = store.putIfAbsent(job);
    assert.equal(first.created, true);
    assert.deepEqual(first.job, job);

    const second = store.putIfAbsent(job);
    assert.equal(second.created, false);
    assert.deepEqual(second.job, job);

    assert.deepEqual(store.get(job.tenantId, job.jobId), job);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3: persisting a full replayed wiring pass twice creates each job exactly once, and a restart reconstructs the identical deduplicated set", () => {
  const dir = freshStoreDir();
  try {
    const { fixture, jobs } = admittedWiredJobs();
    const storeA = new FileDurableOutcomeJobStore(dir);

    const firstPass = persistWiredOutcomeJobs(storeA, jobs);
    assert.equal(firstPass.created.length, jobs.length);
    assert.equal(firstPass.alreadyPersisted.length, 0);

    // Replay: the exact same wired jobs persisted again (a retried resume,
    // or a restart re-running wireAdmittedOutcomeJobs over the same
    // admitted specs) must create nothing new.
    const secondPass = persistWiredOutcomeJobs(storeA, jobs);
    assert.equal(secondPass.created.length, 0);
    assert.equal(secondPass.alreadyPersisted.length, jobs.length);

    const listed = storeA.list(fixture.tenantScope.tenantId, fixture.project.projectId);
    assert.equal(listed.length, jobs.length);
    assert.equal(new Set(listed.map((j) => j.jobId)).size, jobs.length);

    // Restart: a brand-new store instance over the same directory sees the
    // exact same de-duplicated job set - no in-memory index to diverge
    // from disk.
    const storeB = new FileDurableOutcomeJobStore(dir);
    const listedAfterRestart = storeB.list(fixture.tenantScope.tenantId, fixture.project.projectId);
    assert.equal(listedAfterRestart.length, jobs.length);
    assert.deepEqual(
      [...listedAfterRestart].sort((a, b) => a.jobId.localeCompare(b.jobId)),
      [...listed].sort((a, b) => a.jobId.localeCompare(b.jobId)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3: claiming an already-persisted jobId under a different project (same tenant) fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    const otherProject = createProject({
      tenantScope: fixture.tenantScope,
      customer: fixture.customer,
      projectId: "proj-job-store-other-same-tenant",
      ownerRef: "owner-job-store-other",
      state: "active",
    });
    const conflictingJob = createOutcomeJob({
      tenantScope: fixture.tenantScope,
      customer: fixture.customer,
      project: otherProject,
      jobId: job.jobId,
      jobFamily: job.jobFamily,
      businessObjective: job.businessObjective,
    });

    assert.throws(() => store.putIfAbsent(conflictingJob), InvalidDurableOutcomeJobStoreError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
