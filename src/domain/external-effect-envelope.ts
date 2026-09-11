import type { TenantScope } from "./tenant-scope.js";
import { requireSameTenant, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";

export class InvalidExternalEffectError extends Error {
  constructor(reason: string) {
    super(`Invalid external effect operation: ${reason}`);
    this.name = "InvalidExternalEffectError";
  }
}

export class InvalidExternalEffectRecoveryError extends Error {
  constructor(reason: string) {
    super(`Invalid external effect recovery: ${reason}`);
    this.name = "InvalidExternalEffectRecoveryError";
  }
}

type EffectIntentId = string & { readonly __brand: "EffectIntentId" };
type EffectAttemptId = string & { readonly __brand: "EffectAttemptId" };

/**
 * Rev98 gap-audit Family 4 (V4 Workstream D — Approval / Effect / Recovery
 * / Readback Envelope): the missing generic layer between an authorized
 * decision to act and an actual external-provider mutation. Distinct from
 * `outcome-job.ts`'s own exception-state recovery (SALE-TO-CLOSE's
 * `recoverFromExceptionState`) - that governs the internal delivery
 * lifecycle; this governs one single external-effect attempt's own
 * fail-closed state (proposed → approved → attempted → applied/failed/
 * unknown → verified/rolled-back), reusable by any future adapter
 * (CONN-001's connector execution, a future service-specific control
 * adapter, etc.) without inventing a second workflow engine. This module
 * never performs a real provider mutation itself - it only governs the
 * intent/approval/attempt/readback bookkeeping around one.
 *
 * `retryClassification` is declared by the caller at intent creation
 * time (the caller is the only party who can honestly know whether a
 * given action is idempotent/safe to repeat) and is never inferred here.
 */
export type ExternalEffectRetryClassification =
  | "SAFE_TO_RETRY"
  | "NOT_SAFE_TO_RETRY"
  | "REQUIRES_MANUAL_REVIEW";

const RECOGNIZED_RETRY_CLASSIFICATIONS: ReadonlySet<ExternalEffectRetryClassification> = new Set([
  "SAFE_TO_RETRY",
  "NOT_SAFE_TO_RETRY",
  "REQUIRES_MANUAL_REVIEW",
]);

/**
 * §4 acceptance: "proposed effect/action intent, scoped authority/
 * approval requirement, idempotency/retry classification." `actionRef`
 * is an opaque pointer to whatever the real action is (this module never
 * interprets or executes it - matching `connector-execution.ts`'s own
 * "capabilityRef is opaque" discipline).
 */
export interface ExternalEffectIntent {
  readonly effectIntentId: EffectIntentId;
  readonly tenantId: TenantScope["tenantId"];
  readonly actionRef: string;
  readonly retryClassification: ExternalEffectRetryClassification;
  readonly requiresApproval: boolean;
}

/**
 * §4 acceptance: "NOT_STARTED/APPLIED/VERIFIED/FAILED/UNKNOWN-equivalent
 * state." One `ExternalEffectAttempt` is the durable record of a single
 * try at actually causing `intent`'s effect. `ROLLED_BACK` is this
 * module's "rollback/recovery capability where available" terminal
 * state, distinct from a plain `FAILED` (a rollback is a deliberate,
 * governed undo of something that DID apply, not a failure to apply).
 */
export type ExternalEffectAttemptState =
  | "NOT_STARTED"
  | "APPLIED"
  | "VERIFIED"
  | "FAILED"
  | "UNKNOWN"
  | "ROLLED_BACK";

const RECOGNIZED_ATTEMPT_STATES: ReadonlySet<ExternalEffectAttemptState> = new Set([
  "NOT_STARTED",
  "APPLIED",
  "VERIFIED",
  "FAILED",
  "UNKNOWN",
  "ROLLED_BACK",
]);

export interface ExternalEffectAttempt {
  readonly effectIntentId: EffectIntentId;
  readonly tenantId: TenantScope["tenantId"];
  readonly attemptId: EffectAttemptId;
  readonly state: ExternalEffectAttemptState;
  readonly externalCorrelationRef?: string;
  readonly approvalEvidenceRef?: string;
  readonly readbackEvidenceRef?: string;
  readonly rollbackCorrelationRef?: string;
  readonly rollbackEvidenceRef?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidExternalEffectError(`${field} must be a non-empty string`);
  }
  return value;
}

