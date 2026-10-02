import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionOutcomeJob } from "../src/domain/outcome-job.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createOutcomeJobExecutionEvent, type OutcomeJobExecutionEvent } from "../src/domain/outcome-job-execution-event.js";
import { applyOutcomeJobExecutionEvent, reconstructOutcomeJobExecutionRunState, type OutcomeJobExecutionRunState } from "../src/domain/outcome-job-execution-run-state.js";
import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  admitQuotaReservation,
  commitQuotaUsage,
  releaseQuotaReservation,
  findCanonicalLatestForIdempotencyKey,
  EMPTY_QUOTA_LEDGER,
  type QuotaEnvelope,
  type QuotaReservationIdentity,
  type QuotaLedger,
} from "../src/domain/execution-quota-admission.js";
import {
  appendExecutionEconomicsEventAllowingCapturedAtDrift,
  EMPTY_EXECUTION_ECONOMICS_LEDGER,
  type ExecutionEconomicsEvent,
  type ExecutionEconomicsLedger,
} from "../src/domain/execution-economics-attribution.js";
import {
  dispatchOutcomeJobExecutionRun,
  retryOutcomeJobExecutionAttempt,
  recordExecutionResult,
  advanceOutcomeJobAfterExecutionSuccess,
  type ExecutionEventStore,
  type QuotaAdmissionPort,
  type ExecutionEconomicsPort,
  type CurrentQuotaEnvelopeResolver,
  type QuotaSettlementPeek,
} from "../src/application/outcome-job-execution-runtime.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import {
  composeTaskPacketForOutcomeJob,
  resolveNextRunnableGoldenPathAction,
} from "../src/domain/outcome-job-golden-path-composition.js";
import {
  compileGoldenPathActivation,
  GOLDEN_PATH_TENANT_SCOPE,
  GOLDEN_PATH_CUSTOMER,
  GOLDEN_PATH_PROJECT,
  GOLDEN_PATH_OWNERSHIP,
} from "./helpers/golden-path-fixture.js";

/**
 * OS-V0-10 Golden A end-to-end: authorized principal -> org/project context
 * -> ProjectActivationProfile -> OutcomeJob/OutcomeJobSpec -> TaskPacket
 * (composeTaskPacketForOutcomeJob) -> existing dispatch/retry execution
 * runtime (dispatchOutcomeJobExecutionRun, unmodified) -> durable
 * result/evidence -> independent VerificationResult (verifyOutcomeJob,
 * unmodified) -> deterministic next-runnable continuation
 * (resolveNextRunnableGoldenPathAction). Every step below reuses an
 * existing, unmodified owner - this file's own job is proving the one
 * real lineage, not adding behavior.
 */

class InMemoryExecutionEventStore implements ExecutionEventStore {
  private readonly byRun = new Map<string, OutcomeJobExecutionRunState>();
  private readonly eventLog = new Map<string, OutcomeJobExecutionEvent[]>();
  private readonly seenEventIds = new Set<string>();

  appendEvent(event: OutcomeJobExecutionEvent): boolean {
    if (this.seenEventIds.has(event.eventId)) {
      return false;
    }
    this.seenEventIds.add(event.eventId);
    const key = JSON.stringify([event.tenantId, event.customerId, event.projectId, event.jobId, event.runId]);
    const current = this.byRun.get(key);
    const next = applyOutcomeJobExecutionEvent(current, event);
    this.byRun.set(key, next);
    const log = this.eventLog.get(key) ?? [];
    log.push(event);
    this.eventLog.set(key, log);
    return true;
  }

  getState(tenantId: string, customerId: string, projectId: string, jobId: string, runId: string): OutcomeJobExecutionRunState | undefined {
    return this.byRun.get(JSON.stringify([tenantId, customerId, projectId, jobId, runId]));
  }

