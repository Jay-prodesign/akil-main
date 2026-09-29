import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob, transitionOutcomeJob, type OutcomeJob } from "../src/domain/outcome-job.js";
import { createAuthorityContext, InsufficientAuthorityError, type AuthorityContext } from "../src/domain/authority.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import {
  createOutcomeJobExecutionEvent,
  InvalidOutcomeJobExecutionEventError,
  type OutcomeJobExecutionEvent,
} from "../src/domain/outcome-job-execution-event.js";
import { applyOutcomeJobExecutionEvent, type OutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
  admitQuotaReservation,
  commitQuotaUsage,
  EMPTY_QUOTA_LEDGER,
  StaleQuotaEnvelopeError,
  type QuotaEnvelope,
  type QuotaReservationIdentity,
  type QuotaLedger,
  type QuotaAdmissionOutcome,
  type QuotaCommitOutcome,
} from "../src/domain/execution-quota-admission.js";
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
  PendingControlOperationReconciliationRequiredError,
  type ExecutionEventStore,
  type ControlOperationInvoker,
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

function countingAcknowledgingControlInvoker(checkpointRef = "checkpoint-ref-1"): ControlOperationInvoker & {
  cancelCalls: number;
  checkpointCalls: number;
  reconcileCalls: number;
} {
  return {
    cancelCalls: 0,
    checkpointCalls: 0,
    reconcileCalls: 0,
    async requestCancel() {
      this.cancelCalls += 1;
      return { acknowledged: true };
    },
    async requestCheckpoint() {
      this.checkpointCalls += 1;
      return { acknowledged: true, checkpointRef };
    },
    async reconcileControlRequest(input) {
      this.reconcileCalls += 1;
      return input.kind === "CHECKPOINT" ? { acknowledged: true, checkpointRef } : { acknowledged: true };
    },
  };
}
function unacknowledgingControlInvoker(): ControlOperationInvoker & { cancelCalls: number; checkpointCalls: number } {
  return {
    cancelCalls: 0,
    checkpointCalls: 0,
    async requestCancel() {
      this.cancelCalls += 1;
      return { acknowledged: false, reason: "not confirmed" };
    },
    async requestCheckpoint() {
      this.checkpointCalls += 1;
      return { acknowledged: false, reason: "not confirmed" };
    },
    async reconcileControlRequest() {
      return { acknowledged: false, reason: "not confirmed" };
    },
  };
}
function neverCallControlInvoker(): ControlOperationInvoker {
  return {
    requestCancel: async () => {
      throw new Error("requestCancel must never be invoked for this scenario");
    },
    reconcileControlRequest: async () => {
      throw new Error("reconcileControlRequest must never be invoked for this scenario");
    },
    requestCheckpoint: async () => {
      throw new Error("requestCheckpoint must never be invoked for this scenario");
    },
  };
}

/**
 * OS-V0-07: in-memory `QuotaAdmissionPort` for this file's existing
 * (pre-OS-V0-07) OS-V0-05 witnesses, mirroring `InMemoryExecutionEventStore`'s
 * own thin-wrapper-around-the-pure-reducer style. A generously large limit
 * means every existing dispatch/retry witness in this file - none of which
 * are exercising quota behavior itself - passes admission trivially; OS-V0-07's
 * OWN new witnesses (R14+) construct a dedicated store/envelope with a small
 * limit where they need to observe REJECTED/BLOCKED.
 */
class InMemoryQuotaAdmissionStore {
  private ledger: QuotaLedger = EMPTY_QUOTA_LEDGER;

  admit(input: {
    envelope: QuotaEnvelope;
    identity: QuotaReservationIdentity;
    idempotencyKey: unknown;
    requestedAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    occurredAt: unknown;
  }): QuotaAdmissionOutcome {
    const { ledger, outcome } = admitQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  commit(input: {
    identity: QuotaReservationIdentity;
    idempotencyKey: unknown;
    actualAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    occurredAt: unknown;
  }): QuotaCommitOutcome {
    const { ledger, outcome } = commitQuotaUsage({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  ledgerSnapshot(): QuotaLedger {
    return this.ledger;
  }
}

function smallLimitQuota(limitMinorUnits: number): { store: InMemoryQuotaAdmissionStore; envelope: QuotaEnvelope } {
  return {
    store: new InMemoryQuotaAdmissionStore(),
    envelope: createQuotaEnvelope({
      scope: quotaScope,
      envelopeRef: "envelope-small",
      sourceFingerprint: "qfp-1",
      limit: { presence: "REPORTED", amountMinorUnits: limitMinorUnits, currency: "USD" },
    }),
  };
}

class NeverCalledQuotaAdmission {
  admit(): never {
    throw new Error("quota admission must never be invoked for this scenario - a higher-priority gate must have already rejected first");
  }
  commit(): never {
    throw new Error("quota commit must never be invoked for this scenario");
  }
}

const quotaScope = createQuotaAdmissionScope({
  tenantScope, customerId: customer.customerId, projectId: project.projectId, planId: "plan-runtime", planVersion: 1,
});
const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
  scope: quotaScope,
  envelopeRef: "envelope-runtime",
  sourceFingerprint: "qfp-1",
  limit: { presence: "REPORTED", amountMinorUnits: 1_000_000_000, currency: "USD" },
});
const sharedQuotaAdmission = new InMemoryQuotaAdmissionStore();

const baseDispatch = {
  tenantScope, customer, project,
  now: "2026-09-26T00:00:00.000Z",
  executorKind: "INJECTED",
  expectedFingerprint: "fp-1",
  currentFingerprint: "fp-1",
  taskId: "task-1", branch: "claude/os-v0-05-run", checkpointSha: "sha-1",
  quotaAdmission: sharedQuotaAdmission,
  quotaEnvelope,
  currentQuotaSourceFingerprint: "qfp-1",
  estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
      store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-3",
    }),
    UnauthorizedUnknownRetryError,
  );

  const overriddenRetry = await retryOutcomeJobExecutionAttempt({
    tenantScope, customer, project, job, authority: protectedAuthority, currentState: unknownState,
    now: "2026-09-26T00:04:00.000Z", executorKind: "INJECTED",
    expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
      store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
    }),
    StaleActivationFingerprintError,
  );
  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d11");
  assert.equal(state?.currentAttempt, 1, "a stale retry must not advance the attempt");
});

