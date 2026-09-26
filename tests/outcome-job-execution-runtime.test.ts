import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, transitionOutcomeJob, type OutcomeJob } from "../src/domain/outcome-job.js";
import { createAuthorityContext, InsufficientAuthorityError, type AuthorityContext } from "../src/domain/authority.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import type { OutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import { applyOutcomeJobExecutionEvent, type OutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import {
  dispatchOutcomeJobExecutionRun,
  retryOutcomeJobExecutionAttempt,
  recordExecutionProgress,
  recordExecutionResult,
  advanceOutcomeJobAfterExecutionSuccess,
  applyWorkerHeartbeat,
  requestExecutionCancellation,
  requestExecutionCheckpoint,
  InvalidOutcomeJobExecutionRuntimeError,
  StaleActivationFingerprintError,
  UnauthorizedUnknownRetryError,
  type ExecutionEventStore,
} from "../src/application/outcome-job-execution-runtime.js";

class InMemoryExecutionEventStore implements ExecutionEventStore {
  private readonly byRun = new Map<string, OutcomeJobExecutionRunState>();
  private readonly seenEventIds = new Set<string>();

  // Synchronous, no internal await - matches the real stores' own atomicity
  // discipline (a fully synchronous check-then-write cannot interleave with
  // another call in JS's single-threaded run-to-completion model), so a
  // Promise.all([store.appendEvent(e), store.appendEvent(e)]) test here
  // genuinely exercises the same single-authority guarantee the real file
  // and Postgres stores provide (Rev145 F1).
  appendEvent(event: OutcomeJobExecutionEvent): boolean {
    if (this.seenEventIds.has(event.eventId)) {
      return false;
    }
    this.seenEventIds.add(event.eventId);
    const key = JSON.stringify([event.tenantId, event.customerId, event.projectId, event.jobId, event.runId]);
    const current = this.byRun.get(key);
    const next = applyOutcomeJobExecutionEvent(current, event);
    this.byRun.set(key, next);
    return true;
  }

  getState(
    tenantId: string,
    customerId: string,
    projectId: string,
    jobId: string,
    runId: string,
  ): OutcomeJobExecutionRunState | undefined {
    return this.byRun.get(JSON.stringify([tenantId, customerId, projectId, jobId, runId]));
  }
}

const tenantScope = createTenantScope("tenant-runtime-os-v0-05");
const customer = createCustomer({ tenantScope, customerId: "cust-runtime", displayName: "Runtime Customer" });
const project = createProject({ tenantScope, customer, projectId: "project-runtime", ownerRef: "owner-runtime", state: "active" });

function freshJob(jobId = "job-runtime"): OutcomeJob {
  const job = createOutcomeJob({
    tenantScope, customer, project, jobId, jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver website",
  });
  const qualified = transitionOutcomeJob(job, "QUALIFIED");
  const ready = transitionOutcomeJob(qualified, "READY");
  return transitionOutcomeJob(ready, "EXECUTING");
}

const authority: AuthorityContext = createAuthorityContext({
  tenantScope, permissions: ["EXECUTE", "WRITE", "READ"], canPerformProtectedActions: false,
});
const protectedAuthority: AuthorityContext = createAuthorityContext({
  tenantScope, permissions: ["EXECUTE", "WRITE", "READ"], canPerformProtectedActions: true,
});

function acceptingInvoker(): WorkerInvoker {
  return { role: "CLAUDE_PRIMARY_ENGINEER", invoke: async () => ({ accepted: true }) };
}
function rejectingInvoker(): WorkerInvoker {
  return { role: "CLAUDE_PRIMARY_ENGINEER", invoke: async () => ({ accepted: false }) };
}

const baseDispatch = {
  tenantScope, customer, project,
  now: "2026-09-26T00:00:00.000Z",
  executorKind: "INJECTED",
  expectedFingerprint: "fp-1",
  currentFingerprint: "fp-1",
  taskId: "task-1", branch: "claude/os-v0-05-run", checkpointSha: "sha-1",
};