export function createExternalEffectIntent(input: {
  tenantScope: TenantScope;
  effectIntentId: unknown;
  actionRef: unknown;
  retryClassification: unknown;
  requiresApproval: unknown;
}): ExternalEffectIntent {
  const effectIntentId = requireNonEmptyString(input.effectIntentId, "effectIntentId");
  const actionRef = requireNonEmptyString(input.actionRef, "actionRef");
  if (
    typeof input.retryClassification !== "string" ||
    !RECOGNIZED_RETRY_CLASSIFICATIONS.has(input.retryClassification as ExternalEffectRetryClassification)
  ) {
    throw new InvalidExternalEffectError(
      `retryClassification must be one of ${Array.from(RECOGNIZED_RETRY_CLASSIFICATIONS).join(", ")}`,
    );
  }
  if (typeof input.requiresApproval !== "boolean") {
    throw new InvalidExternalEffectError("requiresApproval must be a boolean");
  }
  return {
    effectIntentId: effectIntentId as EffectIntentId,
    tenantId: input.tenantScope.tenantId,
    actionRef,
    retryClassification: input.retryClassification as ExternalEffectRetryClassification,
    requiresApproval: input.requiresApproval,
  };
}

/**
 * §4 acceptance: "scoped authority/approval requirement." Starts a new
 * attempt at `NOT_STARTED`. When `intent.requiresApproval` is true, a
 * granted `AuthorityContext` (same-tenant, protected-action-authorized)
 * plus a non-empty `evidenceRef` are mandatory - the approval decision
 * itself is not persisted as a separate record by this module (no second
 * approval-ledger invented; callers that need a durable approval trail
 * already have `approval-reference.ts`), but its evidence is carried
 * forward on the attempt as `approvalEvidenceRef` so a caller can always
 * prove why an approval-required attempt was permitted to start.
 */
export function startExternalEffectAttempt(input: {
  intent: ExternalEffectIntent;
  attemptId: unknown;
  approval?: { authority: AuthorityContext; evidenceRef: unknown };
}): ExternalEffectAttempt {
  const attemptId = requireNonEmptyString(input.attemptId, "attemptId");
  if (input.intent.requiresApproval) {
    if (input.approval === undefined) {
      throw new InvalidExternalEffectError(
        "this intent requiresApproval - a granted authority and evidenceRef must be supplied to start an attempt",
      );
    }
    requireSameTenant(input.approval.authority, input.intent.tenantId);
    requireProtectedActionAuthorization(input.approval.authority, "startExternalEffectAttempt");
    const approvalEvidenceRef = requireNonEmptyString(input.approval.evidenceRef, "approval.evidenceRef");
    return {
      effectIntentId: input.intent.effectIntentId,
      tenantId: input.intent.tenantId,
      attemptId: attemptId as EffectAttemptId,
      state: "NOT_STARTED",
      approvalEvidenceRef,
    };
  }
  return {
    effectIntentId: input.intent.effectIntentId,
    tenantId: input.intent.tenantId,
    attemptId: attemptId as EffectAttemptId,
    state: "NOT_STARTED",
  };
}

/**
 * §4 acceptance: "external correlation/effect attempt." Records what
 * actually happened when contact with the external provider was made
 * (or definitively could not be confirmed). `externalCorrelationRef` is
 * mandatory on every outcome, including `UNKNOWN` - even an inconclusive
 * attempt must carry whatever opaque correlation the provider or
 * transport gave back, so a later governed recovery has something
 * concrete to reconcile against. Only callable from `NOT_STARTED` - an
 * attempt's real-world outcome can only ever be reported once; a second
 * report requires a distinct new attempt (`startExternalEffectAttempt`
 * again), never overwriting this one.
 */