test("D12 (Rev149 F9/F10): an unsupported capability leaves the attempt RUNNING (no terminal event); a supported AND acknowledged control operation follows the truthful CANCELLED/CHECKPOINT path", async () => {
  const job = freshJob("job-d12");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d12", correlationId: "corr-d12", store, invoker: acceptingInvoker(),
  });

  const afterUnsupportedCancel = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: false }, reason: "user requested", store,
    controlInvoker: neverCallControlInvoker(),
  });
  assert.equal(afterUnsupportedCancel.attempts.get(1)?.status, "RUNNING", "an unsupported capability must never terminalize the attempt");

  const job2 = freshJob("job-d12b");
  const dispatched2 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job2, authority, runId: "run-d12b", correlationId: "corr-d12b", store, invoker: acceptingInvoker(),
  });
  const realCancelInvoker = countingAcknowledgingControlInvoker();
  const afterRealCancel = await requestExecutionCancellation({
    tenantScope, customer, project, job: job2, authority, currentState: dispatched2.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "user requested", store,
    controlInvoker: realCancelInvoker,
  });
  assert.equal(afterRealCancel.attempts.get(1)?.status, "CANCELLED");
  assert.equal(realCancelInvoker.cancelCalls, 1);

  const job3 = freshJob("job-d12c");
  const dispatched3 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job3, authority, runId: "run-d12c", correlationId: "corr-d12c", store, invoker: acceptingInvoker(),
  });
  const afterUnsupportedCheckpoint = await requestExecutionCheckpoint({
    tenantScope, customer, project, job: job3, authority, currentState: dispatched3.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: false }, store, controlInvoker: neverCallControlInvoker(),
  });
  assert.equal(afterUnsupportedCheckpoint.attempts.get(1)?.status, "RUNNING", "an unsupported capability must never terminalize the attempt");

  const job4 = freshJob("job-d12d");
  const dispatched4 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job4, authority, runId: "run-d12d", correlationId: "corr-d12d", store, invoker: acceptingInvoker(),
  });
  const realCheckpointInvoker = countingAcknowledgingControlInvoker("real-checkpoint-ref");
  const afterRealCheckpoint = await requestExecutionCheckpoint({
    tenantScope, customer, project, job: job4, authority, currentState: dispatched4.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: realCheckpointInvoker,
  });
  assert.equal(afterRealCheckpoint.attempts.get(1)?.status, "RUNNING", "CHECKPOINT does not terminalize the attempt");
  assert.equal(afterRealCheckpoint.attempts.get(1)?.lastCheckpointRef, "real-checkpoint-ref");
  assert.equal(realCheckpointInvoker.checkpointCalls, 1);
});

test("D23 (Rev149 F9, mandatory witness 1): supportsCancel=true but the control invoker does not acknowledge cannot become CANCELLED", async () => {
  const job = freshJob("job-d23");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d23", correlationId: "corr-d23", store, invoker: acceptingInvoker(),
  });
  const invoker = unacknowledgingControlInvoker();
  const result = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "user requested", store, controlInvoker: invoker,
  });
  assert.equal(result.attempts.get(1)?.status, "RUNNING", "capability without acknowledgement must never become CANCELLED");
  assert.equal(invoker.cancelCalls, 1, "the control invoker must actually have been called - this is not the unsupported path");
});

test("D24 (Rev149 F9, mandatory witness 2): supportsCheckpoint=true with an acknowledgement carrying no real checkpointRef cannot create CHECKPOINT or placeholder evidence", async () => {
  const job = freshJob("job-d24");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d24", correlationId: "corr-d24", store, invoker: acceptingInvoker(),
  });
  const invoker: ControlOperationInvoker = {
    requestCancel: async () => ({ acknowledged: true }),
    requestCheckpoint: async () => ({ acknowledged: true }), // acknowledged, but NO checkpointRef - an adversarial/buggy invoker
    reconcileControlRequest: async () => {
      throw new Error("reconcileControlRequest must never be invoked for this scenario");
    },
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
    "an acknowledged checkpoint with no real checkpointRef must fail closed, never fabricate a placeholder",
  );
  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d24");
  assert.equal(state?.attempts.get(1)?.lastCheckpointRef, undefined, "no CHECKPOINT event may have been durably recorded");
});

test("D25 (Rev149 F10, mandatory witness 3): unsupported cancel/checkpoint leave the attempt RUNNING and a later valid progress/result remains admissible", async () => {
  const job = freshJob("job-d25");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d25", correlationId: "corr-d25", store, invoker: acceptingInvoker(),
  });
  await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: false }, reason: "x", store, controlInvoker: neverCallControlInvoker(),
  });
  await requestExecutionCheckpoint({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:30.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: false }, store, controlInvoker: neverCallControlInvoker(),
  });
  // A later valid progress AND result must still be accepted - the run was
  // never terminalized by the two unsupported control requests.
  const afterProgress = await recordExecutionProgress({
    tenantScope, customer, project, job, currentState: dispatched.state, now: "2026-09-26T00:02:00.000Z", store, progressRef: "still-going",
  });
  assert.equal(afterProgress.attempts.get(1)?.lastProgressRef, "still-going");
  const afterResult = await recordExecutionResult({
    tenantScope, customer, project, job, currentState: afterProgress, now: "2026-09-26T00:03:00.000Z", type: "SUCCEEDED", store,
  });
  assert.equal(afterResult.attempts.get(1)?.status, "SUCCEEDED");
});

test("D26 (Rev149 F11, mandatory witness 4): cross-tenant and same-tenant non-EXECUTE control requests fail closed with zero durable mutation/effect invocation", async () => {
  const job = freshJob("job-d26");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d26", correlationId: "corr-d26", store, invoker: acceptingInvoker(),
  });

  const foreignTenantScope = createTenantScope("tenant-runtime-foreign-d26");
  const foreignAuthority = createAuthorityContext({ tenantScope: foreignTenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: false });
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority: foreignAuthority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store, controlInvoker: neverCallControlInvoker(),
    }),
  );

  const readOnlyAuthority = createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false });
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority: readOnlyAuthority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: neverCallControlInvoker(),
    }),
    InsufficientAuthorityError,
  );

  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d26");
  assert.equal(state?.attempts.get(1)?.status, "RUNNING", "neither rejected call may have mutated the run at all");
});

test("D27 (Rev149 F11, mandatory witness 5): malformed non-boolean capability descriptors fail closed before any effect", async () => {
  const job = freshJob("job-d27");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d27", correlationId: "corr-d27", store, invoker: acceptingInvoker(),
  });
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: "yes", supportsCheckpoint: false } as never, reason: "x", store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: null as never, store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
});

test("D28 (Rev149 F9, mandatory witness 7): a duplicate/replayed cancel request against an already-CANCELLED attempt is idempotent and never re-invokes the control operation", async () => {
  const job = freshJob("job-d28");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d28", correlationId: "corr-d28", store, invoker: acceptingInvoker(),
  });
  const invoker = countingAcknowledgingControlInvoker();
  const first = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store, controlInvoker: invoker,
  });
  assert.equal(first.attempts.get(1)?.status, "CANCELLED");
  const second = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: first, now: "2026-09-26T00:02:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x again", store, controlInvoker: invoker,
  });
  assert.equal(second.attempts.get(1)?.status, "CANCELLED");
  assert.equal(invoker.cancelCalls, 1, "a replayed cancel request against an already-terminal attempt must not re-invoke the control operation");
});

test("D29 (Rev158 F12, mandatory witness): two concurrent cancel requests against the same attempt invoke the control operation at most once", async () => {
  const job = freshJob("job-d29");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d29", correlationId: "corr-d29", store, invoker: acceptingInvoker(),
  });
  const invoker = countingAcknowledgingControlInvoker();
  const call = () => requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store, controlInvoker: invoker,
  });
  await Promise.all([call(), call()]);
  assert.equal(invoker.cancelCalls, 1, "concurrent duplicate cancel requests must invoke the control operation at most once");
  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d29");
  assert.equal(state?.attempts.get(1)?.status, "CANCELLED");
});

test("D30 (Rev158 F12, mandatory witness): two concurrent checkpoint requests against the same attempt invoke the control operation at most once", async () => {
  const job = freshJob("job-d30");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d30", correlationId: "corr-d30", store, invoker: acceptingInvoker(),
  });
  const invoker = countingAcknowledgingControlInvoker("concurrent-ref");
  const call = () => requestExecutionCheckpoint({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
  });
  await Promise.all([call(), call()]);
  assert.equal(invoker.checkpointCalls, 1, "concurrent duplicate checkpoint requests must invoke the control operation at most once");
  const state = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d30");
  assert.equal(state?.attempts.get(1)?.lastCheckpointRef, "concurrent-ref");
});