test("D1: dispatch durably accepts, starts attempt 1, and invokes the worker with OutcomeJob run identity", async () => {
  const job = freshJob("job-d1");
  const store = new InMemoryExecutionEventStore();
  let capturedContext: unknown;
  const invoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async (input) => {
      capturedContext = input.outcomeJobExecution;
      return { accepted: true };
    },
  };
  const result = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d1", correlationId: "corr-d1", store, invoker,
  });
  assert.equal(result.invoked, true);
  assert.equal(result.state.status, "RUNNING");
  assert.equal(result.state.currentAttempt, 1);
  assert.deepEqual(capturedContext, {
    tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId,
    jobId: job.jobId, runId: "run-d1", correlationId: "corr-d1", attempt: 1,
  });
});

test("D2 (#9): dispatching the same runId twice is idempotent and does not invoke the worker a second time", async () => {
  const job = freshJob("job-d2");
  const store = new InMemoryExecutionEventStore();
  let invokeCount = 0;
  const invoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      invokeCount += 1;
      return { accepted: true };
    },
  };
  await dispatchOutcomeJobExecutionRun({ ...baseDispatch, job, authority, runId: "run-d2", correlationId: "corr-d2", store, invoker });
  const second = await dispatchOutcomeJobExecutionRun({ ...baseDispatch, job, authority, runId: "run-d2", correlationId: "corr-d2", store, invoker });
  assert.equal(invokeCount, 1);
  assert.equal(second.invoked, false);
});

test("D3 (#8): a rejected invocation produces an explicit FAILED execution-runtime truth, never a fabricated success", async () => {
  const job = freshJob("job-d3");
  const store = new InMemoryExecutionEventStore();
  const result = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d3", correlationId: "corr-d3", store, invoker: rejectingInvoker(),
  });
  assert.equal(result.state.status, "FAILED");
  assert.equal(result.state.attempts.get(1)?.reason, "invoker did not accept the request");
});

test("D4 (#11): a stale activation fingerprint blocks dispatch before any effect - no event is appended and the worker is never invoked", async () => {
  const job = freshJob("job-d4");
  const store = new InMemoryExecutionEventStore();
  let invoked = false;
  const invoker: WorkerInvoker = { role: "CLAUDE_PRIMARY_ENGINEER", invoke: async () => { invoked = true; return { accepted: true }; } };
  await assert.rejects(
    () => dispatchOutcomeJobExecutionRun({
      ...baseDispatch, job, authority, runId: "run-d4", correlationId: "corr-d4", store, invoker,
      expectedFingerprint: "fp-old", currentFingerprint: "fp-new",
    }),
    StaleActivationFingerprintError,
  );
  assert.equal(invoked, false);
  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d4");
  assert.equal(state, undefined, "no durable state must exist after a currentness-blocked dispatch");
});

test("D5 (#16 activation boundary): a non-activated executorKind is rejected as NOT_ACTIVATED/UNSUPPORTED rather than simulated", async () => {
  const job = freshJob("job-d5");
  const store = new InMemoryExecutionEventStore();
  await assert.rejects(
    () => dispatchOutcomeJobExecutionRun({
      ...baseDispatch, job, authority, runId: "run-d5", correlationId: "corr-d5", store, invoker: acceptingInvoker(),
      executorKind: "LOCAL",
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
});

test("D6 (#7): a worker heartbeat leaves run state unchanged", async () => {
  const job = freshJob("job-d6");
  const store = new InMemoryExecutionEventStore();
  const result = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d6", correlationId: "corr-d6", store, invoker: acceptingInvoker(),
  });
  const afterHeartbeat = applyWorkerHeartbeat(result.state);
  assert.equal(afterHeartbeat, result.state);
});

test("D7: recordExecutionProgress auto-derives an increasing sequence and records the progress ref", async () => {
  const job = freshJob("job-d7");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d7", correlationId: "corr-d7", store, invoker: acceptingInvoker(),
  });
  const afterProgress = await recordExecutionProgress({
    tenantScope, customer, project, job, currentState: dispatched.state, now: "2026-09-26T00:00:05.000Z", store, progressRef: "step-1",
  });
  assert.equal(afterProgress.attempts.get(1)?.lastProgressRef, "step-1");
});

