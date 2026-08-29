import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  createOutcomeJob,
  transitionOutcomeJob,
  enterExceptionState,
  InvalidExceptionStateEntryError,
  type OutcomeJob,
} from "../src/domain/outcome-job.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({
  tenantScope,
  customerId: "cust-1",
  displayName: "Acme Corp",
});
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

function draftJob(): OutcomeJob {
  return createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "Verify tenant isolation kernel end to end",
  });
}

function executingJob(): OutcomeJob {
  const draft = draftJob();
  const qualified = transitionOutcomeJob(draft, "QUALIFIED");
  const ready = transitionOutcomeJob(qualified, "READY");
  return transitionOutcomeJob(ready, "EXECUTING");
}

for (const to of ["BLOCKED", "RECOVERING", "ESCALATED", "STOPPED"] as const) {
  test(`T7: entering ${to} preserves the transition reason on the AuditEvent`, () => {
    const job = executingJob();
    const { job: updated, auditEvent } = enterExceptionState({
      job,
      to,
      eventId: `evt-${to}`,
      actorRef: "engineer:claude",
      timestamp: "2026-08-16T00:00:00.000Z",
      reason: `entering ${to} for a documented cause`,
    });
    assert.equal(updated.state, to);
    assert.equal(auditEvent.reason, `entering ${to} for a documented cause`);
    assert.equal(auditEvent.jobId, job.jobId);
    assert.equal(auditEvent.tenantId, job.tenantId);
    assert.equal(auditEvent.eventType, `EXCEPTION_STATE_ENTERED:${to}`);
  });
}

test("T7: rejects entry with a missing reason", () => {
  const job = executingJob();
  assert.throws(
    () =>
      enterExceptionState({
        job,
        to: "BLOCKED",
        eventId: "evt-1",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:00.000Z",
        reason: undefined,
      }),
    InvalidExceptionStateEntryError,
  );
});

test("T7: rejects entry with an empty-string reason", () => {
  const job = executingJob();
  assert.throws(
    () =>
      enterExceptionState({
        job,
        to: "BLOCKED",
        eventId: "evt-1",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:00.000Z",
        reason: "   ",
      }),
    InvalidExceptionStateEntryError,
  );
});

test("Finding 2: rejects a forged to: \"VERIFIED\", which would otherwise bypass the evidence gate", () => {
  const job = executingJob();
  assert.throws(
    () =>
      enterExceptionState({
        job,
        to: "VERIFIED",
        eventId: "evt-1",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:00.000Z",
        reason: "attempted forged transition",
      }),
    InvalidExceptionStateEntryError,
  );
});

test("Finding 2: rejects a forged to: \"CLOSED\"", () => {
  const job = executingJob();
  assert.throws(
    () =>
      enterExceptionState({
        job,
        to: "CLOSED",
        eventId: "evt-1",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:00.000Z",
        reason: "attempted forged transition",
      }),
    InvalidExceptionStateEntryError,
  );
});

test("Finding 2: rejects an arbitrary invalid to value", () => {
  const job = executingJob();
  assert.throws(
    () =>
      enterExceptionState({
        job,
        to: "NOT_A_REAL_STATE",
        eventId: "evt-1",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:00.000Z",
        reason: "attempted forged transition",
      }),
    InvalidExceptionStateEntryError,
  );
});

test("Finding 2: no job mutation occurs when to is invalid", () => {
  const job = executingJob();
  assert.throws(() =>
    enterExceptionState({
      job,
      to: "VERIFIED",
      eventId: "evt-1",
      actorRef: "engineer:claude",
      timestamp: "2026-08-16T00:00:00.000Z",
      reason: "attempted forged transition",
    }),
  );
  assert.equal(job.state, "EXECUTING");
});

test("a CLOSED job cannot enter an exception state", () => {
  let job = executingJob();
  job = transitionOutcomeJob(job, "VERIFYING");
  // Cannot reach CLOSED without a VERIFIED gate in this test file's
  // scope, so exercise the CLOSED precondition directly via a fixture.
  const closedJob: OutcomeJob = { ...job, state: "CLOSED" };
  assert.throws(
    () =>
      enterExceptionState({
        job: closedJob,
        to: "STOPPED",
        eventId: "evt-1",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:00.000Z",
        reason: "should not be reachable",
      }),
    InvalidExceptionStateEntryError,
  );
});

test("a job already in an exception state cannot re-enter one", () => {
  const job = executingJob();
  const { job: blocked } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-1",
    actorRef: "engineer:claude",
    timestamp: "2026-08-16T00:00:00.000Z",
    reason: "first entry",
  });
  assert.throws(
    () =>
      enterExceptionState({
        job: blocked,
        to: "ESCALATED",
        eventId: "evt-2",
        actorRef: "engineer:claude",
        timestamp: "2026-08-16T00:00:01.000Z",
        reason: "second entry attempt",
      }),
    InvalidExceptionStateEntryError,
  );
});
