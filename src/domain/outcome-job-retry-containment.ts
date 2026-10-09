import type { OutcomeJobExecutionRunState } from "./outcome-job-execution-run-state.js";

export class InvalidRetryContainmentPolicyError extends Error {
  constructor(reason: string) {
    super(`Invalid RetryContainmentPolicy operation: ${reason}`);
    this.name = "InvalidRetryContainmentPolicyError";
  }
}

/**
 * OS-V1-07 (Operational Reliability / Incident Controls). AA-005 REV209:
 * "bound retries... crash-loop containment... Witness... crash loop...
 * retry storm."
 *
 * A repository-wide inspection before this task found `outcome-job-
 * execution-run-state.ts`'s own `applyOutcomeJobExecutionEvent` reducer
 * (OS-V0-05, hardened through Rev145-191, frozen/ACCEPTED) enforces every
 * structural attempt-sequencing invariant (no attempt starts before its
 * predecessor is terminal, no out-of-order/duplicate application) but has
 * NO bound on how MANY attempts a run may accumulate, nor on how FAST
 * consecutive attempts may restart - a worker stuck crash-looping (fail,
 * immediately retry, fail, immediately retry...) or a caller issuing a
 * retry storm can drive an unbounded number of `ATTEMPT_STARTED` events
 * through that reducer today, each one individually valid.
 *
 * This module is a pure, stateless, ADDITIONAL admission gate a caller
 * consults BEFORE constructing the next `ATTEMPT_STARTED` event - it never
 * modifies the frozen reducer, never reads the system clock (the caller
 * supplies `now`, mirroring every other pure domain module's own
 * discipline), and never persists anything. Its `BLOCKED` outcome is a
 * recommendation the caller's own runtime acts on; this module cannot
 * itself refuse to apply an event, by design - that boundary stays
 * exactly where the frozen reducer already owns it.
 *
 * "Separate health from task state" (REV209's own framing, already closed
 * by `operational-observability-view.ts`'s `WorkerHealth`/
 * `TaskObservability` split): this module follows the same discipline -
 * `RetryContainmentDisposition` is a SEPARATE signal from the run's own
 * `OutcomeJobExecutionRunStatus`, never folded into or confused with it.
 */
export interface RetryContainmentPolicy {
  /** Absolute cap on total attempts a run may ever accumulate. */
  readonly maxAttempts: number;
  /** A new attempt within this many ms of the current attempt's own startedAt is too soon. */
  readonly minAttemptIntervalMs: number;
  /** The sliding window, in ms, "crash loop" density is measured over. */
  readonly crashLoopWindowMs: number;
  /** Once this many PRIOR attempts already started within crashLoopWindowMs of now, the next attempt is blocked. */
  readonly maxAttemptsWithinCrashLoopWindow: number;
}

export type RetryContainmentClassification = "RETRY_STORM" | "CRASH_LOOP";

export type RetryContainmentDisposition =
  | { readonly outcome: "ADMIT" }
  | { readonly outcome: "BLOCKED"; readonly classification: RetryContainmentClassification; readonly reason: string };

function requirePositiveFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new InvalidRetryContainmentPolicyError(`${field} must be a positive finite number`);
  }
  return value;
}