test("D8 (#6): recordExecutionResult SUCCEEDED never mutates the OutcomeJob; advanceOutcomeJobAfterExecutionSuccess only ever reaches VERIFYING, never VERIFIED", async () => {
  const job = freshJob("job-d8");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d8", correlationId: "corr-d8", store, invoker: acceptingInvoker(),
  });
  const succeededState = await recordExecutionResult({
    tenantScope, customer, project, job, currentState: dispatched.state, now: "2026-09-26T00:00:05.000Z", type: "SUCCEEDED", store,
  });
  assert.equal(succeededState.status, "SUCCEEDED");
  assert.equal(job.state, "EXECUTING", "recordExecutionResult must never itself mutate the OutcomeJob");

  const advanced = advanceOutcomeJobAfterExecutionSuccess(job, succeededState);
  assert.equal(advanced.state, "VERIFYING");
  assert.notEqual(advanced.state as string, "VERIFIED");
});

test("D9: advanceOutcomeJobAfterExecutionSuccess throws if the current attempt is not SUCCEEDED", async () => {
  const job = freshJob("job-d9");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d9", correlationId: "corr-d9", store, invoker: rejectingInvoker(),
  });
  assert.throws(() => advanceOutcomeJobAfterExecutionSuccess(job, dispatched.state), InvalidOutcomeJobExecutionRuntimeError);
});

test("D10 (#9, #10): retry after FAILED advances the attempt and re-invokes; retry after UNKNOWN is rejected without explicit protected-action override", async () => {
  const job = freshJob("job-d10");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d10", correlationId: "corr-d10", store, invoker: rejectingInvoker(),
  });
  assert.equal(dispatched.state.status, "FAILED");

  const retried = await retryOutcomeJobExecutionAttempt({
    tenantScope, customer, project, job, authority, currentState: dispatched.state,
    now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
    expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
    store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
  });
  assert.equal(retried.state.currentAttempt, 2);
  assert.equal(retried.state.status, "RUNNING");

  const unknownState = await recordExecutionResult({
    tenantScope, customer, project, job, currentState: retried.state, now: "2026-09-26T00:02:00.000Z", type: "UNKNOWN", store, reason: "no readback",
  });
  await assert.rejects(
    () => retryOutcomeJobExecutionAttempt({
      tenantScope, customer, project, job, authority, currentState: unknownState,
      now: "2026-09-26T00:03:00.000Z", executorKind: "INJECTED",
      expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-3",
    }),
    UnauthorizedUnknownRetryError,
  );

  const overriddenRetry = await retryOutcomeJobExecutionAttempt({
    tenantScope, customer, project, job, authority: protectedAuthority, currentState: unknownState,
    now: "2026-09-26T00:04:00.000Z", executorKind: "INJECTED",
    expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
    store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-4",
  });
  assert.equal(overriddenRetry.state.currentAttempt, 3);
});

test("D11 (#11): retry is also blocked by a stale activation fingerprint before any effect", async () => {
  const job = freshJob("job-d11");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d11", correlationId: "corr-d11", store, invoker: rejectingInvoker(),
  });
  await assert.rejects(
    () => retryOutcomeJobExecutionAttempt({
      tenantScope, customer, project, job, authority, currentState: dispatched.state,
      now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
      expectedFingerprint: "fp-old", currentFingerprint: "fp-new",
      store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
    }),
    StaleActivationFingerprintError,
  );
  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d11");
  assert.equal(state?.currentAttempt, 1, "a stale retry must not advance the attempt");
});

