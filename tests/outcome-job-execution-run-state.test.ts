import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, type OutcomeJob } from "../src/domain/outcome-job.js";
import {
  createOutcomeJobExecutionEvent,
  deriveOutcomeJobExecutionEventId,
  type OutcomeJobExecutionEvent,
} from "../src/domain/outcome-job-execution-event.js";
import {
  applyOutcomeJobExecutionEvent,
  reconstructOutcomeJobExecutionRunState,
  InvalidOutcomeJobExecutionTransitionError,
} from "../src/domain/outcome-job-execution-run-state.js";

const tenantScope = createTenantScope("tenant-os-v0-05");
const customer = createCustomer({ tenantScope, customerId: "cust-os-v0-05", displayName: "OS-V0-05 Customer" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-os-v0-05",
  ownerRef: "owner-os-v0-05",
  state: "active",
});
const job: OutcomeJob = createOutcomeJob({
  tenantScope,
  customer,
  project,
  jobId: "job-os-v0-05",
  jobFamily: "WEBSITE_BUILD",
  businessObjective: "Deliver website",
});

function ev(overrides: Partial<Parameters<typeof createOutcomeJobExecutionEvent>[0]> = {}): OutcomeJobExecutionEvent {
  return createOutcomeJobExecutionEvent({
    tenantScope,
    customer,
    project,
    job,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
    occurredAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  });
}

test("EV1: deriveOutcomeJobExecutionEventId is injective over the identity tuple, including type and correlationId - ACCEPTED and ATTEMPT_STARTED at the same (attempt, sequence) coordinate never collide, and neither do two distinct correlationIds", () => {
  const idA = deriveOutcomeJobExecutionEventId({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 2,
    type: "ACCEPTED",
  });
  const idB = deriveOutcomeJobExecutionEventId({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 2,
    type: "FAILED",
  });
  assert.notEqual(idA, idB);

  const idC = deriveOutcomeJobExecutionEventId({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
  });
  const idD = deriveOutcomeJobExecutionEventId({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ATTEMPT_STARTED",
  });
  assert.notEqual(idC, idD, "ACCEPTED and ATTEMPT_STARTED share the same (attempt, sequence) coordinate by convention and must not collide");

  // Rev146 F5: two events sharing every other coordinate but differing
  // ONLY in correlationId must derive distinct eventIds - otherwise the
  // store's own eventId-based dedupe (Rev145 F1) could silently swallow a
  // genuine correlationId mismatch before the reducer's own identity check
  // ever runs.
  const idE = deriveOutcomeJobExecutionEventId({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
  });
  const idF = deriveOutcomeJobExecutionEventId({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: job.jobId,
    runId: "run-1",
    correlationId: "corr-2-different",
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
  });
  assert.notEqual(idE, idF, "two distinct correlationIds must never derive the same eventId");
});

test("R1 (#1): a run's first event must be ACCEPTED at attempt 1 sequence 1, and events target the same run without identifier collision", () => {
  const accepted = ev();
  const state = applyOutcomeJobExecutionEvent(undefined, accepted);
  assert.equal(state.status, "ACCEPTED");
  assert.equal(state.currentAttempt, 0);

  assert.throws(
    () => applyOutcomeJobExecutionEvent(undefined, ev({ type: "PROGRESS", sequence: 1 } as never)),
    InvalidOutcomeJobExecutionTransitionError,
  );
});

test("R2 (#2, #15): a foreign tenant/customer/project/job/run substitution on the first replayed event fails closed", () => {
  const accepted = ev();
  const state = applyOutcomeJobExecutionEvent(undefined, accepted);

  const foreignTenantScope = createTenantScope("tenant-os-v0-05-foreign");
  const foreignCustomer = createCustomer({ tenantScope: foreignTenantScope, customerId: "cust-foreign", displayName: "Foreign" });
  const foreignProject = createProject({
    tenantScope: foreignTenantScope,
    customer: foreignCustomer,
    projectId: "project-foreign",
    ownerRef: "owner-foreign",
    state: "active",
  });
  const foreignJob = createOutcomeJob({
    tenantScope: foreignTenantScope,
    customer: foreignCustomer,
    project: foreignProject,
    jobId: "job-foreign",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver website",
  });
  const foreignEvent = createOutcomeJobExecutionEvent({
    tenantScope: foreignTenantScope,
    customer: foreignCustomer,
    project: foreignProject,
    job: foreignJob,
    runId: "run-1",
    correlationId: "corr-1",
    attempt: 1,
    sequence: 1,
    type: "ATTEMPT_STARTED",
    occurredAt: "2026-09-26T00:00:01.000Z",
  });
  assert.throws(() => applyOutcomeJobExecutionEvent(state, foreignEvent), InvalidOutcomeJobExecutionTransitionError);
});