test("D31 (Rev158 F13, mandatory witness): a malformed/non-boolean-true acknowledgement cannot become CANCELLED or CHECKPOINT", async () => {
  const job = freshJob("job-d31");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d31", correlationId: "corr-d31", store, invoker: acceptingInvoker(),
  });
  const truthyStringInvoker: ControlOperationInvoker = {
    requestCancel: async () => ({ acknowledged: "yes" as unknown as boolean }),
    requestCheckpoint: async () => ({ acknowledged: 1 as unknown as boolean, checkpointRef: "ref" }),
    reconcileControlRequest: async () => {
      throw new Error("reconcileControlRequest must never be invoked for this scenario");
    },
  };
  const afterCancel = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store, controlInvoker: truthyStringInvoker,
  });
  assert.equal(afterCancel.attempts.get(1)?.status, "RUNNING", "a truthy-but-not-strictly-true acknowledged value must never produce CANCELLED");

  const job2 = freshJob("job-d31b");
  const dispatched2 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job2, authority, runId: "run-d31b", correlationId: "corr-d31b", store, invoker: acceptingInvoker(),
  });
  const nonObjectInvoker: ControlOperationInvoker = {
    requestCancel: async () => undefined as unknown as { acknowledged: boolean },
    requestCheckpoint: async () => undefined as unknown as { acknowledged: boolean },
    reconcileControlRequest: async () => {
      throw new Error("reconcileControlRequest must never be invoked for this scenario");
    },
  };
  const afterCheckpoint = await requestExecutionCheckpoint({
    tenantScope, customer, project, job: job2, authority, currentState: dispatched2.state, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: nonObjectInvoker,
  });
  assert.equal(afterCheckpoint.attempts.get(1)?.lastCheckpointRef, undefined, "a non-object acknowledgement must never produce CHECKPOINT");
});

test("D32 (Rev158 F14, mandatory witness): invalid cancel reason/timestamp and invalid checkpoint timestamp fail before the control operation is ever invoked", async () => {
  const job = freshJob("job-d32");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d32", correlationId: "corr-d32", store, invoker: acceptingInvoker(),
  });
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "   ", store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionEventError,
    "an invalid (whitespace-only) cancel reason must fail before the control invoker is ever called",
  );

  const job2 = freshJob("job-d32b");
  const dispatched2 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job2, authority, runId: "run-d32b", correlationId: "corr-d32b", store, invoker: acceptingInvoker(),
  });
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job: job2, authority, currentState: dispatched2.state, now: "not-a-real-timestamp",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionEventError,
    "an invalid cancel occurredAt must fail before the control invoker is ever called",
  );

  const job3 = freshJob("job-d32c");
  const dispatched3 = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job: job3, authority, runId: "run-d32c", correlationId: "corr-d32c", store, invoker: acceptingInvoker(),
  });
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job: job3, authority, currentState: dispatched3.state, now: "also-not-a-timestamp",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionEventError,
    "an invalid checkpoint occurredAt must fail before the control invoker is ever called",
  );
});

test("D33 (Rev158 F16, mandatory witness): concurrent PROGRESS and a terminal result racing for the same sequence slot cannot both durably occupy it", async () => {
  const job = freshJob("job-d33");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d33", correlationId: "corr-d33", store, invoker: acceptingInvoker(),
  });
  const preRaceSequence = dispatched.state.attempts.get(1)?.lastSequence ?? 0;
  await Promise.all([
    recordExecutionProgress({
      tenantScope, customer, project, job, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z", store, progressRef: "concurrent-progress",
    }),
    recordExecutionResult({
      tenantScope, customer, project, job, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z", type: "SUCCEEDED", store,
    }),
  ]);
  const finalAttempt = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d33")?.attempts.get(1);
  assert.equal(finalAttempt?.lastSequence, preRaceSequence + 1, "exactly one of the two racing events may durably occupy the next sequence slot");
  const progressWon = finalAttempt?.status === "RUNNING" && finalAttempt?.lastProgressRef === "concurrent-progress";
  const resultWon = finalAttempt?.status === "SUCCEEDED" && finalAttempt?.lastProgressRef === undefined;
  assert.equal(progressWon || resultWon, true, "final state must reflect exactly one winner, never a corrupted mix of both");
});

test("D34 (Rev158 F16, mandatory witness): a concurrent cancel and checkpoint request racing for the same sequence slot invoke at most one control effect total", async () => {
  const job = freshJob("job-d34");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d34", correlationId: "corr-d34", store, invoker: acceptingInvoker(),
  });
  const invoker = countingAcknowledgingControlInvoker("d34-checkpoint-ref");
  await Promise.all([
    requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: true }, reason: "x", store, controlInvoker: invoker,
    }),
    requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: dispatched.state, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
  ]);
  assert.equal(invoker.cancelCalls + invoker.checkpointCalls, 1, "only one control effect total may be invoked when cancel and checkpoint race for the same sequence slot");
});

test("D35 (Rev158 F17, mandatory witness): a pending cancel request left over from a crash before the control effect was ever invoked is safely recoverable via reconciliation", async () => {
  const job = freshJob("job-d35");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d35", correlationId: "corr-d35", store, invoker: acceptingInvoker(),
  });
  // Simulate a crash: a CANCEL_REQUESTED was durably claimed, but the
  // process died before ever calling the control invoker.
  const staleRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d35", correlationId: "corr-d35",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d35");
  assert.equal(stateAfterCrash?.attempts.get(1)?.pendingControlRequest?.controlRequestId, staleRequest.eventId);

  let reconcileCalledWith: unknown;
  const invoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    async requestCheckpoint() { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest(input) {
      reconcileCalledWith = input.controlRequestId;
      return { acknowledged: false }; // definitively: the prior request never took effect
    },
  };
  const result = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "retry", store, controlInvoker: invoker,
  });
  assert.equal(reconcileCalledWith, staleRequest.eventId, "reconciliation must target the exact prior pending request");
  assert.equal(invoker.cancelCalls, 1, "a definitively-not-happened prior request must allow exactly one fresh control invocation");
  assert.equal(result.attempts.get(1)?.status, "CANCELLED");
});

test("D36 (Rev158 F17, mandatory witness): a pending cancel request whose control effect may already have happened is completed via reconciliation without ever re-invoking the control operation", async () => {
  const job = freshJob("job-d36");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d36", correlationId: "corr-d36", store, invoker: acceptingInvoker(),
  });
  const staleRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d36", correlationId: "corr-d36",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d36");

  const invoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() {
      this.cancelCalls += 1;
      throw new Error("requestCancel must never be invoked - the prior effect may already have happened");
    },
    async requestCheckpoint() { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest() {
      return { acknowledged: true }; // definitively: the prior control effect DID already happen
    },
  };
  const result = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "retry", store, controlInvoker: invoker,
  });
  assert.equal(invoker.cancelCalls, 0, "a confirmed-already-happened prior request must never re-invoke the control operation");
  assert.equal(result.attempts.get(1)?.status, "CANCELLED");
});

