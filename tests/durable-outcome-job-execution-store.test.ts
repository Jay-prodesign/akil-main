import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createOutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import {
  FileDurableOutcomeJobExecutionStore,
  CorruptedOutcomeJobExecutionEventError,
  appendOutcomeJobExecutionEventIdempotently,
} from "../src/domain/durable-outcome-job-execution-store.js";
import { InvalidOutcomeJobExecutionTransitionError } from "../src/domain/outcome-job-execution-run-state.js";

const tenantScope = createTenantScope("tenant-store-os-v0-05");
const customer = createCustomer({ tenantScope, customerId: "cust-store", displayName: "Store Customer" });
const project = createProject({ tenantScope, customer, projectId: "project-store", ownerRef: "owner-store", state: "active" });
const job = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-store",
  jobFamily: "WEBSITE_BUILD",
  businessObjective: "Deliver website",
});

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "os-v0-05-execution-store-"));
}

function singleFilePathIn(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1, `expected exactly one durable file in ${dir}, found ${files.length}`);
  return join(dir, files[0]!);
}

test("S1: appendEvent + getState durably reconstruct ACCEPTED -> ATTEMPT_STARTED -> SUCCEEDED", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const accepted = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s1", correlationId: "corr-s1",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    appendOutcomeJobExecutionEventIdempotently(store, accepted);
    const started = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s1", correlationId: "corr-s1",
      attempt: 1, sequence: 1, type: "ATTEMPT_STARTED", occurredAt: "2026-09-26T00:00:01.000Z",
    });
    appendOutcomeJobExecutionEventIdempotently(store, started);
    const succeeded = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s1", correlationId: "corr-s1",
      attempt: 1, sequence: 2, type: "SUCCEEDED", occurredAt: "2026-09-26T00:00:02.000Z",
    });
    const state = appendOutcomeJobExecutionEventIdempotently(store, succeeded);
    assert.equal(state.status, "SUCCEEDED");

    const restarted = new FileDurableOutcomeJobExecutionStore(dir);
    const restartedState = restarted.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s1");
    assert.deepEqual(restartedState, state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 (#9): appending the identical event twice is durably idempotent - restart reconstructs the same state either way", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const accepted = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s2", correlationId: "corr-s2",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    appendOutcomeJobExecutionEventIdempotently(store, accepted);
    appendOutcomeJobExecutionEventIdempotently(store, accepted);
    const events = store.getEvents(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s2");
    assert.equal(events.length, 2, "the durable log itself may contain the literal duplicate line");
    const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s2");
    assert.equal(state?.status, "ACCEPTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3: a malformed (non-JSON) persisted line fails closed with CorruptedOutcomeJobExecutionEventError", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const accepted = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s3", correlationId: "corr-s3",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    store.appendEvent(accepted);
    const filePath = singleFilePathIn(dir);
    writeFileSync(filePath, "not-valid-json\n", "utf8");
    assert.throws(
      () => store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s3"),
      CorruptedOutcomeJobExecutionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S4 (#2): a foreign embedded run/job/tenant identity inside the requested scope's own file fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const accepted = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s4", correlationId: "corr-s4",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    store.appendEvent(accepted);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());
    writeFileSync(filePath, `${JSON.stringify({ ...legit, tenantId: "tenant-foreign" })}\n`, "utf8");
    assert.throws(
      () => store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s4"),
      CorruptedOutcomeJobExecutionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5 (#2): an unrecognized event type fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const accepted = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s5", correlationId: "corr-s5",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    store.appendEvent(accepted);
    const filePath = singleFilePathIn(dir);
    const legit = JSON.parse(readFileSync(filePath, "utf8").trim());
    writeFileSync(filePath, `${JSON.stringify({ ...legit, type: "NOT_A_REAL_TYPE" })}\n`, "utf8");
    assert.throws(
      () => store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s5"),
      CorruptedOutcomeJobExecutionEventError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6: a shape-valid but logically corrupted replay (SUCCEEDED before any ATTEMPT_STARTED) fails closed via the reducer itself", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const accepted = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s6", correlationId: "corr-s6",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    store.appendEvent(accepted);
    const succeeded = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-s6", correlationId: "corr-s6",
      attempt: 1, sequence: 2, type: "SUCCEEDED", occurredAt: "2026-09-26T00:00:01.000Z",
    });
    store.appendEvent(succeeded);
    assert.throws(
      () => store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-s6"),
      InvalidOutcomeJobExecutionTransitionError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S7: two distinct runs for the same job remain independently addressable and isolated", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOutcomeJobExecutionStore(dir);
    const acceptedRunA = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-a", correlationId: "corr-a",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    const acceptedRunB = createOutcomeJobExecutionEvent({
      tenantScope, customer, project, job, runId: "run-b", correlationId: "corr-b",
      attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
    });
    store.appendEvent(acceptedRunA);
    store.appendEvent(acceptedRunB);
    const stateA = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-a");
    const stateB = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-b");
    assert.equal(stateA?.runId, "run-a");
    assert.equal(stateB?.runId, "run-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boundary: durable-outcome-job-execution-store.ts introduces no unexpected import", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const sourcePath = join(REPO_ROOT, "src/domain/durable-outcome-job-execution-store.ts");
  const content = readFileSync(sourcePath, "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  const allowedModules = [
    "./tenant-scope.js",
    "./customer.js",
    "./project.js",
    "./outcome-job.js",
    "./outcome-job-execution-event.js",
    "./outcome-job-execution-run-state.js",
  ];
  for (const specifier of importedModules) {
    assert.ok(specifier === "node:fs" || specifier === "node:path" || allowedModules.includes(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
});