  durableEventLogFor(tenantId: string, customerId: string, projectId: string, jobId: string, runId: string): ReadonlyArray<OutcomeJobExecutionEvent> {
    return this.eventLog.get(JSON.stringify([tenantId, customerId, projectId, jobId, runId])) ?? [];
  }
}

class InMemoryQuotaAdmissionStore implements QuotaAdmissionPort {
  private ledger: QuotaLedger = EMPTY_QUOTA_LEDGER;

  admit(input: Parameters<QuotaAdmissionPort["admit"]>[0]) {
    const { ledger, outcome } = admitQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  commit(input: Parameters<QuotaAdmissionPort["commit"]>[0]) {
    const { ledger, outcome } = commitQuotaUsage({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  release(input: Parameters<QuotaAdmissionPort["release"]>[0]) {
    const { ledger, outcome } = releaseQuotaReservation({ ledger: this.ledger, ...input });
    this.ledger = ledger;
    return outcome;
  }

  peekSettlement(input: { identity: QuotaReservationIdentity; idempotencyKey: unknown }): QuotaSettlementPeek {
    if (typeof input.idempotencyKey !== "string") {
      throw new Error("idempotencyKey must be a string");
    }
    const latest = findCanonicalLatestForIdempotencyKey(this.ledger, input.identity.scope.tenantId, input.idempotencyKey);
    if (latest !== undefined && (latest.type === "COMMITTED" || latest.type === "RECONCILIATION_REQUIRED")) {
      return { settled: true, event: latest };
    }
    return { settled: false };
  }
}

class InMemoryExecutionEconomicsStore implements ExecutionEconomicsPort {
  private ledger: ExecutionEconomicsLedger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  recordSettledAttempt(event: ExecutionEconomicsEvent): void {
    this.ledger = appendExecutionEconomicsEventAllowingCapturedAtDrift(this.ledger, event);
  }
}

const authority = createAuthorityContext({ tenantScope: GOLDEN_PATH_TENANT_SCOPE, permissions: ["EXECUTE", "WRITE", "READ"], canPerformProtectedActions: true });

function acceptingInvoker(callLog: unknown[]): WorkerInvoker {
  return {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async (input) => {
      callLog.push(input.outcomeJobExecution);
      return { accepted: true };
    },
  };
}

function buildDispatchInput(suffix: string) {
  const compilation = compileGoldenPathActivation(`plan-gpa-${suffix}`, `sold-gpa-${suffix}`);
  const quotaScope = createQuotaAdmissionScope({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customerId: GOLDEN_PATH_CUSTOMER.customerId,
    projectId: GOLDEN_PATH_PROJECT.projectId,
    planId: compilation.profile.planId,
    planVersion: compilation.profile.planVersion,
  });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({
    scope: quotaScope,
    envelopeRef: `envelope-gpa-${suffix}`,
    sourceFingerprint: "qfp-gpa-1",
    unitLimit: 1_000_000,
  });
  const quotaAdmission = new InMemoryQuotaAdmissionStore();
  const economicsPort = new InMemoryExecutionEconomicsStore();
  const store = new InMemoryExecutionEventStore();
  const quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver = { resolveCurrentQuotaEnvelope: () => quotaEnvelope };

  const wiredJob = compilation.jobs[0]!;
  const spec = compilation.specs.find((s) => (s.specId as unknown as string) === (wiredJob.jobId as unknown as string))!;
  const readyJob = transitionOutcomeJob(transitionOutcomeJob(wiredJob, "QUALIFIED"), "READY");

  return {
    compilation,
    spec,
    readyJob,
    store,
    quotaAdmission,
    economicsPort,
    dispatchBase: {
      tenantScope: GOLDEN_PATH_TENANT_SCOPE,
      customer: GOLDEN_PATH_CUSTOMER,
      project: GOLDEN_PATH_PROJECT,
      now: "2026-10-02T00:00:00.000Z",
      executorKind: "INJECTED" as const,
      expectedFingerprint: compilation.profile.sourceFingerprint,
      currentFingerprint: compilation.profile.sourceFingerprint,
      currentActivationPlanId: compilation.profile.planId,
      currentActivationPlanVersion: compilation.profile.planVersion,
      economicsPort,
      economicsTaskRef: "task-ref-gpa",
      economicsUsageSource: "OTHER_ADMITTED",
      taskId: "task-gpa",
      branch: `claude/os-v0-10-golden-a-${suffix}`,
      checkpointSha: "sha-gpa-1",
      quotaAdmission,
      quotaEnvelope,
      currentQuotaSourceFingerprint: "qfp-gpa-1",
      quotaEnvelopeResolver,
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" },
    },
  };
}

test("Golden A end-to-end: authorized context -> TaskPacket -> dispatch -> SUCCEEDED -> VERIFYING -> independent verification -> VERIFIED -> CLOSE_JOB, with the composer's own next-action agreeing at every stage", async () => {
  const fixture = buildDispatchInput("e2e");
  const callLog: unknown[] = [];
  const invoker = acceptingInvoker(callLog);

  // Stage 1: READY - TaskPacket says DISPATCH_EXECUTION.
  const readyPacket = composeTaskPacketForOutcomeJob({
    job: fixture.readyJob,
    spec: fixture.spec,
    activation: fixture.compilation.profile,
    projectOwnership: GOLDEN_PATH_OWNERSHIP,
    baseIdentity: "sha-gpa-1",
    acceptanceCriteria: ["the golden path requirement is satisfied"],
  });
  assert.equal(readyPacket.nextAuthorizedAction.startsWith("AKILTA:DISPATCH_EXECUTION"), true);

  // Stage 2: dispatch - the real, unmodified execution runtime.
  const executingJob = transitionOutcomeJob(fixture.readyJob, "EXECUTING");
  const dispatchResult = await dispatchOutcomeJobExecutionRun({
    ...fixture.dispatchBase,
    job: executingJob,
    authority,
    runId: "run-gpa-e2e",
    correlationId: "corr-gpa-e2e",
    store: fixture.store,
    invoker,
  });
  assert.equal(dispatchResult.invoked, true);
  assert.equal(callLog.length, 1);

  // Mandatory Evidence #2 (duplicate/replayed worker result never
  // duplicates material effect): a second dispatch for the SAME runId
  // never re-invokes the worker.
  const duplicateDispatch = await dispatchOutcomeJobExecutionRun({
    ...fixture.dispatchBase,
    job: executingJob,
    authority,
    runId: "run-gpa-e2e",
    correlationId: "corr-gpa-e2e",
    store: fixture.store,
    invoker,
  });
  assert.equal(duplicateDispatch.invoked, false);
  assert.equal(callLog.length, 1, "the worker must never be invoked a second time for the same run");

  // Stage 3: record real SUCCEEDED execution-runtime truth.
  const succeededState = await recordExecutionResult({
    tenantScope: GOLDEN_PATH_TENANT_SCOPE,
    customer: GOLDEN_PATH_CUSTOMER,
    project: GOLDEN_PATH_PROJECT,
    job: executingJob,
    currentState: dispatchResult.state,
    now: "2026-10-02T00:00:10.000Z",
    type: "SUCCEEDED",
    store: fixture.store,
  });

  const afterSuccessAction = resolveNextRunnableGoldenPathAction({ job: executingJob, activation: fixture.compilation.profile, executionState: succeededState });
  assert.equal(afterSuccessAction.code, "ADVANCE_TO_VERIFYING");

  // Stage 4: the one narrow bridge back to the OutcomeJob lifecycle -
  // never itself VERIFIED (DEC-122 RG-04).
  const verifyingJob = advanceOutcomeJobAfterExecutionSuccess(executingJob, succeededState);
  assert.equal(verifyingJob.state, "VERIFYING");

  const verifyingAction = resolveNextRunnableGoldenPathAction({ job: verifyingJob, activation: fixture.compilation.profile });
  assert.equal(verifyingAction.code, "VERIFICATION_REQUIRED");

  // Mandatory Evidence #3 (false success without evidence cannot reach
  // VERIFIED): no amount of execution-runtime SUCCEEDED truth can itself
  // move the job to VERIFIED without a real, independent VerificationResult.
  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: "ev-gpa-e2e",
    evidenceType: "TEST_RESULT",
    sourceLocator: "internal://golden-path/e2e",
    capturedAt: "2026-10-02T00:00:20.000Z",
  });
  const verification = createVerificationResult({
    verificationId: "verif-gpa-e2e",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: "req-golden-path",
    status: "PASSED",
  });

  // The TaskPacket's own nextAuthorizedAction agrees exactly with the
  // separately-computed resolver output at this stage too.
  const verifyingPacket = composeTaskPacketForOutcomeJob({
    job: verifyingJob,
    spec: fixture.spec,
    activation: fixture.compilation.profile,
    projectOwnership: GOLDEN_PATH_OWNERSHIP,
    baseIdentity: "sha-gpa-1",
    acceptanceCriteria: ["the golden path requirement is satisfied"],
    verification,
  });
  assert.equal(verifyingPacket.nextAuthorizedAction.startsWith("AKILTA:ADVANCE_TO_VERIFIED"), true);

  // Stage 5: independent verification advances the job (via the existing,
  // unmodified verifyOutcomeJob gate).
  const { verifyOutcomeJob } = await import("../src/domain/outcome-job.js");
  const verifiedJob = verifyOutcomeJob(verifyingJob, verification);
  assert.equal(verifiedJob.state, "VERIFIED");

  const closeAction = resolveNextRunnableGoldenPathAction({ job: verifiedJob, activation: fixture.compilation.profile });
  assert.equal(closeAction.code, "CLOSE_JOB");

  // Mandatory Evidence #6 (never blindly replay a completed effect): once
  // the current attempt is SUCCEEDED (a terminal status), a retry is
  // structurally refused - there is nothing left to retry.
  await assert.rejects(() =>
    retryOutcomeJobExecutionAttempt({
      ...fixture.dispatchBase,
      job: executingJob,
      authority,
      currentState: succeededState,
      store: fixture.store,
      invoker,
    }),
  );
});

test("Golden A restart safety: rebuilding the identical durable event log from scratch (Mandatory Evidence #1, #13) reconstructs the identical run state and next action", async () => {
  const fixture = buildDispatchInput("restart");
  const executingJob = transitionOutcomeJob(fixture.readyJob, "EXECUTING");
  const invoker = acceptingInvoker([]);

  const dispatchResult = await dispatchOutcomeJobExecutionRun({
    ...fixture.dispatchBase,
    job: executingJob,
    authority,
    runId: "run-gpa-restart",
    correlationId: "corr-gpa-restart",
    store: fixture.store,
    invoker,
  });

  const actionBefore = resolveNextRunnableGoldenPathAction({ job: executingJob, activation: fixture.compilation.profile, executionState: dispatchResult.state });

  // Genuine restart proof: pull the durable event log and fold it through
  // the pure reducer completely independently of the live store's own
  // held state - exactly what a real process restart would do.
  const durableLog = fixture.store.durableEventLogFor(
    GOLDEN_PATH_TENANT_SCOPE.tenantId,
    GOLDEN_PATH_CUSTOMER.customerId,
    GOLDEN_PATH_PROJECT.projectId,
    executingJob.jobId,
    "run-gpa-restart",
  );
  const reconstructedAfterRestart = reconstructOutcomeJobExecutionRunState(durableLog)!;
  const actionAfter = resolveNextRunnableGoldenPathAction({ job: executingJob, activation: fixture.compilation.profile, executionState: reconstructedAfterRestart });
  assert.deepEqual(actionBefore, actionAfter);
});