export function reportExternalEffectOutcome(input: {
  attempt: ExternalEffectAttempt;
  outcome: unknown;
  externalCorrelationRef: unknown;
}): ExternalEffectAttempt {
  if (input.attempt.state !== "NOT_STARTED") {
    throw new InvalidExternalEffectError(
      `outcome can only be reported for a NOT_STARTED attempt (current state: ${input.attempt.state})`,
    );
  }
  if (input.outcome !== "APPLIED" && input.outcome !== "FAILED" && input.outcome !== "UNKNOWN") {
    throw new InvalidExternalEffectError('outcome must be one of "APPLIED", "FAILED", or "UNKNOWN"');
  }
  const externalCorrelationRef = requireNonEmptyString(
    input.externalCorrelationRef,
    "externalCorrelationRef",
  );
  return { ...input.attempt, state: input.outcome, externalCorrelationRef };
}

/**
 * §4 acceptance: "post-action verification/readback evidence." A claimed
 * `APPLIED` outcome is never itself sufficient - only an independent
 * readback that actually confirms the effect took hold can move an
 * attempt to `VERIFIED`. If the readback disproves it (the provider
 * reported success but a follow-up read shows otherwise), the attempt is
 * corrected to `FAILED` rather than left falsely `APPLIED` - readback
 * evidence is always authoritative over the original claimed outcome.
 *
 * Rev101 F1 fix: the readback's own `evidenceRef` is preserved on the
 * returned attempt as `readbackEvidenceRef` (distinct from
 * `approvalEvidenceRef`) rather than validated and discarded, and the
 * original `externalCorrelationRef` this attempt already carried from
 * `reportExternalEffectOutcome` is left untouched either way - a
 * disproving readback must not erase the correlation the FAILED state
 * needs to be reconciled against.
 */
export function verifyExternalEffectReadback(input: {
  attempt: ExternalEffectAttempt;
  readbackConfirmsApplied: unknown;
  evidenceRef: unknown;
}): ExternalEffectAttempt {
  if (input.attempt.state !== "APPLIED") {
    throw new InvalidExternalEffectError(
      `readback verification can only be recorded for an APPLIED attempt (current state: ${input.attempt.state})`,
    );
  }
  if (typeof input.readbackConfirmsApplied !== "boolean") {
    throw new InvalidExternalEffectError("readbackConfirmsApplied must be a boolean");
  }
  const readbackEvidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return {
    ...input.attempt,
    state: input.readbackConfirmsApplied ? "VERIFIED" : "FAILED",
    readbackEvidenceRef,
  };
}

const RECOVERABLE_ATTEMPT_STATES: ReadonlySet<ExternalEffectAttemptState> = new Set(["FAILED", "UNKNOWN"]);

/**
 * §4 acceptance: "UNKNOWN fail-closed/no blind retry," "idempotency/
 * retry classification," "rollback/recovery capability where available."
 * The only way out of `FAILED`/`UNKNOWN` - and it never mutates the
 * existing attempt in place, since a retry is honestly a NEW attempt at
 * the same intent, not a resurrection of the failed/unknown one (the old
 * attempt's own record, including its `externalCorrelationRef`, remains
 * exactly as it was for audit). Fails closed unless: the intent's own
 * `retryClassification` is exactly `SAFE_TO_RETRY` (`NOT_SAFE_TO_RETRY`
 * and `REQUIRES_MANUAL_REVIEW` can never be programmatically retried by
 * this function, regardless of authority - a human must start an
 * entirely new intent from scratch, which is the fail-closed, honest
 * behavior for an action this module cannot itself prove is safe to
 * repeat); a granted, same-tenant, protected-action-authorized authority
 * is supplied; and a non-empty `evidenceRef` justifies the recovery.
 */