test("D12 (#12): cancel/checkpoint capability that the executor does not declare returns UNSUPPORTED rather than a fabricated success", async () => {
  const job = freshJob("job-d12");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d12", correlationId: "corr-d12", store, invoker: acceptingInvoker(),
  });

  const afterCancelAttempt = await requestExecutionCancellation({
    tenantScope, customer, project, job, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: false }, reason: "user requested", store,
  });
  assert.equal(afterCancelAttempt.attempts.get(1)?.status, "UNSUPPORTED");

  const job2 = freshJob("job-d12b");
  const dispatched2 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job2, authority, runId: "run-d12b", correlationId: "corr-d12b", store, invoker: acceptingInvoker(),
  });
  const afterRealCancel = await requestExecutionCancellation({
    tenantScope, customer, project, job: job2, currentState: dispatched2.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "user requested", store,
  });
  assert.equal(afterRealCancel.attempts.get(1)?.status, "CANCELLED");

  const job3 = freshJob("job-d12c");
  const dispatched3 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job3, authority, runId: "run-d12c", correlationId: "corr-d12c", store, invoker: acceptingInvoker(),
  });
  const afterCheckpointAttempt = await requestExecutionCheckpoint({
    tenantScope, customer, project, job: job3, currentState: dispatched3.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: false }, store,
  });
  assert.equal(afterCheckpointAttempt.attempts.get(1)?.status, "UNSUPPORTED");
});

test("D13: dispatch requires the caller's authority to belong to the same tenant as the job", async () => {
  const job = freshJob("job-d13");
  const store = new InMemoryExecutionEventStore();
  const foreignTenantScope = createTenantScope("tenant-runtime-foreign");
  const foreignAuthority = createAuthorityContext({ tenantScope: foreignTenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: false });
  await assert.rejects(() =>
    dispatchOutcomeJobExecutionRun({
      ...baseDispatch, job, authority: foreignAuthority, runId: "run-d13", correlationId: "corr-d13", store, invoker: acceptingInvoker(),
    }),
  );
});

test("D14 (Rev145 F1): two concurrent dispatch calls for the same run only invoke the worker once - the loser is a durable no-op", async () => {
  const job = freshJob("job-d14");
  const store = new InMemoryExecutionEventStore();
  let invokeCount = 0;
  const invoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      invokeCount += 1;
      return { accepted: true };
    },
  };
  const callOnce = () =>
    dispatchOutcomeJobExecutionRun({
      ...baseDispatch, job, authority, runId: "run-d14", correlationId: "corr-d14", store, invoker,
    });
  const [resultA, resultB] = await Promise.all([callOnce(), callOnce()]);
  assert.equal(invokeCount, 1, "exactly one concurrent dispatch caller must actually invoke the worker");
  assert.deepEqual([resultA.invoked, resultB.invoked].sort(), [false, true]);
  assert.equal(resultA.state.currentAttempt, 1);
  assert.equal(resultB.state.currentAttempt, 1);
});

test("D15 (Rev145 F1): two concurrent retry calls against the same failed attempt only invoke the worker once", async () => {
  const job = freshJob("job-d15");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d15", correlationId: "corr-d15", store, invoker: rejectingInvoker(),
  });
  assert.equal(dispatched.state.status, "FAILED");

  let invokeCount = 0;
  const invoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      invokeCount += 1;
      return { accepted: true };
    },
  };
  const callOnce = () =>
    retryOutcomeJobExecutionAttempt({
      tenantScope, customer, project, job, authority, currentState: dispatched.state,
      now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
      expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      store, invoker, taskId: "task-1", branch: "b", checkpointSha: "sha-2",
    });
  const [resultA, resultB] = await Promise.all([callOnce(), callOnce()]);
  assert.equal(invokeCount, 1, "exactly one concurrent retry caller must actually invoke the worker");
  assert.deepEqual([resultA.invoked, resultB.invoked].sort(), [false, true]);
  assert.equal(resultA.state.currentAttempt, 2);
  assert.equal(resultB.state.currentAttempt, 2);
});