test("D37 (Rev158 F17, mandatory witness): a pending control request that cannot be reconciled fails closed rather than fabricating a result or re-invoking", async () => {
  const job = freshJob("job-d37");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d37", correlationId: "corr-d37", store, invoker: acceptingInvoker(),
  });
  const staleRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d37", correlationId: "corr-d37",
    attempt: 1, sequence: 2, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z",
  });
  store.appendEvent(staleRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d37");
  const invoker: ControlOperationInvoker = {
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    reconcileControlRequest: async () => undefined,
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d37");
  assert.equal(finalState?.attempts.get(1)?.lastCheckpointRef, undefined, "no CHECKPOINT may have been durably recorded when reconciliation cannot determine the prior outcome");
});

test("D38 (Rev158 F17, mandatory witness): a malformed (non-boolean acknowledged) reconciliation result also fails closed, never treated as a determinate false", async () => {
  const job = freshJob("job-d38");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d38", correlationId: "corr-d38", store, invoker: acceptingInvoker(),
  });
  const staleRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d38", correlationId: "corr-d38",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first",
  });
  store.appendEvent(staleRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d38");
  const invoker: ControlOperationInvoker = {
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    reconcileControlRequest: async () => ({ acknowledged: "yes" as unknown as boolean }),
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "retry", store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
    "a malformed (non-boolean) acknowledged field must fail closed, never be treated as a determinate 'did not happen'",
  );
});

test("D39 (Rev161 F18, mandatory witness): a pending CANCEL_REQUESTED followed by a CHECKPOINT request with indeterminate reconciliation issues no checkpoint claim/effect, and the original cancel pending identity is preserved", async () => {
  const job = freshJob("job-d39");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d39", correlationId: "corr-d39", store, invoker: acceptingInvoker(),
  });
  const staleCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d39", correlationId: "corr-d39",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleCancelRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d39");

  let reconcileCalledWithKind: unknown;
  const invoker: ControlOperationInvoker = {
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked - the prior cross-kind request is unresolved"); },
    reconcileControlRequest: async (input) => {
      reconcileCalledWithKind = input.kind;
      return undefined; // indeterminate
    },
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
  assert.equal(reconcileCalledWithKind, "CANCEL", "reconciliation must target the ORIGINAL pending request's own kind, not the newly-requested one");
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d39");
  assert.deepEqual(finalState?.attempts.get(1)?.pendingControlRequest, {
    kind: "CANCEL_REQUESTED",
    controlRequestId: staleCancelRequest.eventId,
    reason: "first attempt",
  }, "the original cancel pending identity must be preserved exactly - never overwritten or lost");
});

test("D40 (Rev161 F18, mandatory witness): a pending CHECKPOINT_REQUESTED followed by a CANCEL request with indeterminate reconciliation issues no cancel claim/effect, and the original checkpoint pending identity is preserved", async () => {
  const job = freshJob("job-d40");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d40", correlationId: "corr-d40", store, invoker: acceptingInvoker(),
  });
  const staleCheckpointRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d40", correlationId: "corr-d40",
    attempt: 1, sequence: 2, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z",
  });
  store.appendEvent(staleCheckpointRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d40");

  let reconcileCalledWithKind: unknown;
  const invoker: ControlOperationInvoker = {
    requestCancel: async () => { throw new Error("requestCancel must never be invoked - the prior cross-kind request is unresolved"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    reconcileControlRequest: async (input) => {
      reconcileCalledWithKind = input.kind;
      return undefined; // indeterminate
    },
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "new cancel reason", store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
  assert.equal(reconcileCalledWithKind, "CHECKPOINT", "reconciliation must target the ORIGINAL pending request's own kind, not the newly-requested one");
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d40");
  assert.deepEqual(finalState?.attempts.get(1)?.pendingControlRequest, {
    kind: "CHECKPOINT_REQUESTED",
    controlRequestId: staleCheckpointRequest.eventId,
  }, "the original checkpoint pending identity must be preserved exactly - never overwritten or lost");
});

test("D41 (Rev161 F18, mandatory witness): a pending cancel that reconciles acknowledged=true then a checkpoint request - durable CANCELLED truth wins, checkpoint effect count remains zero", async () => {
  const job = freshJob("job-d41");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d41", correlationId: "corr-d41", store, invoker: acceptingInvoker(),
  });
  const staleCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d41", correlationId: "corr-d41",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleCancelRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d41");

  const invoker: ControlOperationInvoker & { checkpointCalls: number } = {
    checkpointCalls: 0,
    requestCancel: async () => { throw new Error("requestCancel must never be invoked - the prior request's own outcome must be reconciled, not re-invoked"); },
    async requestCheckpoint() { this.checkpointCalls += 1; return { acknowledged: true, checkpointRef: "should-never-be-used" }; },
    reconcileControlRequest: async (input) => (input.kind === "CANCEL" ? { acknowledged: true } : { acknowledged: false }),
  };
  const result = await requestExecutionCheckpoint({
    tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
  });
  assert.equal(result.attempts.get(1)?.status, "CANCELLED", "the original pending cancel's own true outcome must durably win");
  assert.equal(invoker.checkpointCalls, 0, "a confirmed prior cancel terminalizes the attempt - no checkpoint effect may then be invoked");
  assert.equal(result.attempts.get(1)?.pendingControlRequest, undefined);
});

test("D42 (Rev161 F18, mandatory witness): a pending checkpoint that reconciles acknowledged=true with a real checkpointRef then a cancel request - checkpoint evidence is durably recorded first, and only after fresh-state revalidation may the cancel path proceed under one-effect claim semantics", async () => {
  const job = freshJob("job-d42");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d42", correlationId: "corr-d42", store, invoker: acceptingInvoker(),
  });
  const staleCheckpointRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d42", correlationId: "corr-d42",
    attempt: 1, sequence: 2, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z",
  });
  store.appendEvent(staleCheckpointRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d42");

  const invoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked - the prior request's own outcome must be reconciled, not re-invoked"); },
    reconcileControlRequest: async (input) =>
      (input.kind === "CHECKPOINT" ? { acknowledged: true, checkpointRef: "real-checkpoint-ref" } : { acknowledged: false }),
  };
  const result = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "cancel after checkpoint", store, controlInvoker: invoker,
  });
  assert.equal(invoker.cancelCalls, 1, "exactly one fresh cancel effect may be invoked once the prior checkpoint is durably resolved and the attempt proven non-terminal");
  assert.equal(result.attempts.get(1)?.status, "CANCELLED");
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d42");
  assert.equal(finalState?.attempts.get(1)?.lastCheckpointRef, "real-checkpoint-ref", "the prior checkpoint's real evidence must be durably recorded, never discarded");
});

