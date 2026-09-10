import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  CorruptedOutcomeJobLineError,
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
// directly at the exact path the store itself arbitrates on.
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

test("AUD-DURABILITY-GAP: a corrupted (malformed JSON) persisted outcome-job line fails closed with CorruptedOutcomeJobLineError", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    appendFileSync(filePathFor(dir, fixture.tenantScope.tenantId), "{not valid json\n", "utf8");
    assert.throws(() => store.list(fixture.tenantScope.tenantId, fixture.project.projectId), (error: unknown) => {
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
    assert.throws(() => store.list(fixture.tenantScope.tenantId, fixture.project.projectId), (error: unknown) => {
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

test("AUD-DURABILITY-GAP Rev74 F2 correction: putIfAbsent race-honesty - if another writer's creation LOCK for the same jobId already exists (the jsonl file does not yet even reflect it), this call reports created:false and returns the lock-holder's content, exercising the real post-lock-attempt arbitration path rather than the pre-populated-jsonl fast path", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;

    // Simulate the real race directly at the lock layer, not the jsonl
    // layer: another writer's linkSync already won for this exact jobId
    // (its lock file exists), but its own appendFileSync to the jsonl file
    // has not necessarily happened yet - this call's own absence-check
    // (get(), which only reads the jsonl file) therefore still returns
    // undefined, forcing execution into the real linkSync-attempt/EEXIST
    // arbitration branch instead of the early "already exists in jsonl"
    // fast path a naive pre-populated-file test would exercise instead.
    const lockPath = creationLockPathFor(dir, job.tenantId, job.jobId);
    mkdirSync(join(dir, ".creation-locks"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(job), "utf8");

    const result = store.putIfAbsent(job);
    assert.equal(result.created, false);
    assert.deepEqual(result.job, job);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUD-DURABILITY-GAP Rev74 F1 correction: putIfAbsent correctly reports created:false for a losing writer even when its submitted payload is byte-identical to the true winner's - creation is arbitrated by the OS-atomic lock, never by content comparison", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;

    // The exact case the original TOCTOU fix could not distinguish: another
    // writer's lock already exists, and the content this call submits is
    // byte-identical to the lock-holder's content (JSON.stringify equal).
    // A comparison-based re-verification cannot tell "I am the winner" from
    // "someone else already created an identical record" here - the lock
    // itself must be the sole arbiter.
    const lockPath = creationLockPathFor(dir, job.tenantId, job.jobId);
    mkdirSync(join(dir, ".creation-locks"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(job), "utf8");

    // A structurally distinct (but content-identical) job object, proving
    // this isn't a reference-equality shortcut either.
    const identicalPayloadJob = JSON.parse(JSON.stringify(job)) as typeof job;
    assert.notEqual(identicalPayloadJob, job);
    assert.deepEqual(identicalPayloadJob, job);

    const result = store.putIfAbsent(identicalPayloadJob);
    assert.equal(result.created, false);
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