function requireValidTimestampMs(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRetryContainmentPolicyError(`${field} must be a non-empty string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new InvalidRetryContainmentPolicyError(`${field} must be a valid ISO timestamp`);
  }
  return ms;
}

function validatePolicy(policy: RetryContainmentPolicy): void {
  requirePositiveFinite(policy.maxAttempts, "policy.maxAttempts");
  requirePositiveFinite(policy.minAttemptIntervalMs, "policy.minAttemptIntervalMs");
  requirePositiveFinite(policy.crashLoopWindowMs, "policy.crashLoopWindowMs");
  requirePositiveFinite(policy.maxAttemptsWithinCrashLoopWindow, "policy.maxAttemptsWithinCrashLoopWindow");
}

/**
 * "Bound retries" + "crash-loop containment" + the "retry storm"/"crash
 * loop" witnesses, in one pure decision:
 *
 * - A run's very FIRST attempt (`currentAttempt === 0`) is ALWAYS admitted
 *   regardless of policy - this gate governs RETRIES only, never initial
 *   admission (that remains quota/authority's own separate concern).
 * - `RETRY_STORM`: the prospective next attempt number
 *   (`runState.currentAttempt + 1`) would exceed `policy.maxAttempts` -
 *   the run has already exhausted its absolute attempt budget.
 * - `CRASH_LOOP` (too fast): the time between `now` and the CURRENT
 *   attempt's own `startedAt` is less than `policy.minAttemptIntervalMs` -
 *   a worker that fails and immediately retries, over and over, without
 *   ever actually waiting, is contained here even before it could
 *   accumulate enough attempts to trip the absolute cap.
 * - `CRASH_LOOP` (too dense): the number of PRIOR attempts whose own
 *   `startedAt` falls within `policy.crashLoopWindowMs` of `now` has
 *   already reached `policy.maxAttemptsWithinCrashLoopWindow` - a bursty
 *   but not instantaneous crash loop (fail, retry after a short but
 *   nonzero delay, repeatedly) is contained by DENSITY even when no
 *   single gap was short enough to trip the interval check alone.
 *
 * Fails closed (throws) on a malformed policy value; never on a
 * malformed `runState` (that is the frozen reducer's own, already-proven
 * validation responsibility - this gate only ever reads already-valid
 * `OutcomeJobExecutionRunState` values).
 */
export function resolveRetryContainmentDisposition(input: {
  readonly runState: OutcomeJobExecutionRunState;
  readonly policy: RetryContainmentPolicy;
  readonly now: unknown;
}): RetryContainmentDisposition {
  validatePolicy(input.policy);
  const nowMs = requireValidTimestampMs(input.now, "now");

  if (input.runState.currentAttempt === 0) {
    return { outcome: "ADMIT" };
  }

  const prospectiveNextAttempt = input.runState.currentAttempt + 1;
  if (prospectiveNextAttempt > input.policy.maxAttempts) {
    return {
      outcome: "BLOCKED",
      classification: "RETRY_STORM",
      reason: `run has already accumulated ${input.runState.currentAttempt} attempt(s); the next attempt (${prospectiveNextAttempt}) would exceed the absolute cap of ${input.policy.maxAttempts}`,
    };
  }

  const currentAttemptState = input.runState.attempts.get(input.runState.currentAttempt);
  if (currentAttemptState !== undefined) {
    const sinceCurrentMs = nowMs - Date.parse(currentAttemptState.startedAt);
    if (sinceCurrentMs < input.policy.minAttemptIntervalMs) {
      return {
        outcome: "BLOCKED",
        classification: "CRASH_LOOP",
        reason: `only ${sinceCurrentMs}ms elapsed since attempt ${input.runState.currentAttempt} started, below the minimum inter-attempt interval of ${input.policy.minAttemptIntervalMs}ms`,
      };
    }
  }

  let attemptsWithinWindow = 0;
  for (const attempt of input.runState.attempts.values()) {
    const ageMs = nowMs - Date.parse(attempt.startedAt);
    if (ageMs >= 0 && ageMs <= input.policy.crashLoopWindowMs) {
      attemptsWithinWindow += 1;
    }
  }
  if (attemptsWithinWindow >= input.policy.maxAttemptsWithinCrashLoopWindow) {
    return {
      outcome: "BLOCKED",
      classification: "CRASH_LOOP",
      reason: `${attemptsWithinWindow} attempt(s) already started within the last ${input.policy.crashLoopWindowMs}ms, at or above the crash-loop density threshold of ${input.policy.maxAttemptsWithinCrashLoopWindow}`,
    };
  }

  return { outcome: "ADMIT" };
}