test("D43 (Rev161 F18, mandatory witness): a cross-kind prior request that reconciles acknowledged=false allows exactly one fresh requested effect, and restart/replay never resurrects the definitively-resolved prior request as unresolved", async () => {
  const job = freshJob("job-d43");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d43", correlationId: "corr-d43", store, invoker: acceptingInvoker(),
  });
  const staleCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d43", correlationId: "corr-d43",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleCancelRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d43");

  let reconcileCalledWithKind: unknown;
  let reconcileCalledWithControlRequestId: unknown;
  const invoker: ControlOperationInvoker & { checkpointCalls: number } = {
    checkpointCalls: 0,
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    async requestCheckpoint() { this.checkpointCalls += 1; return { acknowledged: true, checkpointRef: "fresh-ref" }; },
    reconcileControlRequest: async (input) => {
      reconcileCalledWithKind = input.kind;
      reconcileCalledWithControlRequestId = input.controlRequestId;
      return input.kind === "CANCEL" ? { acknowledged: false } : { acknowledged: true, checkpointRef: "x" };
    },
  };
  const result = await requestExecutionCheckpoint({
    tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
  });
  assert.equal(reconcileCalledWithKind, "CANCEL", "the ORIGINAL cross-kind pending request must actually be reconciled, never silently skipped merely because the newly-requested kind differs");
  assert.equal(reconcileCalledWithControlRequestId, staleCancelRequest.eventId);
  assert.equal(invoker.checkpointCalls, 1, "a definitively-not-happened prior cross-kind request must allow exactly one fresh requested effect");
  assert.equal(result.attempts.get(1)?.status, "RUNNING");
  assert.equal(result.attempts.get(1)?.lastCheckpointRef, "fresh-ref");

  // Restart/replay from the full durable log must not resurrect the
  // definitively-not-happened CANCEL_REQUESTED as an unresolved pending -
  // the fresh CHECKPOINT_REQUESTED/CHECKPOINT pair supersedes it entirely.
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d43");
  assert.equal(finalState?.attempts.get(1)?.pendingControlRequest, undefined);
});

test("D44 (Rev166 F19, mandatory witness): a positive cancel reconciliation whose resolving event loses its sequence slot to a concurrent PROGRESS event fails closed - the original pending cancel remains exactly, and no new control effect is invoked", async () => {
  const job = freshJob("job-d44");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d44", correlationId: "corr-d44", store, invoker: acceptingInvoker(),
  });
  const staleCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d44", correlationId: "corr-d44",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleCancelRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d44");

  const invoker: ControlOperationInvoker & { cancelCalls: number; checkpointCalls: number } = {
    cancelCalls: 0,
    checkpointCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    async requestCheckpoint() { this.checkpointCalls += 1; return { acknowledged: true, checkpointRef: "should-never-happen" }; },
    async reconcileControlRequest() {
      // Simulate a concurrent PROGRESS event winning the exact sequence slot
      // the resolving CANCELLED event is about to claim (both derive the
      // same eventId at this (attempt, sequence) coordinate since Rev158
      // F16 - the store's own atomic dedupe makes only one of them durable).
      const racingProgress = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d44", correlationId: "corr-d44",
        attempt: 1, sequence: 3, type: "PROGRESS", occurredAt: "2026-09-26T00:00:45.000Z",
      });
      store.appendEvent(racingProgress);
      return { acknowledged: true };
    },
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "retry", store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
    "a positive reconciliation whose durable resolution lost its slot must fail closed, never be treated as complete",
  );
  assert.equal(invoker.cancelCalls, 0, "the external cancel effect must never be re-invoked merely to obtain a durable resolution");
  assert.equal(invoker.checkpointCalls, 0);
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d44");
  assert.deepEqual(finalState?.attempts.get(1)?.pendingControlRequest, {
    kind: "CANCEL_REQUESTED",
    controlRequestId: staleCancelRequest.eventId,
    reason: "first attempt",
  }, "the original pending cancel must remain exactly as it was - never lost or fabricated as resolved");
  assert.equal(finalState?.attempts.get(1)?.status, "RUNNING");
});

test("D45 (Rev166 F19, mandatory witness): a positive checkpoint reconciliation whose resolving event loses its sequence slot to a concurrent PROGRESS event fails closed - the original pending checkpoint remains exactly, and no new control effect is invoked", async () => {
  const job = freshJob("job-d45");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d45", correlationId: "corr-d45", store, invoker: acceptingInvoker(),
  });
  const staleCheckpointRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d45", correlationId: "corr-d45",
    attempt: 1, sequence: 2, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z",
  });
  store.appendEvent(staleCheckpointRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d45");

  const invoker: ControlOperationInvoker & { cancelCalls: number; checkpointCalls: number } = {
    cancelCalls: 0,
    checkpointCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    async requestCheckpoint() { this.checkpointCalls += 1; return { acknowledged: true, checkpointRef: "should-never-happen" }; },
    async reconcileControlRequest() {
      const racingProgress = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d45", correlationId: "corr-d45",
        attempt: 1, sequence: 3, type: "PROGRESS", occurredAt: "2026-09-26T00:00:45.000Z",
      });
      store.appendEvent(racingProgress);
      return { acknowledged: true, checkpointRef: "real-ref" };
    },
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
  assert.equal(invoker.cancelCalls, 0);
  assert.equal(invoker.checkpointCalls, 0, "the external checkpoint effect must never be re-invoked merely to obtain a durable resolution");
  const finalState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d45");
  assert.deepEqual(finalState?.attempts.get(1)?.pendingControlRequest, {
    kind: "CHECKPOINT_REQUESTED",
    controlRequestId: staleCheckpointRequest.eventId,
  }, "the original pending checkpoint must remain exactly as it was - never lost or fabricated as resolved");
  assert.equal(finalState?.attempts.get(1)?.status, "RUNNING");
  assert.equal(finalState?.attempts.get(1)?.lastCheckpointRef, undefined, "the racing invoker's checkpointRef must never be durably recorded when the resolving event never won its slot");
});

test("D46 (Rev166 F19, mandatory witness): a terminal event winning the same race makes the pending cancel moot - current durable state itself proves the safe terminal disposition, and no new control effect is invoked", async () => {
  const job = freshJob("job-d46");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d46", correlationId: "corr-d46", store, invoker: acceptingInvoker(),
  });
  const staleCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d46", correlationId: "corr-d46",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(staleCancelRequest);
  const stateAfterCrash = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d46");

  const invoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest() {
      // A genuine, independent terminal outcome (e.g. the worker itself
      // reporting SUCCEEDED) wins the exact same slot our resolving
      // CANCELLED event is about to claim.
      const racingSucceeded = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d46", correlationId: "corr-d46",
        attempt: 1, sequence: 3, type: "SUCCEEDED", occurredAt: "2026-09-26T00:00:45.000Z",
      });
      store.appendEvent(racingSucceeded);
      return { acknowledged: true };
    },
  };
  const result = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: stateAfterCrash!, now: "2026-09-26T00:01:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "retry", store, controlInvoker: invoker,
  });
  assert.equal(invoker.cancelCalls, 0, "a genuine terminal winner must never trigger a re-invocation of the control effect");
  assert.equal(result.attempts.get(1)?.status, "SUCCEEDED", "current durable state's own genuine terminal truth must stand - never overwritten or second-guessed");
  assert.equal(result.attempts.get(1)?.pendingControlRequest, undefined);
});