test("D16 (Rev145 F3): a same-tenant authority without EXECUTE permission is rejected for both dispatch and retry", async () => {
  const job = freshJob("job-d16");
  const store = new InMemoryExecutionEventStore();
  const readOnlyAuthority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });

  await assert.rejects(
    () => dispatchOutcomeJobExecutionRun({
      ...baseDispatch, job, authority: readOnlyAuthority, runId: "run-d16", correlationId: "corr-d16", store, invoker: acceptingInvoker(),
    }),
    InsufficientAuthorityError,
  );

  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d16b", correlationId: "corr-d16b", store, invoker: rejectingInvoker(),
  });
  await assert.rejects(
    () => retryOutcomeJobExecutionAttempt({
      tenantScope, customer, project, job, authority: readOnlyAuthority, currentState: dispatched.state,
      now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
      expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
    }),
    InsufficientAuthorityError,
  );
});

test("D17 (Rev145 F4): a currentState forged to carry a foreign job's identity is rejected by retry/progress/result/cancel/checkpoint - cross-job substitution fails closed", async () => {
  const jobA = freshJob("job-d17-a");
  const jobB = freshJob("job-d17-b");
  const store = new InMemoryExecutionEventStore();
  const dispatchedA = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: jobA, authority, runId: "run-d17-a", correlationId: "corr-d17-a", store, invoker: acceptingInvoker(),
  });
  // A structurally valid OutcomeJobExecutionRunState, but forged to claim
  // jobB's identity while every operation below is asked to act on jobA -
  // exactly the caller-constructible substitution Rev145 F4 flags, since
  // this interface is a plain exported type, not a branded/opaque value.
  const forgedState = { ...dispatchedA.state, jobId: jobB.jobId };

  await assert.rejects(
    () => recordExecutionProgress({ tenantScope, customer, project, job: jobA, currentState: forgedState, now: "2026-09-26T00:01:00.000Z", store }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => recordExecutionResult({ tenantScope, customer, project, job: jobA, currentState: forgedState, now: "2026-09-26T00:01:00.000Z", type: "SUCCEEDED", store }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job: jobA, currentState: forgedState, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store,
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job: jobA, currentState: forgedState, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store,
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => retryOutcomeJobExecutionAttempt({
      tenantScope, customer, project, job: jobA, authority, currentState: forgedState,
      now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
      expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
});

test("D18 (Rev145 F4): retry/progress/result/cancel/checkpoint consume freshly re-fetched durable state, not a stale caller-supplied copy", async () => {
  const job = freshJob("job-d18");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d18", correlationId: "corr-d18", store, invoker: acceptingInvoker(),
  });
  const staleState = dispatched.state;
  // Advance the real durable state past what the caller's stale copy knows
  // about (a second PROGRESS event applied only to the store, not to the
  // caller's own in-memory `staleState` reference).
  await recordExecutionProgress({ tenantScope, customer, project, job, currentState: staleState, now: "2026-09-26T00:01:00.000Z", store, progressRef: "p1" });
  const afterSecondProgress = await recordExecutionProgress({
    tenantScope, customer, project, job, currentState: staleState, now: "2026-09-26T00:02:00.000Z", store, progressRef: "p2",
  });
  // Both calls used the SAME stale `staleState` object, yet the durable
  // sequence still advanced correctly (2, not a collision on sequence 2
  // computed twice from the same stale lastSequence) - proof the function
  // consumed freshly re-fetched state internally rather than the caller's
  // stale copy.
  assert.equal(afterSecondProgress.attempts.get(1)?.lastProgressRef, "p2");
  assert.equal(afterSecondProgress.attempts.get(1)?.lastSequence, 3);
});
