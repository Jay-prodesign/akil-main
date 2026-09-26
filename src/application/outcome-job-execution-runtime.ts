import type { TenantScope } from "../domain/tenant-scope.js";
import type { Customer } from "../domain/customer.js";
import type { Project } from "../domain/project.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import { transitionOutcomeJob } from "../domain/outcome-job.js";
import {
  createOutcomeJobExecutionEvent,
  type OutcomeJobExecutionEvent,
  type OutcomeJobExecutionEventType,
} from "../domain/outcome-job-execution-event.js";
import type { OutcomeJobExecutionRunState } from "../domain/outcome-job-execution-run-state.js";
import type { AuthorityContext } from "../domain/authority.js";
import { requireSameTenant, requirePermission, requireProtectedActionAuthorization } from "../domain/authority.js";
import { invokeSafely, type WorkerInvoker, type InvokeOutcome } from "../domain/worker-invoker.js";

export class InvalidOutcomeJobExecutionRuntimeError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJob execution runtime operation: ${reason}`);
    this.name = "InvalidOutcomeJobExecutionRuntimeError";
  }
}

/**
 * Package Contract I: "at every dispatch/retry and before any material
 * effect ... consume current authority and current resolver-produced
 * activation/config truth rather than trusting a queued stale snapshot. A
 * changed material ProjectActivationProfile sourceFingerprint must block/
 * reconcile the stale run before effect." Thrown before any event is ever
 * appended or the worker is ever invoked - a stale dispatch/retry has zero
 * durable side effect (Minimum Adversarial Evidence #11).
 */
export class StaleActivationFingerprintError extends Error {
  constructor(expected: string, current: string) {
    super(
      `activation fingerprint is stale (expected "${expected}", current is "${current}") - dispatch/retry blocked before any effect`,
    );
    this.name = "StaleActivationFingerprintError";
  }
}

/**
 * Package Contract H/Minimum Adversarial Evidence #10: "UNKNOWN cannot be
 * blindly retried or converted to success." Thrown when a caller attempts to
 * retry an attempt whose last known status is UNKNOWN without an explicit
 * protected-action-authorized override.
 */
export class UnauthorizedUnknownRetryError extends Error {
  constructor() {
    super(
      "an attempt whose outcome is UNKNOWN cannot be retried without an explicit protected-action-authorized override",
    );
    this.name = "UnauthorizedUnknownRetryError";
  }
}

/**
 * Activation Boundary: "the first provider-neutral cloud lane may be proven
 * with an injected/mock executor and durable store. No real provider
 * credential, secret, spend, production action or external effect is
 * required or authorized. A local/provider lane that cannot yet meet
 * durable/currentness requirements stays explicit UNSUPPORTED/NOT_ACTIVATED;
 * it must not be simulated as working." `"INJECTED"` is the only currently
 * activated executor kind - `local-execution-hardening.ts` itself already
 * discloses no authoritative durable LocalTaskLease/effect-state store
 * exists, so a `"LOCAL"` executor kind is deliberately rejected here rather
 * than pretending to compose it (Package Contract J).
 */
export type ExecutionExecutorKind = "INJECTED";

const ACTIVATED_EXECUTOR_KINDS: ReadonlySet<ExecutionExecutorKind> = new Set(["INJECTED"]);

function assertActivatedExecutorKind(executorKind: unknown): asserts executorKind is ExecutionExecutorKind {
  if (typeof executorKind !== "string" || !ACTIVATED_EXECUTOR_KINDS.has(executorKind as ExecutionExecutorKind)) {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      `executorKind "${String(executorKind)}" is NOT_ACTIVATED/UNSUPPORTED in this package - only the provider-neutral "INJECTED" lane is activated (no durable LocalTaskLease/effect-state store or real provider credential exists yet)`,
    );
  }
}

/**
 * Store-shape this runtime depends on - satisfied structurally by both
 * `FileDurableOutcomeJobExecutionStore` (sync) and
 * `PostgresOutcomeJobExecutionStore`/`AsyncOutcomeJobExecutionStore` (async):
 * a method returning `T` structurally satisfies a declared `T | Promise<T>`
 * return, so this runtime is usable with either store without an adapter.
 */
export interface ExecutionEventStore {
  /**
   * Rev145 F1: resolves/returns `true` only when THIS call durably created
   * the event (an atomic single-authority claim), `false` when it already
   * existed. Callers gate any side effect that must happen exactly once per
   * event (invoking the worker) on this return value.
   */
  appendEvent(event: OutcomeJobExecutionEvent): boolean | Promise<boolean>;
  getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): OutcomeJobExecutionRunState | undefined | Promise<OutcomeJobExecutionRunState | undefined>;
}

/**
 * Package Contract I currentness gate. Pure comparison - the caller is
 * responsible for actually re-resolving `currentFingerprint` from
 * `resolveEffectiveConfigurationPolicy`/`compileProjectActivationProfile`
 * immediately before calling this, never from a cached/queued value.
 */
function assertCurrentActivation(expectedFingerprint: string, currentFingerprint: string): void {
  if (expectedFingerprint !== currentFingerprint) {
    throw new StaleActivationFingerprintError(expectedFingerprint, currentFingerprint);
  }
}

function nextSequenceForAttempt(state: OutcomeJobExecutionRunState | undefined, attempt: number): number {
  const attemptState = state?.attempts.get(attempt);
  return (attemptState?.lastSequence ?? 0) + 1;
}

interface ScopeInput {
  readonly tenantScope: TenantScope;
  readonly customer: Customer;
  readonly project: Project;
  readonly job: OutcomeJob;
}

async function appendAndGetState(
  store: ExecutionEventStore,
  event: OutcomeJobExecutionEvent,
): Promise<{ state: OutcomeJobExecutionRunState; created: boolean }> {
  const created = await store.appendEvent(event);
  const state = await store.getState(event.tenantId, event.customerId, event.projectId, event.jobId, event.runId);
  if (state === undefined) {
    throw new InvalidOutcomeJobExecutionRuntimeError("internal error: state missing immediately after appendEvent");
  }
  return { state, created };
}

/**
 * Rev145 F4: "retry/progress/result/cancel/checkpoint consume currentState
 * runId/correlationId/attempt/sequence without first proving currentState
 * belongs to the exact target tenant/customer/project/job." Every function
 * below that accepts a caller-constructed `currentState` calls this first:
 * it (1) fails closed if `currentState`'s own identity does not exactly
 * match the given `tenantScope`/`customer`/`project`/`job` (a
 * foreign/substituted state can never be used to derive an event for a
 * different target job), and (2) re-fetches the actual current durable
 * state from `store` rather than trusting the caller-supplied object for
 * anything beyond its `runId` - closing both the cross-job-substitution
 * attack and the stale-caller-copy problem in one place.
 */
async function verifyAndRefreshExecutionState(
  store: ExecutionEventStore,
  scope: ScopeInput,
  currentState: OutcomeJobExecutionRunState,
): Promise<OutcomeJobExecutionRunState> {
  if (
    currentState.tenantId !== scope.tenantScope.tenantId ||
    currentState.customerId !== scope.customer.customerId ||
    currentState.projectId !== scope.project.projectId ||
    currentState.jobId !== scope.job.jobId
  ) {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      "currentState does not belong to the given tenantScope/customer/project/job - cross-scope substitution",
    );
  }
  const fresh = await store.getState(
    scope.tenantScope.tenantId,
    scope.customer.customerId,
    scope.project.projectId,
    scope.job.jobId,
    currentState.runId,
  );
  if (fresh === undefined) {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      `no durable execution run exists for runId "${currentState.runId}" under the given tenant/customer/project/job`,
    );
  }
  return fresh;
}

export interface DispatchOutcomeJobExecutionResult {
  readonly state: OutcomeJobExecutionRunState;
  readonly invoked: boolean;
  readonly invocationOutcome?: InvokeOutcome;
}

/**
 * Package Contract B/G/I: the entry point that durably accepts a run, starts
 * its first attempt, and invokes the (provider-neutral, activated) worker -
 * reusing `invokeSafely` verbatim rather than re-implementing invocation
 * failure handling. Idempotent by construction: if a run already exists for
 * this exact (tenant, customer, project, job, runId), this is a safe no-op
 * that returns the existing state and never re-invokes the worker
 * (Minimum Adversarial Evidence #9) - a caller must always re-read current
 * state rather than assume a fresh dispatch happened.
 */
export async function dispatchOutcomeJobExecutionRun(
  input: ScopeInput & {
    readonly authority: AuthorityContext;
    readonly runId: unknown;
    readonly correlationId: unknown;
    readonly now: unknown;
    readonly executorKind: unknown;
    readonly expectedFingerprint: string;
    readonly currentFingerprint: string;
    readonly store: ExecutionEventStore;
    readonly invoker: WorkerInvoker;
    readonly taskId: string;
    readonly branch: string;
    readonly checkpointSha: string;
  },
): Promise<DispatchOutcomeJobExecutionResult> {
  requireSameTenant(input.authority, input.tenantScope.tenantId);
  requirePermission(input.authority, "EXECUTE");
  assertActivatedExecutorKind(input.executorKind);

  const runId = typeof input.runId === "string" ? input.runId : "";
  const correlationId = typeof input.correlationId === "string" ? input.correlationId : "";
  const existing = runId.length > 0 && correlationId.length > 0
    ? await input.store.getState(
        input.tenantScope.tenantId,
        input.customer.customerId,
        input.project.projectId,
        input.job.jobId,
        runId,
      )
    : undefined;

  // Rev146 F5: an existing run's correlationId is authoritative. Failing
  // closed HERE - before anything is ever (re-)appended - matters: once
  // `correlationId` is part of the eventId (see `deriveOutcomeJobExecutionEventId`),
  // a mismatched re-dispatch's ACCEPTED event would otherwise be accepted
  // as a genuinely new, distinct durable write (its eventId differs), only
  // to have `getState`'s own replay permanently throw afterward, once the
  // reducer's identity check rejects it - corrupting this run's log for
  // every future read. Rejecting before any append is the only safe option.
  if (existing !== undefined && existing.correlationId !== correlationId) {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      `existing run "${runId}" has correlationId "${existing.correlationId}", but dispatch was called with a different correlationId "${correlationId}"`,
    );
  }

  assertCurrentActivation(input.expectedFingerprint, input.currentFingerprint);

  const acceptedEvent = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: input.runId,
    correlationId: input.correlationId,
    attempt: 1,
    sequence: 1,
    type: "ACCEPTED",
    occurredAt: input.now,
  });
  let { state } = await appendAndGetState(input.store, acceptedEvent);

  const startedEvent = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: acceptedEvent.runId,
    correlationId: acceptedEvent.correlationId,
    attempt: 1,
    sequence: 1,
    type: "ATTEMPT_STARTED",
    occurredAt: input.now,
  });
  const started = await appendAndGetState(input.store, startedEvent);
  state = started.state;

  // Rev145 F1 / Rev146 F6: only the caller who actually WON the durable
  // claim on this exact ATTEMPT_STARTED event may invoke the worker. This
  // single atomic gate uniformly covers three cases: (1) a fresh run - both
  // ACCEPTED and ATTEMPT_STARTED are newly created, this call wins and
  // invokes; (2) a run that already fully progressed past attempt 1 - the
  // ATTEMPT_STARTED append for attempt 1 already exists (whatever the
  // CURRENT attempt now is, since its eventId depends only on the fixed
  // attempt-1/sequence-1 coordinate), so this call durably loses and
  // returns the real current state as a pure no-op; (3) Rev146 F6's
  // ACCEPTED-only crash-recovery window - the process died after ACCEPTED
  // became durable but before ATTEMPT_STARTED did, so a later re-dispatch
  // (with the SAME correlationId, already verified above) finds ACCEPTED
  // already durable (a harmless idempotent no-op re-append) but
  // ATTEMPT_STARTED genuinely new - this call wins the claim and invokes
  // exactly once, un-stranding the run. A concurrent recovery race between
  // two such re-dispatches is resolved by this exact same atomic claim, so
  // there is still only ever one invocation winner.
  if (!started.created) {
    return { state, invoked: false };
  }

  const invocationOutcome = await invokeSafely(input.invoker, {
    taskId: input.taskId,
    branch: input.branch,
    checkpointSha: input.checkpointSha,
    outcomeJobExecution: {
      tenantId: acceptedEvent.tenantId,
      customerId: acceptedEvent.customerId,
      projectId: acceptedEvent.projectId,
      jobId: acceptedEvent.jobId,
      runId: acceptedEvent.runId,
      correlationId: acceptedEvent.correlationId,
      attempt: 1,
    },
  });

  if (invocationOutcome.status === "TEMPORARY_FAILURE") {
    const failedEvent = createOutcomeJobExecutionEvent({
      tenantScope: input.tenantScope,
      customer: input.customer,
      project: input.project,
      job: input.job,
      runId: acceptedEvent.runId,
      correlationId: acceptedEvent.correlationId,
      attempt: 1,
      sequence: 2,
      type: "FAILED",
      occurredAt: input.now,
      reason: invocationOutcome.reason,
    });
    ({ state } = await appendAndGetState(input.store, failedEvent));
  }

  return { state, invoked: true, invocationOutcome };
}

const RETRYABLE_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  "FAILED",
  "TIMED_OUT",
  "STALLED",
  "DEGRADED",
  "BLOCKED",
  "UNKNOWN",
]);

/**
 * Package Contract H: "Retry must create/advance an explicit attempt under
 * idempotency rules, rechecking current inputs; UNKNOWN is never blindly
 * retried." `currentState` must be freshly read from the store by the
 * caller immediately before calling this - retrying against a stale
 * in-memory copy is safe (the reducer's own attempt-number check makes a
 * second `ATTEMPT_STARTED` for an already-superseded attempt a no-op), but
 * never authorizes anything the store's real current state disagrees with.
 */
export async function retryOutcomeJobExecutionAttempt(
  input: ScopeInput & {
    readonly authority: AuthorityContext;
    readonly currentState: OutcomeJobExecutionRunState;
    readonly now: unknown;
    readonly executorKind: unknown;
    readonly expectedFingerprint: string;
    readonly currentFingerprint: string;
    readonly store: ExecutionEventStore;
    readonly invoker: WorkerInvoker;
    readonly taskId: string;
    readonly branch: string;
    readonly checkpointSha: string;
  },
): Promise<DispatchOutcomeJobExecutionResult> {
  requireSameTenant(input.authority, input.tenantScope.tenantId);
  requirePermission(input.authority, "EXECUTE");
  assertActivatedExecutorKind(input.executorKind);

  const freshState = await verifyAndRefreshExecutionState(input.store, input, input.currentState);
  const currentAttemptState = freshState.attempts.get(freshState.currentAttempt);
  if (currentAttemptState === undefined || !RETRYABLE_ATTEMPT_STATUSES.has(currentAttemptState.status)) {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      `attempt ${freshState.currentAttempt} with status "${currentAttemptState?.status}" is not retryable`,
    );
  }
  if (currentAttemptState.status === "UNKNOWN" && !input.authority.canPerformProtectedActions) {
    throw new UnauthorizedUnknownRetryError();
  }
  if (currentAttemptState.status === "UNKNOWN") {
    requireProtectedActionAuthorization(input.authority, "retryOutcomeJobExecutionAttempt:UNKNOWN");
  }

  assertCurrentActivation(input.expectedFingerprint, input.currentFingerprint);

  const nextAttempt = freshState.currentAttempt + 1;
  const startedEvent = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: freshState.runId,
    correlationId: freshState.correlationId,
    attempt: nextAttempt,
    sequence: 1,
    type: "ATTEMPT_STARTED",
    occurredAt: input.now,
  });
  const started = await appendAndGetState(input.store, startedEvent);
  let state = started.state;

  // Rev145 F1: only the caller who actually won the durable claim on this
  // exact next-attempt's ATTEMPT_STARTED may invoke the worker. The prior
  // heuristic ("does state.currentAttempt still equal nextAttempt") could
  // not distinguish "I won the race" from "someone else won it but the
  // final state happens to look the same" - the atomic `created` flag can.
  if (!started.created) {
    return { state, invoked: false };
  }

  const invocationOutcome = await invokeSafely(input.invoker, {
    taskId: input.taskId,
    branch: input.branch,
    checkpointSha: input.checkpointSha,
    outcomeJobExecution: {
      tenantId: startedEvent.tenantId,
      customerId: startedEvent.customerId,
      projectId: startedEvent.projectId,
      jobId: startedEvent.jobId,
      runId: startedEvent.runId,
      correlationId: startedEvent.correlationId,
      attempt: nextAttempt,
    },
  });

  if (invocationOutcome.status === "TEMPORARY_FAILURE") {
    const failedEvent = createOutcomeJobExecutionEvent({
      tenantScope: input.tenantScope,
      customer: input.customer,
      project: input.project,
      job: input.job,
      runId: startedEvent.runId,
      correlationId: startedEvent.correlationId,
      attempt: nextAttempt,
      sequence: 2,
      type: "FAILED",
      occurredAt: input.now,
      reason: invocationOutcome.reason,
    });
    ({ state } = await appendAndGetState(input.store, failedEvent));
  }

  return { state, invoked: true, invocationOutcome };
}

/**
 * Reports ongoing PROGRESS/CHECKPOINT truth for the run's current attempt.
 * `sequence` is always derived from the freshly-read durable state, never
 * caller-guessed, so a caller cannot accidentally regress ordering.
 */
export async function recordExecutionProgress(
  input: ScopeInput & {
    readonly currentState: OutcomeJobExecutionRunState;
    readonly now: unknown;
    readonly store: ExecutionEventStore;
    readonly progressRef?: unknown;
  },
): Promise<OutcomeJobExecutionRunState> {
  const freshState = await verifyAndRefreshExecutionState(input.store, input, input.currentState);
  const event = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: freshState.runId,
    correlationId: freshState.correlationId,
    attempt: freshState.currentAttempt,
    sequence: nextSequenceForAttempt(freshState, freshState.currentAttempt),
    type: "PROGRESS",
    occurredAt: input.now,
    ...(input.progressRef !== undefined ? { progressRef: input.progressRef } : {}),
  });
  const { state } = await appendAndGetState(input.store, event);
  return state;
}

const RESULT_EVENT_TYPES: ReadonlySet<OutcomeJobExecutionEventType> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "STALLED",
  "DEGRADED",
  "BLOCKED",
  "UNKNOWN",
]);

/**
 * Package Contract F: recording SUCCEEDED here is execution-runtime truth
 * ONLY. It never itself calls `verifyOutcomeJob` and never mutates the
 * OutcomeJob domain record - `advanceOutcomeJobAfterExecutionSuccess` below
 * is the one narrow, separate bridge back to the OutcomeJob lifecycle, and
 * even that only ever reaches the existing `EXECUTING -> VERIFYING` edge,
 * never `VERIFIED` (Minimum Adversarial Evidence #6, #8).
 */
export async function recordExecutionResult(
  input: ScopeInput & {
    readonly currentState: OutcomeJobExecutionRunState;
    readonly now: unknown;
    readonly type: unknown;
    readonly store: ExecutionEventStore;
    readonly reason?: unknown;
  },
): Promise<OutcomeJobExecutionRunState> {
  if (typeof input.type !== "string" || !RESULT_EVENT_TYPES.has(input.type as OutcomeJobExecutionEventType)) {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      `type must be one of ${Array.from(RESULT_EVENT_TYPES).join(", ")}`,
    );
  }
  const freshState = await verifyAndRefreshExecutionState(input.store, input, input.currentState);
  const event = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: freshState.runId,
    correlationId: freshState.correlationId,
    attempt: freshState.currentAttempt,
    sequence: nextSequenceForAttempt(freshState, freshState.currentAttempt),
    type: input.type as OutcomeJobExecutionEventType,
    occurredAt: input.now,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  const { state } = await appendAndGetState(input.store, event);
  return state;
}

/**
 * The one narrow, explicit bridge from execution-runtime SUCCEEDED truth
 * back to the OutcomeJob business lifecycle - and it only ever reaches
 * `VERIFYING`, delegating entirely to the existing, unmodified
 * `transitionOutcomeJob`. Reaching `VERIFIED` still requires the existing,
 * separate `verifyOutcomeJob` gate and real verification evidence; this
 * function structurally cannot produce VERIFIED.
 */
export function advanceOutcomeJobAfterExecutionSuccess(
  job: OutcomeJob,
  executionState: OutcomeJobExecutionRunState,
): OutcomeJob {
  if (
    executionState.tenantId !== job.tenantId ||
    executionState.customerId !== job.customerId ||
    executionState.projectId !== job.projectId ||
    executionState.jobId !== job.jobId
  ) {
    throw new InvalidOutcomeJobExecutionRuntimeError("executionState does not belong to the given OutcomeJob");
  }
  const currentAttemptState = executionState.attempts.get(executionState.currentAttempt);
  if (currentAttemptState?.status !== "SUCCEEDED") {
    throw new InvalidOutcomeJobExecutionRuntimeError(
      "executionState's current attempt is not SUCCEEDED - execution success is required before advancing the OutcomeJob",
    );
  }
  return transitionOutcomeJob(job, "VERIFYING");
}

/**
 * Minimum Adversarial Evidence #7: "worker AVAILABLE/heartbeat without run
 * progress leaves run unchanged." Deliberately the identity function -
 * heartbeat/connectivity telemetry has no code path anywhere in this module
 * capable of mutating execution-run truth; this exists so that invariant is
 * directly assertable rather than merely implied by omission.
 */
export function applyWorkerHeartbeat(state: OutcomeJobExecutionRunState): OutcomeJobExecutionRunState {
  return state;
}

export interface ExecutorCapabilities {
  readonly supportsCancel: boolean;
  readonly supportsCheckpoint: boolean;
}

/**
 * Minimum Adversarial Evidence #12: "unsupported cancel/checkpoint
 * capability returns UNSUPPORTED rather than fabricated success." Never
 * records CANCELLED unless the caller-supplied executor descriptor actually
 * declares `supportsCancel`.
 */
export async function requestExecutionCancellation(
  input: ScopeInput & {
    readonly currentState: OutcomeJobExecutionRunState;
    readonly now: unknown;
    readonly capabilities: ExecutorCapabilities;
    readonly reason: unknown;
    readonly store: ExecutionEventStore;
  },
): Promise<OutcomeJobExecutionRunState> {
  const freshState = await verifyAndRefreshExecutionState(input.store, input, input.currentState);
  const type: OutcomeJobExecutionEventType = input.capabilities.supportsCancel ? "CANCELLED" : "UNSUPPORTED";
  const event = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: freshState.runId,
    correlationId: freshState.correlationId,
    attempt: freshState.currentAttempt,
    sequence: nextSequenceForAttempt(freshState, freshState.currentAttempt),
    type,
    occurredAt: input.now,
    reason: input.capabilities.supportsCancel
      ? input.reason
      : "executor does not support cancellation for this run",
  });
  const { state } = await appendAndGetState(input.store, event);
  return state;
}

/**
 * Symmetric UNSUPPORTED behavior for checkpoints (Minimum Adversarial
 * Evidence #12).
 */
export async function requestExecutionCheckpoint(
  input: ScopeInput & {
    readonly currentState: OutcomeJobExecutionRunState;
    readonly now: unknown;
    readonly capabilities: ExecutorCapabilities;
    readonly checkpointRef?: unknown;
    readonly store: ExecutionEventStore;
  },
): Promise<OutcomeJobExecutionRunState> {
  const freshState = await verifyAndRefreshExecutionState(input.store, input, input.currentState);
  if (input.capabilities.supportsCheckpoint) {
    const event = createOutcomeJobExecutionEvent({
      tenantScope: input.tenantScope,
      customer: input.customer,
      project: input.project,
      job: input.job,
      runId: freshState.runId,
      correlationId: freshState.correlationId,
      attempt: freshState.currentAttempt,
      sequence: nextSequenceForAttempt(freshState, freshState.currentAttempt),
      type: "CHECKPOINT",
      occurredAt: input.now,
      checkpointRef: input.checkpointRef ?? "checkpoint",
    });
    const { state } = await appendAndGetState(input.store, event);
    return state;
  }
  const event = createOutcomeJobExecutionEvent({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    job: input.job,
    runId: freshState.runId,
    correlationId: freshState.correlationId,
    attempt: freshState.currentAttempt,
    sequence: nextSequenceForAttempt(freshState, freshState.currentAttempt),
    type: "UNSUPPORTED",
    occurredAt: input.now,
    reason: "executor does not support checkpointing for this run",
  });
  const { state } = await appendAndGetState(input.store, event);
  return state;
}