test("R3 (#2): a mismatched correlationId fails closed even when tenant/customer/project/job/run all match", () => {
  const accepted = ev();
  const state = applyOutcomeJobExecutionEvent(undefined, accepted);
  const wrongCorrelation = ev({ correlationId: "corr-different", type: "ATTEMPT_STARTED" });
  assert.throws(() => applyOutcomeJobExecutionEvent(state, wrongCorrelation), InvalidOutcomeJobExecutionTransitionError);
});

test("R4 (#3): duplicate exact-eventId redelivery of ACCEPTED and of a result event is a no-op that returns the same state reference", () => {
  const accepted = ev();
  const state1 = applyOutcomeJobExecutionEvent(undefined, accepted);
  const state2 = applyOutcomeJobExecutionEvent(state1, accepted);
  assert.equal(state1, state2, "duplicate ACCEPTED must be a no-op returning the identical state reference");

  const started = ev({ type: "ATTEMPT_STARTED" });
  const state3 = applyOutcomeJobExecutionEvent(state2, started);
  const succeeded = ev({ type: "SUCCEEDED", sequence: 2 });
  const state4 = applyOutcomeJobExecutionEvent(state3, succeeded);
  const state5 = applyOutcomeJobExecutionEvent(state4, succeeded);
  assert.equal(state4, state5, "duplicate SUCCEEDED must be a no-op");
});

test("R5 (#4): a second, distinct ACCEPTED throws; an out-of-order/older sequence for the current attempt cannot regress state", () => {
  const accepted = ev();
  let state = applyOutcomeJobExecutionEvent(undefined, accepted);
  assert.throws(
    () => applyOutcomeJobExecutionEvent(state, ev({ type: "ACCEPTED", sequence: 2 })),
    InvalidOutcomeJobExecutionTransitionError,
    "a second ACCEPTED with a distinct eventId (different sequence) must still be rejected - a run can only ever be accepted once",
  );

  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "PROGRESS", sequence: 2, progressRef: "p2" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "PROGRESS", sequence: 3, progressRef: "p3" }));
  assert.equal(state.attempts.get(1)?.lastProgressRef, "p3");

  // An older sequence (with a distinct eventId, since sequence is part of
  // the eventId tuple) must not regress the already-recorded progress ref.
  const stale = ev({ type: "PROGRESS", sequence: 2, progressRef: "STALE-SHOULD-NOT-APPLY" });
  const afterStale = applyOutcomeJobExecutionEvent(state, stale);
  assert.equal(afterStale, state, "stale/out-of-order sequence must be a no-op");
  assert.equal(afterStale.attempts.get(1)?.lastProgressRef, "p3");
});

test("R6 (#5): a result/progress event with no started attempt fails closed (result before durable acceptance/attempt-start)", () => {
  const accepted = ev();
  const state = applyOutcomeJobExecutionEvent(undefined, accepted);
  assert.throws(
    () => applyOutcomeJobExecutionEvent(state, ev({ type: "SUCCEEDED", sequence: 1 })),
    InvalidOutcomeJobExecutionTransitionError,
    "SUCCEEDED before any ATTEMPT_STARTED must fail closed",
  );
  assert.throws(
    () => applyOutcomeJobExecutionEvent(state, ev({ type: "PROGRESS", sequence: 1 })),
    InvalidOutcomeJobExecutionTransitionError,
  );
});