export function retryExternalEffectAttempt(input: {
  attempt: ExternalEffectAttempt;
  intent: ExternalEffectIntent;
  authority: AuthorityContext;
  newAttemptId: unknown;
  evidenceRef: unknown;
}): ExternalEffectAttempt {
  if (input.intent.effectIntentId !== input.attempt.effectIntentId) {
    throw new InvalidExternalEffectRecoveryError("intent does not match the given attempt's effectIntentId");
  }
  requireSameTenant(input.authority, input.attempt.tenantId);
  if (!RECOVERABLE_ATTEMPT_STATES.has(input.attempt.state)) {
    throw new InvalidExternalEffectRecoveryError(
      `only a FAILED or UNKNOWN attempt can be retried (current state: ${input.attempt.state})`,
    );
  }
  if (input.intent.retryClassification !== "SAFE_TO_RETRY") {
    throw new InvalidExternalEffectRecoveryError(
      `intent's retryClassification is "${input.intent.retryClassification}" - only SAFE_TO_RETRY intents can be programmatically retried`,
    );
  }
  requireProtectedActionAuthorization(input.authority, "retryExternalEffectAttempt");
  requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const newAttemptId = requireNonEmptyString(input.newAttemptId, "newAttemptId");
  if (newAttemptId === (input.attempt.attemptId as string)) {
    throw new InvalidExternalEffectRecoveryError("newAttemptId must be distinct from the failed/unknown attempt's own attemptId");
  }
  return {
    effectIntentId: input.intent.effectIntentId,
    tenantId: input.attempt.tenantId,
    attemptId: newAttemptId as EffectAttemptId,
    state: "NOT_STARTED",
  };
}

/**
 * §4 "rollback/recovery capability where available": a governed,
 * explicit undo of an attempt that DID apply (or was even verified) -
 * distinct from `retryExternalEffectAttempt`, which only ever concerns a
 * failed/unknown attempt. Requires the same authority/evidence
 * discipline; `rollbackCorrelationRef` is the opaque proof that an
 * actual compensating action occurred (this module never performs it).
 *
 * Rev101 F1 fix: the rollback's own correlation and evidence are carried
 * forward as distinct `rollbackCorrelationRef`/`rollbackEvidenceRef`
 * fields rather than overwriting `externalCorrelationRef` - the original
 * effect's correlation ref (set when the effect was first reported
 * APPLIED/VERIFIED) must survive a rollback so the original and the
 * compensating action can both still be reconciled afterward.
 */
export function rollbackExternalEffectAttempt(input: {
  attempt: ExternalEffectAttempt;
  authority: AuthorityContext;
  rollbackCorrelationRef: unknown;
  evidenceRef: unknown;
}): ExternalEffectAttempt {
  requireSameTenant(input.authority, input.attempt.tenantId);
  if (input.attempt.state !== "APPLIED" && input.attempt.state !== "VERIFIED") {
    throw new InvalidExternalEffectRecoveryError(
      `only an APPLIED or VERIFIED attempt can be rolled back (current state: ${input.attempt.state})`,
    );
  }
  requireProtectedActionAuthorization(input.authority, "rollbackExternalEffectAttempt");
  const rollbackEvidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const rollbackCorrelationRef = requireNonEmptyString(input.rollbackCorrelationRef, "rollbackCorrelationRef");
  return {
    ...input.attempt,
    state: "ROLLED_BACK",
    rollbackCorrelationRef,
    rollbackEvidenceRef,
  };
}

/**
 * Fail-closed replay validator for a persisted attempt row, matching
 * this codebase's own established convention - exported so a future
 * durable store for this envelope (not built in this checkpoint; no
 * caller exists yet) can reuse it rather than reinventing validation.
 */
export function isRecognizedExternalEffectAttemptState(value: unknown): value is ExternalEffectAttemptState {
  return typeof value === "string" && RECOGNIZED_ATTEMPT_STATES.has(value as ExternalEffectAttemptState);
}