test("D47 (Rev166 F19, bounded self-audit witness): a FRESH cancel whose confirmed control effect's resolving event loses its sequence slot to a concurrent PROGRESS event fails closed - the just-claimed pending cancel remains, and a retry never re-invokes the real control effect", async () => {
  const job = freshJob("job-d47");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d47", correlationId: "corr-d47", store, invoker: acceptingInvoker(),
  });
  const currentState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d47");

  const invoker: ControlOperationInvoker & { cancelCalls: number; reconcileCalls: number } = {
    cancelCalls: 0,
    reconcileCalls: 0,
    async requestCancel() {
      this.cancelCalls += 1;
      // The real external cancel effect genuinely happens here - but before
      // this resolves, a concurrent PROGRESS report wins the exact sequence
      // slot our own resolving CANCELLED event is about to target.
      const racingProgress = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d47", correlationId: "corr-d47",
        attempt: 1, sequence: 3, type: "PROGRESS", occurredAt: "2026-09-26T00:00:31.000Z",
      });
      store.appendEvent(racingProgress);
      return { acknowledged: true };
    },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest(input) {
      this.reconcileCalls += 1;
      return input.kind === "CANCEL" ? { acknowledged: true } : { acknowledged: false };
    },
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: currentState!, now: "2026-09-26T00:00:30.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "founder requested", store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
    "a genuinely-confirmed cancel effect whose durable record lost its slot must still fail closed, never be silently treated as complete",
  );
  assert.equal(invoker.cancelCalls, 1, "the real external cancel effect must have been invoked exactly once");
  const stateAfterRace = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d47");
  const pendingAfterRace = stateAfterRace?.attempts.get(1)?.pendingControlRequest;
  assert.equal(pendingAfterRace?.kind, "CANCEL_REQUESTED");
  assert.equal(pendingAfterRace?.reason, "founder requested");
  assert.equal(stateAfterRace?.attempts.get(1)?.status, "RUNNING");

  // A retry must reconcile the already-claimed pending request (durably
  // confirmed via `reconcileControlRequest`, not `requestCancel` again) and
  // this time durably record the resolution, since nothing else is racing.
  const retryResult = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: stateAfterRace!, now: "2026-09-26T00:00:40.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "founder requested retry", store, controlInvoker: invoker,
  });
  assert.equal(invoker.cancelCalls, 1, "a retry must never repeat the already-possibly-effectful external cancel operation");
  assert.equal(invoker.reconcileCalls, 1);
  assert.equal(retryResult.attempts.get(1)?.status, "CANCELLED");
  assert.equal(retryResult.attempts.get(1)?.pendingControlRequest, undefined);
});

test("D48 (Rev166 F19, bounded self-audit witness): a FRESH checkpoint whose confirmed control effect's resolving event loses its sequence slot to a concurrent PROGRESS event fails closed - the just-claimed pending checkpoint remains exactly, and the racing invoker's checkpointRef is never durably recorded", async () => {
  const job = freshJob("job-d48");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d48", correlationId: "corr-d48", store, invoker: acceptingInvoker(),
  });
  const currentState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d48");

  const invoker: ControlOperationInvoker & { checkpointCalls: number } = {
    checkpointCalls: 0,
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    async requestCheckpoint() {
      this.checkpointCalls += 1;
      // The real external checkpoint effect genuinely happens here - but
      // before this resolves, a concurrent PROGRESS report wins the exact
      // sequence slot our own resolving CHECKPOINT event is about to target.
      const racingProgress = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d48", correlationId: "corr-d48",
        attempt: 1, sequence: 3, type: "PROGRESS", occurredAt: "2026-09-26T00:00:31.000Z",
      });
      store.appendEvent(racingProgress);
      return { acknowledged: true, checkpointRef: "real-checkpoint-ref" };
    },
    reconcileControlRequest: async () => { throw new Error("reconcileControlRequest must never be invoked for this scenario"); },
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: currentState!, now: "2026-09-26T00:00:30.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
    "a genuinely-confirmed checkpoint effect whose durable record lost its slot must still fail closed, never be silently treated as complete",
  );
  assert.equal(invoker.checkpointCalls, 1, "the real external checkpoint effect must have been invoked exactly once");
  const stateAfterRace = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d48");
  const pendingAfterRace = stateAfterRace?.attempts.get(1)?.pendingControlRequest;
  assert.equal(pendingAfterRace?.kind, "CHECKPOINT_REQUESTED");
  assert.equal(stateAfterRace?.attempts.get(1)?.status, "RUNNING");
  assert.equal(stateAfterRace?.attempts.get(1)?.lastCheckpointRef, undefined, "the racing invoker's real checkpointRef must never be durably recorded when the resolving event never won its slot");
});

