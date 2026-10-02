import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { OutcomeJobSpec } from "./outcome-job-spec.js";
import type { ProjectActivationProfile, ActivationActor } from "./project-activation-profile.js";
import {
  ATTEMPT_TERMINAL_STATUSES,
  type OutcomeJobExecutionRunState,
} from "./outcome-job-execution-run-state.js";
import type { VerificationResult } from "./verification-result.js";
import {
  isRoutedExecutionAssignmentValidForJob,
  type RoutedExecutionAssignment,
} from "./outcome-job-routing-execution.js";
import { createTaskPacket, type TaskPacket } from "./local-execution-collaboration.js";

export class InvalidGoldenPathCompositionError extends Error {
  constructor(reason: string) {
    super(`Invalid Golden-Path composition input: ${reason}`);
    this.name = "InvalidGoldenPathCompositionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidGoldenPathCompositionError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
    throw new InvalidGoldenPathCompositionError(`${field} must be an array of non-empty strings (an empty array is valid)`);
  }
  return value as ReadonlyArray<string>;
}

/**
 * OS-V0-10 Live Gap A2's own "one exact next actor/action" vocabulary -
 * deliberately the SAME shape `ProjectActivationProfile`'s own
 * `nextRequiredActor`/`nextRequiredAction` already use (`ActivationActor`,
 * `{ code, reason }`), never a parallel one. `"NONE"` is reachable only
 * when nothing further needs to happen (a terminal CLOSED job, or an
 * in-flight attempt that is genuinely still RUNNING and simply needs no
 * actor right now - not the same as CLOSED, but equally not awaiting any
 * actor this instant).
 */
export interface GoldenPathNextAction {
  readonly actor: ActivationActor;
  readonly code: string;
  readonly reason: string;
}

function crossCheckActivationBelongsToJob(activation: ProjectActivationProfile, job: OutcomeJob): void {
  if (
    activation.tenantId !== job.tenantId ||
    activation.customerId !== job.customerId ||
    activation.projectId !== job.projectId
  ) {
    throw new InvalidGoldenPathCompositionError(
      "activation does not belong to the given OutcomeJob's tenant/customer/project",
    );
  }
}

function crossCheckExecutionStateBelongsToJob(executionState: OutcomeJobExecutionRunState, job: OutcomeJob): void {
  if (
    executionState.tenantId !== job.tenantId ||
    executionState.customerId !== job.customerId ||
    executionState.projectId !== job.projectId ||
    executionState.jobId !== job.jobId
  ) {
    throw new InvalidGoldenPathCompositionError(
      "executionState does not belong to the given OutcomeJob's tenant/customer/project/jobId",
    );
  }
}

function crossCheckVerificationBelongsToJob(verification: VerificationResult, job: OutcomeJob): void {
  if (
    verification.tenantId !== job.tenantId ||
    verification.customerId !== job.customerId ||
    verification.projectId !== job.projectId ||
    verification.jobId !== job.jobId
  ) {
    throw new InvalidGoldenPathCompositionError(
      "verification does not belong to the given OutcomeJob's tenant/customer/project/jobId",
    );
  }
}

const RETRYABLE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "FAILED",
  "TIMED_OUT",
  "STALLED",
  "DEGRADED",
  "BLOCKED",
]);

/**
 * OS-V0-10 Live Gap A2 ("no one-lineage execution→verification→continuation
 * proof"): pure, always-re-resolved from CURRENT inputs - never cached, the
 * same discipline `resolveOrganizationResourceBindingStatus`/
 * `ProjectActivationProfile` itself already establish. Restart/replay
 * safety (Mandatory Evidence #1) falls out of this for free: since this
 * function only ever reads durable `activation`/`executionState`/
 * `verification` truth and never any in-memory tracking of its own, calling
 * it again after a crash/restart with the identical durable inputs always
 * reconstructs the identical next action.
 *
 * Priority order, mirroring `ProjectActivationProfile`'s own blocker-
 * priority discipline: an ACTION_REQUIRED activation is the highest-
 * priority blocker (nothing downstream of activation can be more current
 * than activation itself); then the job's own OutcomeJob lifecycle state;
 * then, within EXECUTING/VERIFYING, the current execution-run/verification
 * truth.
 */
