import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
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
  CorruptedOutcomeJobLineError,
  CorruptedOutcomeJobLockError,
  persistWiredOutcomeJobs,
} from "../src/domain/durable-outcome-job-store.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "del-003-outcome-job-store-"));
}

// Mirrors FileDurableOutcomeJobStore's own (private) filePathFor encoding,
// so these adversarial tests can inject a raw corrupted/forged line
// directly into the exact file the store itself reads on replay.
function filePathFor(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.jsonl`);
}

// Mirrors FileDurableOutcomeJobStore's own (private) creationLockPathFor
// encoding, so adversarial tests can inject a raw creation-lock file
// directly at the exact path the store itself arbitrates on and
// reconciles from.
function creationLockPathFor(dir: string, tenantId: string, jobId: string): string {
  const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
  const jobKey = Buffer.from(jobId, "utf8").toString("base64url");
  return join(dir, ".creation-locks", `${tenantKey}.${jobKey}.lock`);
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

    const listed = storeA.list(
      fixture.tenantScope.tenantId,
      fixture.customer.customerId,
      fixture.project.projectId,
    );
    assert.equal(listed.length, jobs.length);
    assert.equal(new Set(listed.map((j) => j.jobId)).size, jobs.length);

    // Restart: a brand-new store instance over the same directory sees the
    // exact same de-duplicated job set - no in-memory index to diverge
    // from disk.
    const storeB = new FileDurableOutcomeJobStore(dir);
    const listedAfterRestart = storeB.list(
      fixture.tenantScope.tenantId,
      fixture.customer.customerId,
      fixture.project.projectId,
    );
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

test("CXP-001G (adversarial): claiming an already-persisted jobId under a different customer, same tenant AND same projectId string, fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    // Deliberately reuses the SAME projectId string from a different
    // customer within the same tenant, so this case is caught ONLY by a
    // customerId check - a tenantId or projectId check alone would not
    // distinguish it (project.ts does not enforce projectId global
    // uniqueness across customers).
    const otherCustomer = createCustomer({
      tenantScope: fixture.tenantScope,
      customerId: "cust-job-store-other-same-tenant",
      displayName: "Other Customer, Same Tenant",
    });
    const sameProjectIdOtherCustomerProject = createProject({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      projectId: job.projectId,
      ownerRef: "owner-job-store-other-customer",
      state: "active",
    });
    const conflictingJob = createOutcomeJob({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      project: sameProjectIdOtherCustomerProject,
      jobId: job.jobId,
      jobFamily: job.jobFamily,
      businessObjective: job.businessObjective,
    });

    assert.throws(() => store.putIfAbsent(conflictingJob), InvalidDurableOutcomeJobStoreError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CXP-001G (adversarial): list() does not leak a job to a different customer sharing the same tenantId and projectId string", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    const otherCustomer = createCustomer({
      tenantScope: fixture.tenantScope,
      customerId: "cust-job-store-list-isolation",
      displayName: "Other Customer, List Isolation",
    });
    const listedForOtherCustomer = store.list(job.tenantId, otherCustomer.customerId, job.projectId);
    assert.equal(listedForOtherCustomer.length, 0);

    const listedForOwningCustomer = store.list(job.tenantId, job.customerId, job.projectId);
    assert.equal(listedForOwningCustomer.length, 1);
    assert.deepEqual(listedForOwningCustomer[0], job);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUD-DURABILITY-GAP: a corrupted (malformed JSON) persisted outcome-job line fails closed with CorruptedOutcomeJobLineError", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    appendFileSync(filePathFor(dir, fixture.tenantScope.tenantId), "{not valid json\n", "utf8");
    assert.throws(() => store.list(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId), (error: unknown) => {
      if (!(error instanceof CorruptedOutcomeJobLineError)) {
        return false;
      }
      assert.match(error.message, /:2\)/);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUD-DURABILITY-GAP: a forged line with an invalid OutcomeJobState fails closed with CorruptedOutcomeJobLineError", () => {
  const dir = freshStoreDir();
  try {
    const { fixture } = admittedWiredJobs();
    const store = new FileDurableOutcomeJobStore(dir);
    appendFileSync(
      filePathFor(dir, fixture.tenantScope.tenantId),
      `${JSON.stringify({
        tenantId: fixture.tenantScope.tenantId,
        customerId: fixture.customer.customerId,
        projectId: fixture.project.projectId,
        jobId: "forged-job-1",
        jobFamily: "some-family",
        businessObjective: "some-objective",
        state: "NOT_A_REAL_STATE",
      })}\n`,
      "utf8",
    );
    assert.throws(() => store.list(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId), (error: unknown) => {
      if (!(error instanceof CorruptedOutcomeJobLineError)) {
        return false;
      }
      assert.match(error.message, /:1\)/);
      assert.match(error.message, /state must be one of/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rev68 F1 crash-recovery witness: a creation lock left behind by a process killed after linkSync but before its jsonl append is self-healed - get()/list()/putIfAbsent() all converge to exactly one durable visible job, with no duplicate creation", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;

    // Simulate the exact crash window: the winning writer's linkSync
    // succeeded (the lock exists, with the true job content) but its
    // appendFileSync to the jsonl file never ran - the jsonl file for
    // this tenant does not exist at all yet.
    const lockPath = creationLockPathFor(dir, job.tenantId, job.jobId);
    mkdirSync(join(dir, ".creation-locks"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(job), "utf8");

    // get() must heal the orphaned lock into the jsonl file and return it.
    const gotten = store.get(job.tenantId, job.jobId);
    assert.deepEqual(gotten, job);

    // Healing must actually be durable, not merely returned in-memory: a
    // second, independent store instance over the same baseDir sees it
    // too, with no in-memory index to diverge from disk.
    const restarted = new FileDurableOutcomeJobStore(dir);
    const listed = restarted.list(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], job);

    // A subsequent putIfAbsent for the same jobId (the crashed writer
    // retrying, or an entirely different caller) must not create a
    // duplicate - it must resolve to the already-healed job.
    const result = store.putIfAbsent(job);
    assert.equal(result.created, false);
    assert.deepEqual(result.job, job);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rev68 F1 corrupted-lock fail-closed proof: a creation lock containing malformed JSON, or a structurally invalid OutcomeJob, is corruption, not an ordinary crash artifact - reads fail closed with CorruptedOutcomeJobLockError instead of silently skipping or healing it", () => {
  const malformedJsonDir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(malformedJsonDir);
    const tenantId = createTenantScope("tenant-lock-corruption").tenantId;
    const lockPath = creationLockPathFor(malformedJsonDir, tenantId, "job-corrupt-lock-1");
    mkdirSync(join(malformedJsonDir, ".creation-locks"), { recursive: true });
    writeFileSync(lockPath, "{not valid json", "utf8");

    assert.throws(() => store.get(tenantId, "job-corrupt-lock-1" as never), (error: unknown) => {
      if (!(error instanceof CorruptedOutcomeJobLockError)) {
        return false;
      }
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  } finally {
    rmSync(malformedJsonDir, { recursive: true, force: true });
  }

  const invalidShapeDir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(invalidShapeDir);
    const tenantId = createTenantScope("tenant-lock-corruption-2").tenantId;
    const lockPath = creationLockPathFor(invalidShapeDir, tenantId, "job-corrupt-lock-2");
    mkdirSync(join(invalidShapeDir, ".creation-locks"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        tenantId,
        customerId: "customer-lock-corruption-2",
        projectId: "project-lock-corruption-2",
        jobId: "job-corrupt-lock-2",
        jobFamily: "family",
        businessObjective: "objective",
        state: "NOT_A_REAL_STATE",
      }),
      "utf8",
    );

    assert.throws(() => store.get(tenantId, "job-corrupt-lock-2" as never), (error: unknown) => {
      if (!(error instanceof CorruptedOutcomeJobLockError)) {
        return false;
      }
      assert.match(error.message, /state must be one of/);
      return true;
    });
  } finally {
    rmSync(invalidShapeDir, { recursive: true, force: true });
  }
});

test("Rev68 F2 cross-customer lock-winner witness: a losing writer whose jobId collides with a different customer's already-locked (but not yet jsonl-durable) job fails closed instead of silently accepting the wrong customer's job as its own", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const winnerJob = jobs[0]!;

    // Simulate the real race directly at the lock layer: another writer's
    // linkSync already won for this exact jobId (its lock file exists),
    // but its own appendFileSync to the jsonl file has not necessarily
    // happened yet - this call's own absence-check (get(), reconciled)
    // will actually find and heal it, so the conflict check below is
    // exercised via the top-of-function "existing" branch, proving the
    // same tenantId+customerId+projectId tuple check applies uniformly
    // whether the conflicting record was reached via jsonl or via a
    // healed lock.
    const lockPath = creationLockPathFor(dir, winnerJob.tenantId, winnerJob.jobId);
    mkdirSync(join(dir, ".creation-locks"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(winnerJob), "utf8");

    const otherCustomer = createCustomer({
      tenantScope: fixture.tenantScope,
      customerId: "cust-outcome-job-lock-race-other",
      displayName: "Other Customer, Lock Race",
    });
    const sameProjectIdOtherCustomerProject = createProject({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      projectId: winnerJob.projectId,
      ownerRef: "owner-outcome-job-lock-race-other",
      state: "active",
    });
    const conflictingJob = createOutcomeJob({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      project: sameProjectIdOtherCustomerProject,
      jobId: winnerJob.jobId,
      jobFamily: winnerJob.jobFamily,
      businessObjective: winnerJob.businessObjective,
    });

    assert.throws(() => store.putIfAbsent(conflictingJob), (error: unknown) => {
      if (!(error instanceof InvalidDurableOutcomeJobStoreError)) {
        return false;
      }
      // Pins the specific rejection reason (not merely the error class),
      // so this test cannot pass for the wrong reason (e.g. an unrelated
      // "lock exists but could not be resolved" internal-error guard).
      assert.match(error.message, /different tenant\/customer\/project/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