test("D49 (Rev167 F20, mandatory witness): pending P (cancel) determinately resolves false, but a DIFFERENT fresh pending Q (checkpoint) durably wins the slot in the same window - the checkpoint caller fails closed with zero effect, and a later cancel request R also invokes zero effect while Q remains pending", async () => {
  const job = freshJob("job-d49");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d49", correlationId: "corr-d49", store, invoker: acceptingInvoker(),
  });
  const pCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d49", correlationId: "corr-d49",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(pCancelRequest);
  const currentState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d49");

  let qCheckpointRequest: OutcomeJobExecutionEvent | undefined;
  const invoker: ControlOperationInvoker & { checkpointCalls: number } = {
    checkpointCalls: 0,
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    async requestCheckpoint() { this.checkpointCalls += 1; throw new Error("requestCheckpoint must never be invoked - P's own fate is still being determined and a different pending (Q) has taken over the slot"); },
    async reconcileControlRequest(input) {
      // While reconciling P (the cancel), an entirely different caller's
      // FRESH checkpoint request (Q) durably wins the exact slot P's own
      // resolution would have targeted.
      qCheckpointRequest = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d49", correlationId: "corr-d49",
        attempt: 1, sequence: 3, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:31.000Z",
      });
      store.appendEvent(qCheckpointRequest);
      assert.equal(input.kind, "CANCEL");
      return { acknowledged: false }; // P determinately did NOT happen
    },
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: currentState!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
    "a different, genuinely NEW pending (Q) superseding the original (P) must still fail closed - non-terminal current state alone is not enough to proceed",
  );
  assert.equal(invoker.checkpointCalls, 0, "no control effect may be invoked while Q is the current unresolved pending");
  const stateWithQPending = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d49");
  assert.deepEqual(stateWithQPending?.attempts.get(1)?.pendingControlRequest, {
    kind: "CHECKPOINT_REQUESTED",
    controlRequestId: qCheckpointRequest!.eventId,
  }, "current durable pending truth must be Q, exactly - not P, not cleared, not fabricated");

  // A later, unrelated cancel request R must also invoke zero effect while Q
  // remains the current unresolved pending - this is the ordinary any-kind
  // reconciliation mechanism (F18/F19), now correctly reached because Q is
  // visible to R's own request rather than silently skipped.
  const rInvoker: ControlOperationInvoker = {
    requestCancel: async () => { throw new Error("requestCancel must never be invoked while Q is unresolved"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest(input) {
      assert.equal(input.kind, "CHECKPOINT");
      assert.equal(input.controlRequestId, qCheckpointRequest!.eventId);
      return undefined; // indeterminate - R must still fail closed
    },
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: stateWithQPending!, now: "2026-09-26T00:02:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "R's own reason", store, controlInvoker: rInvoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
});

test("D50 (Rev167 F20, mandatory witness): symmetric direction - pending P (checkpoint) determinately resolves false, but a DIFFERENT fresh pending Q (cancel) durably wins the slot in the same window - the cancel caller fails closed with zero effect", async () => {
  const job = freshJob("job-d50");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d50", correlationId: "corr-d50", store, invoker: acceptingInvoker(),
  });
  const pCheckpointRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d50", correlationId: "corr-d50",
    attempt: 1, sequence: 2, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z",
  });
  store.appendEvent(pCheckpointRequest);
  const currentState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d50");

  let qCancelRequest: OutcomeJobExecutionEvent | undefined;
  const invoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() { this.cancelCalls += 1; throw new Error("requestCancel must never be invoked - a different pending (Q) has taken over the slot"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest(input) {
      qCancelRequest = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d50", correlationId: "corr-d50",
        attempt: 1, sequence: 3, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:31.000Z", reason: "Q's own reason",
      });
      store.appendEvent(qCancelRequest);
      assert.equal(input.kind, "CHECKPOINT");
      return { acknowledged: false }; // P determinately did NOT happen
    },
  };
  await assert.rejects(
    () => requestExecutionCancellation({
      tenantScope, customer, project, job, authority, currentState: currentState!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "caller's own reason", store, controlInvoker: invoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
  assert.equal(invoker.cancelCalls, 0, "no control effect may be invoked while Q is the current unresolved pending");
  const stateWithQPending = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d50");
  assert.deepEqual(stateWithQPending?.attempts.get(1)?.pendingControlRequest, {
    kind: "CANCEL_REQUESTED",
    controlRequestId: qCancelRequest!.eventId,
    reason: "Q's own reason",
  }, "current durable pending truth must be Q, exactly");
});

test("D51 (Rev167 F20, mandatory witness): once the superseding pending Q is determinately resolved/cleared, a subsequent eligible control operation can proceed exactly once", async () => {
  const job = freshJob("job-d51");
  const store = new InMemoryExecutionEventStore();
  await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d51", correlationId: "corr-d51", store, invoker: acceptingInvoker(),
  });
  const pCancelRequest = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d51", correlationId: "corr-d51",
    attempt: 1, sequence: 2, type: "CANCEL_REQUESTED", occurredAt: "2026-09-26T00:00:30.000Z", reason: "first attempt",
  });
  store.appendEvent(pCancelRequest);
  const currentState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d51");

  let qCheckpointRequest: OutcomeJobExecutionEvent | undefined;
  const racingInvoker: ControlOperationInvoker = {
    requestCancel: async () => { throw new Error("requestCancel must never be invoked for this scenario"); },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest() {
      qCheckpointRequest = createOutcomeJobExecutionEvent({
        tenantScope, customer, project, job, runId: "run-d51", correlationId: "corr-d51",
        attempt: 1, sequence: 3, type: "CHECKPOINT_REQUESTED", occurredAt: "2026-09-26T00:00:31.000Z",
      });
      store.appendEvent(qCheckpointRequest);
      return { acknowledged: false };
    },
  };
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job, authority, currentState: currentState!, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: racingInvoker,
    }),
    PendingControlOperationReconciliationRequiredError,
  );
  const stateWithQPending = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d51");
  assert.equal(stateWithQPending?.attempts.get(1)?.pendingControlRequest?.controlRequestId, qCheckpointRequest!.eventId);

  // Now Q is genuinely, determinately resolved (acknowledged true, with real
  // checkpoint evidence) - nothing else races this time. A subsequent
  // eligible cancel request must then proceed and invoke its own control
  // effect exactly once.
  const resolvingInvoker: ControlOperationInvoker & { cancelCalls: number } = {
    cancelCalls: 0,
    async requestCancel() { this.cancelCalls += 1; return { acknowledged: true }; },
    requestCheckpoint: async () => { throw new Error("requestCheckpoint must never be invoked for this scenario"); },
    async reconcileControlRequest(input) {
      assert.equal(input.kind, "CHECKPOINT");
      assert.equal(input.controlRequestId, qCheckpointRequest!.eventId);
      return { acknowledged: true, checkpointRef: "q-resolved-ref" };
    },
  };
  const finalResult = await requestExecutionCancellation({
    tenantScope, customer, project, job, authority, currentState: stateWithQPending!, now: "2026-09-26T00:02:00.000Z",
    capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "subsequent cancel", store, controlInvoker: resolvingInvoker,
  });
  assert.equal(resolvingInvoker.cancelCalls, 1, "the subsequent eligible cancel must proceed and invoke its own effect exactly once");
  assert.equal(finalResult.attempts.get(1)?.status, "CANCELLED");
  assert.equal(finalResult.attempts.get(1)?.lastCheckpointRef, "q-resolved-ref", "Q's own genuine resolution evidence must be durably preserved");
  assert.equal(finalResult.attempts.get(1)?.pendingControlRequest, undefined);
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
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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
      tenantScope, customer, project, job: jobA, authority, currentState: forgedState, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: true, supportsCheckpoint: false }, reason: "x", store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => requestExecutionCheckpoint({
      tenantScope, customer, project, job: jobA, authority, currentState: forgedState, now: "2026-09-26T00:01:00.000Z",
      capabilities: { supportsCancel: false, supportsCheckpoint: true }, store, controlInvoker: neverCallControlInvoker(),
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );
  await assert.rejects(
    () => retryOutcomeJobExecutionAttempt({
      tenantScope, customer, project, job: jobA, authority, currentState: forgedState,
      now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
      expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
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

test("D19 (Rev146 F5): re-dispatching an existing run with a different correlationId fails closed, and the run's durable log survives undamaged", async () => {
  const job = freshJob("job-d19");
  const store = new InMemoryExecutionEventStore();
  const first = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d19", correlationId: "corr-d19-original", store, invoker: acceptingInvoker(),
  });
  assert.equal(first.state.status, "RUNNING");

  await assert.rejects(
    () => dispatchOutcomeJobExecutionRun({
      ...baseDispatch, job, authority, runId: "run-d19", correlationId: "corr-d19-DIFFERENT", store, invoker: acceptingInvoker(),
    }),
    InvalidOutcomeJobExecutionRuntimeError,
  );

  // The mismatched re-dispatch must never have appended anything - the run's
  // own log/state is still exactly what it was before the rejected call.
  const stillReadable = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d19");
  assert.equal(stillReadable?.correlationId, "corr-d19-original");
  assert.equal(stillReadable?.status, "RUNNING");
});

test("D20 (Rev146 F6): a pre-seeded ACCEPTED-only run (simulating a crash before ATTEMPT_STARTED became durable) is recovered by a later dispatch call, which invokes exactly once", async () => {
  const job = freshJob("job-d20");
  const store = new InMemoryExecutionEventStore();
  // Simulate the crash window directly: only ACCEPTED is durable, never
  // ATTEMPT_STARTED - exactly what Rev146 F6 describes as a process death
  // between the two appends inside dispatchOutcomeJobExecutionRun.
  const preSeededAccepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d20", correlationId: "corr-d20",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  store.appendEvent(preSeededAccepted);
  const strandedState = store.getState(tenantScope.tenantId, customer.customerId, project.projectId, job.jobId, "run-d20");
  assert.equal(strandedState?.status, "ACCEPTED");
  assert.equal(strandedState?.currentAttempt, 0);

  let invokeCount = 0;
  const invoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      invokeCount += 1;
      return { accepted: true };
    },
  };
  const recovered = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d20", correlationId: "corr-d20", store, invoker,
  });
  assert.equal(invokeCount, 1, "the recovery dispatch must actually invoke the worker exactly once");
  assert.equal(recovered.invoked, true);
  assert.equal(recovered.state.status, "RUNNING");
  assert.equal(recovered.state.currentAttempt, 1);
});