export function resolveNextRunnableGoldenPathAction(input: {
  readonly job: OutcomeJob;
  readonly activation: ProjectActivationProfile;
  readonly executionState?: OutcomeJobExecutionRunState;
  readonly verification?: VerificationResult;
}): GoldenPathNextAction {
  crossCheckActivationBelongsToJob(input.activation, input.job);
  if (input.executionState !== undefined) {
    crossCheckExecutionStateBelongsToJob(input.executionState, input.job);
  }
  if (input.verification !== undefined) {
    crossCheckVerificationBelongsToJob(input.verification, input.job);
  }

  if (input.activation.state !== "READY") {
    return {
      actor: input.activation.nextRequiredActor,
      code: input.activation.nextRequiredAction?.code ?? "ACTIVATION_NOT_READY",
      reason: input.activation.nextRequiredAction?.reason ?? "activation is not READY",
    };
  }

  switch (input.job.state) {
    case "CLOSED":
      return { actor: "NONE", code: "CLOSED", reason: "job is already CLOSED - no further action" };
    case "VERIFIED":
      return { actor: "AKILTA", code: "CLOSE_JOB", reason: "job is VERIFIED - close it" };
    case "VERIFYING": {
      if (input.verification === undefined) {
        return {
          actor: "AKILTA",
          code: "VERIFICATION_REQUIRED",
          reason: "execution succeeded; independent verification evidence is required before VERIFIED",
        };
      }
      if (input.verification.status === "FAILED") {
        // Mandatory Evidence #5: verification failure recomputes a safe
        // remaining action, never a Founder "what next?".
        return {
          actor: "AKILTA",
          code: "VERIFICATION_FAILED_RECOMPUTE",
          reason: input.verification.limitationOrFailureReason ?? "verification failed - recompute remaining work",
        };
      }
      return { actor: "AKILTA", code: "ADVANCE_TO_VERIFIED", reason: "verification PASSED - advance job to VERIFIED" };
    }
    case "EXECUTING": {
      if (input.executionState === undefined) {
        return { actor: "AKILTA", code: "DISPATCH_EXECUTION", reason: "job is EXECUTING but no execution run exists yet" };
      }
      const attempt = input.executionState.attempts.get(input.executionState.currentAttempt);
      if (attempt === undefined) {
        return { actor: "AKILTA", code: "DISPATCH_EXECUTION", reason: "execution run has no current attempt yet" };
      }
      if (!ATTEMPT_TERMINAL_STATUSES.has(attempt.status)) {
        // RUNNING: genuinely still in flight - no actor is needed this
        // instant (Minimum Adversarial Evidence #7's own "heartbeat without
        // progress leaves the run unchanged" mirrors this).
        return { actor: "NONE", code: "AWAIT_EXECUTION", reason: `attempt ${attempt.attempt} is RUNNING` };
      }
      if (attempt.status === "SUCCEEDED") {
        return {
          actor: "AKILTA",
          code: "ADVANCE_TO_VERIFYING",
          reason: "execution SUCCEEDED - advance job to VERIFYING and attach verification evidence",
        };
      }
      if (attempt.status === "UNKNOWN") {
        // Mandatory Evidence #3/#6: an UNKNOWN external effect must stay
        // visible and can never be collapsed into a blind retry.
        return {
          actor: "HUMAN_REVIEW",
          code: "UNKNOWN_EFFECT_REQUIRES_REVIEW",
          reason: "attempt outcome is UNKNOWN - cannot be blindly retried; human review is required",
        };
      }
      if (attempt.status === "CANCELLED") {
        return {
          actor: "HUMAN_REVIEW",
          code: "EXECUTION_CANCELLED_REQUIRES_REVIEW",
          reason: "attempt was CANCELLED - human decision required on how to proceed",
        };
      }
      if (attempt.status === "UNSUPPORTED") {
        return {
          actor: "AKILTA",
          code: "UNSUPPORTED_CAPABILITY_REQUIRES_ALTERNATE_ROUTE",
          reason: "attempt reported UNSUPPORTED - an alternate executor/capability route is required",
        };
      }
      if (RETRYABLE_TERMINAL_STATUSES.has(attempt.status)) {
        return {
          actor: "AKILTA",
          code: "RETRY_EXECUTION",
          reason: `attempt ${attempt.attempt} ended ${attempt.status} - retry`,
        };
      }
      return {
        actor: "HUMAN_REVIEW",
        code: `UNHANDLED_ATTEMPT_STATUS:${attempt.status}`,
        reason: `attempt ${attempt.attempt} ended in an unhandled status "${attempt.status}"`,
      };
    }
    case "READY":
      return { actor: "AKILTA", code: "DISPATCH_EXECUTION", reason: "job is READY - dispatch execution" };
    case "DRAFT":
    case "QUALIFIED":
      return {
        actor: "AKILTA",
        code: `ADVANCE_JOB_LIFECYCLE:${input.job.state}`,
        reason: `job has not yet reached READY (current state: ${input.job.state})`,
      };
    case "BLOCKED":
    case "RECOVERING":
    case "ESCALATED":
    case "STOPPED":
      return {
        actor: "HUMAN_REVIEW",
        code: `EXCEPTION_STATE:${input.job.state}`,
        reason: `job is in exception state ${input.job.state} - human review is required to recover`,
      };
    default:
      return {
        actor: "HUMAN_REVIEW",
        code: `UNHANDLED_JOB_STATE:${String(input.job.state)}`,
        reason: `job is in an unhandled state "${String(input.job.state)}"`,
      };
  }
}

