import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  persistWiredOutcomeJobs,
} from "../src/domain/durable-outcome-job-store.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { buildFullReadinessAssertions } from "./helpers/readiness-fixture.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "del-003-outcome-job-store-"));
}

function singleFilePathIn(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1, `expected exactly one durable file in ${dir}, found ${files.length}`);
  return join(dir, files[0]!);
}

function overwriteFileWithSingleLine(filePath: string, record: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
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

// ---------------------------------------------------------------------------
// OS-V0-03 Phase B: fail-closed persisted-line replay validation
// ---------------------------------------------------------------------------

test("OS-V0-03 B2: a malformed (non-JSON) persisted line fails closed with CorruptedOutcomeJobLineError", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    const filePath = singleFilePathIn(dir);
    writeFileSync(filePath, "not-valid-json-at-all\n", "utf8");

    assert.throws(() => store.get(job.tenantId, job.jobId), CorruptedOutcomeJobLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B3: a non-object/array persisted shape fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);
    const filePath = singleFilePathIn(dir);

    overwriteFileWithSingleLine(filePath, "just-a-string");
    assert.throws(() => store.get(job.tenantId, job.jobId), CorruptedOutcomeJobLineError);

    overwriteFileWithSingleLine(filePath, [1, 2, 3]);
    assert.throws(() => store.get(job.tenantId, job.jobId), CorruptedOutcomeJobLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B4: a foreign embedded tenantId inside the requested tenant's own file fails closed on get", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());

    overwriteFileWithSingleLine(filePath, { ...legit, tenantId: "tenant-os-v0-03-b4-foreign" });

    assert.throws(() => store.get(job.tenantId, job.jobId), CorruptedOutcomeJobLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B5: the same foreign-tenant contamination fails closed on list, and no partial result is ever returned", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());

    overwriteFileWithSingleLine(filePath, { ...legit, tenantId: "tenant-os-v0-03-b5-foreign" });

    let thrown = false;
    try {
      store.list(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId);
    } catch (cause) {
      thrown = true;
      assert.ok(cause instanceof CorruptedOutcomeJobLineError);
    }
    assert.equal(thrown, true, "list() must throw rather than return an empty or partial result over a corrupted file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B6: empty/whitespace/malformed required identity/content fields fail closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());
    const getJob = () => store.get(job.tenantId, job.jobId);

    overwriteFileWithSingleLine(filePath, { ...legit, customerId: "" });
    assert.throws(getJob, CorruptedOutcomeJobLineError, "empty customerId must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legit, projectId: "   " });
    assert.throws(getJob, CorruptedOutcomeJobLineError, "whitespace-only projectId must be rejected");

    overwriteFileWithSingleLine(filePath, { ...legit, jobFamily: 42 });
    assert.throws(getJob, CorruptedOutcomeJobLineError, "non-string jobFamily must be rejected");

    const { businessObjective: _omitted, ...withoutBusinessObjective } = legit;
    overwriteFileWithSingleLine(filePath, withoutBusinessObjective);
    assert.throws(getJob, CorruptedOutcomeJobLineError, "missing businessObjective must be rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B7: an unrecognized OutcomeJobState fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());

    overwriteFileWithSingleLine(filePath, { ...legit, state: "NOT_A_REAL_STATE" });

    assert.throws(() => store.get(job.tenantId, job.jobId), CorruptedOutcomeJobLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B8: putIfAbsent against a corrupted tenant file fails closed without appending a new record", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());
    overwriteFileWithSingleLine(filePath, { ...legit, state: "NOT_A_REAL_STATE" });
    const corruptedContent = readFileSync(filePath, "utf8");

    const otherJob = createOutcomeJob({
      tenantScope: fixture.tenantScope,
      customer: fixture.customer,
      project: fixture.project,
      jobId: "job-os-v0-03-b8-other",
      jobFamily: job.jobFamily,
      businessObjective: job.businessObjective,
    });
    assert.throws(() => store.putIfAbsent(otherJob), CorruptedOutcomeJobLineError);

    // The corrupted file must be left exactly as it was - putIfAbsent must
    // never append/rewrite through a corruption it cannot safely interpret.
    assert.equal(readFileSync(filePath, "utf8"), corruptedContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B9: valid same-tenant jobs from different customers/projects remain independently listable under their exact customer/project filters", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    const otherCustomer = createCustomer({
      tenantScope: fixture.tenantScope,
      customerId: "cust-os-v0-03-b9-other",
      displayName: "OS-V0-03 B9 Other Customer",
    });
    const otherProject = createProject({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      projectId: "project-os-v0-03-b9-other",
      ownerRef: "owner-os-v0-03-b9",
      state: "active",
    });
    const otherJob = createOutcomeJob({
      tenantScope: fixture.tenantScope,
      customer: otherCustomer,
      project: otherProject,
      jobId: "job-os-v0-03-b9-other",
      jobFamily: job.jobFamily,
      businessObjective: job.businessObjective,
    });
    store.putIfAbsent(otherJob);

    const listedOriginal = store.list(fixture.tenantScope.tenantId, fixture.customer.customerId, fixture.project.projectId);
    const listedOther = store.list(fixture.tenantScope.tenantId, otherCustomer.customerId, otherProject.projectId);
    assert.equal(listedOriginal.length, 1);
    assert.deepEqual(listedOriginal[0], job);
    assert.equal(listedOther.length, 1);
    assert.deepEqual(listedOther[0], otherJob);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B10: the same jobId string reused under a different tenant remains independent because it resides in another tenant's own file", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobStore(dir);
    const { fixture, jobs } = admittedWiredJobs();
    const job = jobs[0]!;
    store.putIfAbsent(job);

    const otherTenantScope = createTenantScope("tenant-os-v0-03-b10-other");
    const otherCustomer = createCustomer({
      tenantScope: otherTenantScope,
      customerId: "cust-os-v0-03-b10-other",
      displayName: "OS-V0-03 B10 Other Tenant Customer",
    });
    const otherProject = createProject({
      tenantScope: otherTenantScope,
      customer: otherCustomer,
      projectId: "project-os-v0-03-b10-other",
      ownerRef: "owner-os-v0-03-b10",
      state: "active",
    });
    const sameJobIdOtherTenantJob = createOutcomeJob({
      tenantScope: otherTenantScope,
      customer: otherCustomer,
      project: otherProject,
      jobId: job.jobId,
      jobFamily: job.jobFamily,
      businessObjective: job.businessObjective,
    });
    const result = store.putIfAbsent(sameJobIdOtherTenantJob);
    assert.equal(result.created, true);

    assert.deepEqual(store.get(fixture.tenantScope.tenantId, job.jobId), job);
    assert.deepEqual(store.get(otherTenantScope.tenantId, job.jobId), sameJobIdOtherTenantJob);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OS-V0-03 B13: boundary - durable-outcome-job-store.ts introduces no new import/dependency", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const sourcePath = join(REPO_ROOT, "src/domain/durable-outcome-job-store.ts");
  const content = readFileSync(sourcePath, "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  const allowedModules = ["./tenant-scope.js", "./outcome-job.js"];
  for (const specifier of importedModules) {
    assert.ok(specifier === "node:fs" || specifier === "node:path" || allowedModules.includes(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  for (const forbidden of ["postgres-outcome-job-store.js", "durable-plan-admission-store.js", "durable-engineering-store.js"]) {
    assert.equal(content.includes(forbidden), false, `must not import "${forbidden}"`);
  }
});