test("D21 (Rev146 F6): two concurrent recovery dispatch calls against the same ACCEPTED-only run still only invoke the worker once", async () => {
  const job = freshJob("job-d21");
  const store = new InMemoryExecutionEventStore();
  const preSeededAccepted = createOutcomeJobExecutionEvent({
    tenantScope, customer, project, job, runId: "run-d21", correlationId: "corr-d21",
    attempt: 1, sequence: 1, type: "ACCEPTED", occurredAt: "2026-09-26T00:00:00.000Z",
  });
  store.appendEvent(preSeededAccepted);

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
      ...baseDispatch, job, authority, runId: "run-d21", correlationId: "corr-d21", store, invoker,
    });
  const [resultA, resultB] = await Promise.all([callOnce(), callOnce()]);
  assert.equal(invokeCount, 1, "exactly one concurrent recovery caller must actually invoke the worker");
  assert.deepEqual([resultA.invoked, resultB.invoked].sort(), [false, true]);
});

test("D22 (Rev146 F6): re-dispatching an already fully-progressed run (past attempt 1) remains a pure no-op that never re-invokes", async () => {
  const job = freshJob("job-d22");
  const store = new InMemoryExecutionEventStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d22", correlationId: "corr-d22", store, invoker: rejectingInvoker(),
  });
  assert.equal(dispatched.state.status, "FAILED");
  const retried = await retryOutcomeJobExecutionAttempt({
    tenantScope, customer, project, job, authority, currentState: dispatched.state,
    now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
    expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
      quotaAdmission: sharedQuotaAdmission, quotaEnvelope, currentQuotaSourceFingerprint: "qfp-1",
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
    store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
  });
  assert.equal(retried.state.currentAttempt, 2);

  let invokeCount = 0;
  const invoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      invokeCount += 1;
      return { accepted: true };
    },
  };
  const redispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-d22", correlationId: "corr-d22", store, invoker,
  });
  assert.equal(invokeCount, 0, "a re-dispatch of an already-progressed run must never re-invoke");
  assert.equal(redispatched.invoked, false);
  assert.equal(redispatched.state.currentAttempt, 2, "re-dispatch must not disturb the real current attempt");
});

// ---------------------------------------------------------------------------
// OS-V0-07 (Rev174, Usage/Cost/Quota Guardrails) integration witnesses.
// ---------------------------------------------------------------------------

test("QI1 (G1/G3, #8): a REJECTED quota admission never invokes the worker - the attempt is recorded BLOCKED instead, and remains retryable", async () => {
  const job = freshJob("job-qi1");
  const store = new InMemoryExecutionEventStore();
  const { store: quota, envelope: smallEnvelope } = smallLimitQuota(50);
  let invoked = false;
  const invoker: WorkerInvoker = { role: "CLAUDE_PRIMARY_ENGINEER", invoke: async () => { invoked = true; return { accepted: true }; } };
  const result = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-qi1", correlationId: "corr-qi1", store, invoker,
    quotaAdmission: quota, quotaEnvelope: smallEnvelope,
    estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
  });
  assert.equal(invoked, false, "the worker must never be invoked when quota admission is rejected");
  assert.equal(result.invoked, false);
  assert.equal(result.state.status, "BLOCKED");
  assert.equal(result.state.attempts.get(1)?.reason, "insufficient allowance remaining under the current envelope limit");
});

test("QI2 (Design D, #5): a retry re-admits under current quota and is BLOCKED exactly like a fresh dispatch when the allowance is exhausted - fallback/retry cannot bypass the ceiling", async () => {
  const job = freshJob("job-qi2");
  const store = new InMemoryExecutionEventStore();
  const { store: quota, envelope: smallEnvelope } = smallLimitQuota(100);
  // Attempt 1 consumes the entire allowance and fails (retryable).
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-qi2", correlationId: "corr-qi2", store, invoker: rejectingInvoker(),
    quotaAdmission: quota, quotaEnvelope: smallEnvelope,
    estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
  });
  assert.equal(dispatched.state.status, "FAILED");

  // Retry (attempt 2) re-admits under the SAME now-exhausted envelope and is
  // BLOCKED - it never bypasses the ceiling merely by being a retry/fallback.
  const retried = await retryOutcomeJobExecutionAttempt({
    tenantScope, customer, project, job, authority, currentState: dispatched.state,
    now: "2026-09-26T00:01:00.000Z", executorKind: "INJECTED",
    expectedFingerprint: "fp-1", currentFingerprint: "fp-1",
    quotaAdmission: quota, quotaEnvelope: smallEnvelope, currentQuotaSourceFingerprint: "qfp-1",
    estimatedCost: { presence: "REPORTED", amountMinorUnits: 100, currency: "USD" },
    store, invoker: acceptingInvoker(), taskId: "task-1", branch: "b", checkpointSha: "sha-2",
  });
  assert.equal(retried.invoked, false);
  assert.equal(retried.state.status, "BLOCKED");
  assert.equal(retried.state.currentAttempt, 2);
});

test("QI3 (G5/G6, #10): a rejected/failed invocation still commits attributable usage once, as UNKNOWN - it is never discarded merely because the business effect failed", async () => {
  const job = freshJob("job-qi3");
  const store = new InMemoryExecutionEventStore();
  const quota = new InMemoryQuotaAdmissionStore();
  const dispatched = await dispatchOutcomeJobExecutionRun({
    ...baseDispatch, job, authority, runId: "run-qi3", correlationId: "corr-qi3", store, invoker: rejectingInvoker(),
    quotaAdmission: quota,
  });
  assert.equal(dispatched.state.status, "FAILED");

  const committedEvent = quota.ledgerSnapshot().events.find((e) => e.type === "COMMITTED");
  assert.ok(committedEvent, "actual usage must be committed even though the invocation itself failed");
  assert.equal(committedEvent?.amount?.presence, "UNKNOWN", "the activated WorkerInvoker reports no real usage - the commit must be honestly UNKNOWN, never a fabricated echo of the estimate");
});

test("QI4 (Minimum Adversarial Evidence #15): authority/permission failures never reach quota admission at all - budget is strictly lower priority than authority", async () => {
  const job = freshJob("job-qi4");
  const store = new InMemoryExecutionEventStore();
  const readOnlyAuthority: AuthorityContext = createAuthorityContext({
    tenantScope, permissions: ["READ"], canPerformProtectedActions: false,
  });
  await assert.rejects(
    () =>
      dispatchOutcomeJobExecutionRun({
        ...baseDispatch, job, authority: readOnlyAuthority, runId: "run-qi4", correlationId: "corr-qi4", store, invoker: acceptingInvoker(),
        quotaAdmission: new NeverCalledQuotaAdmission(),
      }),
    InsufficientAuthorityError,
  );
});

test("QI5 (#7): a stale quota envelope blocks admission before any invocation - envelope currentness is checked using the caller's freshly-supplied fingerprint, never a cached one", async () => {
  const job = freshJob("job-qi5");
  const store = new InMemoryExecutionEventStore();
  const quota = new InMemoryQuotaAdmissionStore();
  let invoked = false;
  const invoker: WorkerInvoker = { role: "CLAUDE_PRIMARY_ENGINEER", invoke: async () => { invoked = true; return { accepted: true }; } };
  await assert.rejects(
    () =>
      dispatchOutcomeJobExecutionRun({
        ...baseDispatch, job, authority, runId: "run-qi5", correlationId: "corr-qi5", store, invoker,
        quotaAdmission: quota, currentQuotaSourceFingerprint: "qfp-STALE",
      }),
    StaleQuotaEnvelopeError,
  );
  assert.equal(invoked, false);
});