/**
 * OS-V0-10 Live Gap A1 ("no load-bearing OutcomeJob→TaskPacket composer"):
 * deterministically derives a real `TaskPacket` (`local-execution-
 * collaboration.ts`, unmodified) from an exact OutcomeJob lineage. Every
 * authoritative field (`projectOwnership` scope, `goal`, `blockers`,
 * `evidenceRefs` from verified connections, `nextAuthorizedAction`) is
 * DERIVED from the already-authoritative `spec`/`activation`/
 * `executionState` objects, never caller-asserted - only the genuinely
 * narrative fields this module cannot itself know (`acceptanceCriteria`,
 * `baseIdentity`, `relevantFileRefs`, extra `completedWork`/
 * `evidenceRefs`/`protectedGateRefs`, `priorWorkerFinalSummary`) are
 * caller-supplied. `nextAuthorizedAction` is derived by calling
 * `resolveNextRunnableGoldenPathAction` internally rather than accepting a
 * second, possibly-drifting caller claim - the TaskPacket's own
 * `nextAuthorizedAction` and this module's separately-exported next-action
 * resolver can never disagree about what happens next for the same job.
 */
export function composeTaskPacketForOutcomeJob(input: {
  readonly job: OutcomeJob;
  readonly spec: OutcomeJobSpec;
  readonly activation: ProjectActivationProfile;
  readonly projectOwnership: ProjectOwnershipRef;
  readonly baseIdentity: unknown;
  readonly acceptanceCriteria: ReadonlyArray<unknown>;
  readonly relevantFileRefs?: ReadonlyArray<unknown>;
  readonly routingAssignment?: RoutedExecutionAssignment;
  readonly executionState?: OutcomeJobExecutionRunState;
  readonly verification?: VerificationResult;
  readonly additionalCompletedWork?: ReadonlyArray<unknown>;
  readonly additionalEvidenceRefs?: ReadonlyArray<unknown>;
  readonly additionalProtectedGateRefs?: ReadonlyArray<unknown>;
  readonly priorWorkerFinalSummary?: unknown;
}): TaskPacket {
  if ((input.spec.specId as string) !== (input.job.jobId as string)) {
    throw new InvalidGoldenPathCompositionError(
      "spec.specId must equal job.jobId - the supplied OutcomeJobSpec must be the exact spec this job was wired from",
    );
  }
  if (
    input.spec.tenantId !== input.job.tenantId ||
    input.spec.customerId !== input.job.customerId ||
    input.spec.projectId !== input.job.projectId
  ) {
    throw new InvalidGoldenPathCompositionError("spec.tenantId/customerId/projectId must match job.tenantId/customerId/projectId");
  }
  crossCheckActivationBelongsToJob(input.activation, input.job);
  if (
    input.projectOwnership.tenantId !== input.job.tenantId ||
    input.projectOwnership.customerId !== input.job.customerId ||
    input.projectOwnership.projectId !== input.job.projectId
  ) {
    throw new InvalidGoldenPathCompositionError("projectOwnership does not match the given OutcomeJob's tenant/customer/project");
  }
  if (input.routingAssignment !== undefined && !isRoutedExecutionAssignmentValidForJob(input.routingAssignment, input.job)) {
    throw new InvalidGoldenPathCompositionError("routingAssignment is not valid for the given OutcomeJob");
  }
  if (input.executionState !== undefined) {
    crossCheckExecutionStateBelongsToJob(input.executionState, input.job);
  }
  if (input.verification !== undefined) {
    crossCheckVerificationBelongsToJob(input.verification, input.job);
  }

  const nextAction = resolveNextRunnableGoldenPathAction({
    job: input.job,
    activation: input.activation,
    ...(input.executionState !== undefined ? { executionState: input.executionState } : {}),
    ...(input.verification !== undefined ? { verification: input.verification } : {}),
  });

  const derivedCompletedWork: string[] = [];
  if (input.executionState !== undefined) {
    for (const [attemptNumber, attemptState] of input.executionState.attempts) {
      if (attemptNumber < input.executionState.currentAttempt && ATTEMPT_TERMINAL_STATUSES.has(attemptState.status)) {
        derivedCompletedWork.push(`attempt ${attemptNumber} ended ${attemptState.status}`);
      }
    }
  }

  const derivedEvidenceRefs = input.activation.verifiedConnections.map((connection) => connection.verificationEvidenceRef);
  const derivedProtectedGateRefs =
    input.routingAssignment !== undefined ? [`ROUTED:${input.routingAssignment.executorWorkerId}`] : [];

  return createTaskPacket({
    taskId: input.job.jobId,
    projectOwnership: input.projectOwnership,
    goal: input.spec.intendedOutcome,
    acceptanceCriteria: requireStringArray(input.acceptanceCriteria, "acceptanceCriteria"),
    protectedGateRefs: [...derivedProtectedGateRefs, ...requireStringArray(input.additionalProtectedGateRefs ?? [], "additionalProtectedGateRefs")],
    baseIdentity: requireNonEmptyString(input.baseIdentity, "baseIdentity"),
    relevantFileRefs: requireStringArray(input.relevantFileRefs ?? [], "relevantFileRefs"),
    completedWork: [...derivedCompletedWork, ...requireStringArray(input.additionalCompletedWork ?? [], "additionalCompletedWork")],
    remainingWork: [`${nextAction.actor}:${nextAction.code}`],
    evidenceRefs: [...derivedEvidenceRefs, ...requireStringArray(input.additionalEvidenceRefs ?? [], "additionalEvidenceRefs")],
    blockers: input.activation.unresolvedGates,
    nextAuthorizedAction: `${nextAction.actor}:${nextAction.code}:${nextAction.reason}`,
    ...(input.priorWorkerFinalSummary !== undefined
      ? { priorWorkerFinalSummary: requireNonEmptyString(input.priorWorkerFinalSummary, "priorWorkerFinalSummary") }
      : {}),
  });
}