test("R7: an attempt cannot start while the current attempt is still RUNNING, and attempt numbers must advance by exactly one", () => {
  let state = applyOutcomeJobExecutionEvent(undefined, ev());
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED" }));
  assert.throws(
    () => applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED", attempt: 2, sequence: 1 })),
    InvalidOutcomeJobExecutionTransitionError,
    "cannot start attempt 2 while attempt 1 is still RUNNING",
  );

  state = applyOutcomeJobExecutionEvent(state, ev({ type: "FAILED", sequence: 2, reason: "boom" }));
  assert.throws(
    () => applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED", attempt: 3, sequence: 1 })),
    InvalidOutcomeJobExecutionTransitionError,
    "attempt must advance by exactly one - attempt 3 cannot start immediately after attempt 1",
  );

  const state2 = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED", attempt: 2, sequence: 1 }));
  assert.equal(state2.currentAttempt, 2);
  assert.equal(state2.status, "RUNNING");
});

test("R8: a stale ATTEMPT_STARTED for an already-superseded attempt number is a no-op", () => {
  let state = applyOutcomeJobExecutionEvent(undefined, ev());
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "FAILED", sequence: 2, reason: "boom" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED", attempt: 2, sequence: 1 }));

  const staleRestart = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED", attempt: 1, sequence: 1 }));
  assert.equal(staleRestart, state);
});

test("R9: an event for a superseded (older) attempt number, once a newer attempt exists, is a no-op", () => {
  let state = applyOutcomeJobExecutionEvent(undefined, ev());
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "FAILED", sequence: 2, reason: "boom" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED", attempt: 2, sequence: 1 }));

  const staleAttempt1Progress = applyOutcomeJobExecutionEvent(
    state,
    ev({ type: "PROGRESS", attempt: 1, sequence: 3, progressRef: "late-straggler" }),
  );
  assert.equal(staleAttempt1Progress, state);
});

test("R10: once an attempt reaches a terminal status, a further distinct event for it is a no-op (not a throw)", () => {
  let state = applyOutcomeJobExecutionEvent(undefined, ev());
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "ATTEMPT_STARTED" }));
  state = applyOutcomeJobExecutionEvent(state, ev({ type: "SUCCEEDED", sequence: 2 }));
  const afterMoreProgress = applyOutcomeJobExecutionEvent(
    state,
    ev({ type: "PROGRESS", sequence: 3, progressRef: "too-late" }),
  );
  assert.equal(afterMoreProgress, state);
  assert.equal(afterMoreProgress.attempts.get(1)?.status, "SUCCEEDED");
});

test("R11 (#13): reconstructOutcomeJobExecutionRunState from the full event log reproduces the identical state a live fold produces", () => {
  const events = [
    ev(),
    ev({ type: "ATTEMPT_STARTED" }),
    ev({ type: "PROGRESS", sequence: 2, progressRef: "halfway" }),
    ev({ type: "FAILED", sequence: 3, reason: "transient" }),
    ev({ type: "ATTEMPT_STARTED", attempt: 2, sequence: 1 }),
    ev({ type: "SUCCEEDED", attempt: 2, sequence: 2 }),
  ];
  let live: ReturnType<typeof applyOutcomeJobExecutionEvent> | undefined;
  for (const event of events) {
    live = applyOutcomeJobExecutionEvent(live, event);
  }
  const reconstructed = reconstructOutcomeJobExecutionRunState(events);
  assert.deepEqual(reconstructed, live);
  assert.equal(reconstructed?.status, "SUCCEEDED");
  assert.equal(reconstructed?.currentAttempt, 2);
});

test("terminal reason/checkpoint/progress fields are recorded and mutually exclusive per event type at construction time", () => {
  assert.throws(() => ev({ type: "FAILED", reason: undefined }), Error, "FAILED requires a reason");
  assert.throws(
    () => ev({ type: "ACCEPTED", reason: "should not be allowed" } as never),
    Error,
    "ACCEPTED must not carry a reason",
  );
  assert.throws(
    () => ev({ type: "PROGRESS", checkpointRef: "x" } as never),
    Error,
    "PROGRESS must not carry a checkpointRef",
  );
});
