import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { VerificationResult } from "./verification-result.js";
import { createAuditEvent, type AuditEvent } from "./audit-event.js";
import {
  requireSameTenant,
  requireProtectedActionAuthorization,
  type AuthorityContext,
} from "./authority.js";

export class InvalidOutcomeJobError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJob: ${reason}`);
    this.name = "InvalidOutcomeJobError";
  }
}

export class InvalidOutcomeJobTransitionError extends Error {
  constructor(from: OutcomeJobState, to: OutcomeJobState) {
    super(`Invalid OutcomeJob transition: ${from} -> ${to}`);
    this.name = "InvalidOutcomeJobTransitionError";
  }
}

type JobId = string & { readonly __brand: "JobId" };

/**
 * Canonical OutcomeJob lifecycle (AKI-BE-001 execution record, "Scope
 * (Minimum Domain Objects)" #4): main path plus exception states.
 */
export type OutcomeJobState =
  | "DRAFT"
  | "QUALIFIED"
  | "READY"
  | "EXECUTING"
  | "VERIFYING"
  | "VERIFIED"
  | "CLOSED"
  | "BLOCKED"
  | "RECOVERING"
  | "ESCALATED"
  | "STOPPED";

/**
 * Belongs to exactly one tenantId + customerId + projectId. Always
 * constructed at DRAFT (the canonical main-path entry state).
 */
export interface OutcomeJob {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: JobId;
  readonly jobFamily: string;
  readonly businessObjective: string;
  readonly state: OutcomeJobState;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOutcomeJobError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidOutcomeJobError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidOutcomeJobError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOutcomeJobError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createOutcomeJob(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  jobId: unknown;
  jobFamily: unknown;
  businessObjective: unknown;
}): OutcomeJob {
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidOutcomeJobError(
      "customer does not belong to the given tenantScope",
    );
  }
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidOutcomeJobError(
      "project does not belong to the given tenantScope",
    );
  }
  if (input.project.customerId !== input.customer.customerId) {
    throw new InvalidOutcomeJobError(
      "project does not belong to the given customer",
    );
  }
  const jobId = requireNonEmptyString(input.jobId, "jobId");
  const jobFamily = requireNonEmptyString(input.jobFamily, "jobFamily");
  const businessObjective = requireNonEmptyString(
    input.businessObjective,
    "businessObjective",
  );
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    jobId: jobId as JobId,
    jobFamily,
    businessObjective,
    state: "DRAFT",
  };
}

/**
 * Deterministic, validated lifecycle transitions (T3/T4/RG-03).
 *
 * VERIFYING -> VERIFIED is deliberately absent from this generic
 * transition table, permanently, not just until step 5. It is
 * implemented separately below as `verifyOutcomeJob`, which requires a
 * passing `VerificationResult` (T5/T6). This keeps the generic
 * `transitionOutcomeJob` function structurally unable to fake VERIFIED
 * via a bare state assignment - execution/tool success is not
 * verification (DEC-122 RG-04), and that separation is enforced by the
 * type/function boundary itself, not left to caller discipline.
 *
 * Exception-state entry/exit (BLOCKED/RECOVERING/ESCALATED/STOPPED)
 * remains unimplemented: the canonical source names these states but
 * does not specify their exact entry/exit graph, and T7 requires them
 * to "preserve auditable transition reason/evidence references" - which
 * needs AuditEvent (step 7, not yet built). Inventing a specific graph
 * now would be fabricating an unsourced business rule, so these states
 * are declared in the type but have no transitions into or out of them
 * in this checkpoint either.
 */
const MAIN_PATH_TRANSITIONS: ReadonlyMap<
  OutcomeJobState,
  ReadonlySet<OutcomeJobState>
> = new Map([
  ["DRAFT", new Set<OutcomeJobState>(["QUALIFIED"])],
  ["QUALIFIED", new Set<OutcomeJobState>(["READY"])],
  ["READY", new Set<OutcomeJobState>(["EXECUTING"])],
  ["EXECUTING", new Set<OutcomeJobState>(["VERIFYING"])],
  ["VERIFYING", new Set<OutcomeJobState>()],
  ["VERIFIED", new Set<OutcomeJobState>(["CLOSED"])],
  ["CLOSED", new Set<OutcomeJobState>()],
  ["BLOCKED", new Set<OutcomeJobState>()],
  ["RECOVERING", new Set<OutcomeJobState>()],
  ["ESCALATED", new Set<OutcomeJobState>()],
  ["STOPPED", new Set<OutcomeJobState>()],
]);

export function transitionOutcomeJob(
  job: OutcomeJob,
  to: OutcomeJobState,
): OutcomeJob {
  const allowed = MAIN_PATH_TRANSITIONS.get(job.state);
  if (!allowed || !allowed.has(to)) {
    throw new InvalidOutcomeJobTransitionError(job.state, to);
  }
  return { ...job, state: to };
}

export class MissingVerificationEvidenceError extends Error {
  constructor(jobId: OutcomeJob["jobId"]) {
    super(
      `OutcomeJob ${jobId} cannot become VERIFIED without a VerificationResult`,
    );
    this.name = "MissingVerificationEvidenceError";
  }
}

export class VerificationNotPassedError extends Error {
  constructor(jobId: OutcomeJob["jobId"], status: string) {
    super(
      `OutcomeJob ${jobId} cannot become VERIFIED: verification status is ${status}, not PASSED`,
    );
    this.name = "VerificationNotPassedError";
  }
}

/**
 * T5/T6: the only way to move an OutcomeJob from VERIFYING to VERIFIED.
 *
 * T5: fails when required verification evidence is absent - either no
 * VerificationResult was supplied, or it exists but its status is not
 * PASSED (a FAILED/limited result is present evidence of non-verification,
 * not proof of verification).
 * T6: succeeds only when a VerificationResult for this exact job has
 * status PASSED.
 */
export function verifyOutcomeJob(
  job: OutcomeJob,
  verificationResult: VerificationResult | undefined,
): OutcomeJob {
  if (job.state !== "VERIFYING") {
    throw new InvalidOutcomeJobTransitionError(job.state, "VERIFIED");
  }
  if (verificationResult === undefined) {
    throw new MissingVerificationEvidenceError(job.jobId);
  }
  if (verificationResult.jobId !== job.jobId) {
    throw new InvalidOutcomeJobError(
      "verificationResult does not correspond to this OutcomeJob",
    );
  }
  if (verificationResult.tenantId !== job.tenantId) {
    throw new InvalidOutcomeJobError(
      "verificationResult does not belong to this OutcomeJob's tenant",
    );
  }
  if (verificationResult.status !== "PASSED") {
    throw new VerificationNotPassedError(job.jobId, verificationResult.status);
  }
  return { ...job, state: "VERIFIED" };
}

export class InvalidExceptionStateEntryError extends Error {
  constructor(reason: string) {
    super(`Invalid exception-state entry: ${reason}`);
    this.name = "InvalidExceptionStateEntryError";
  }
}

type ExceptionState = "BLOCKED" | "RECOVERING" | "ESCALATED" | "STOPPED";

const EXCEPTION_STATES: ReadonlySet<OutcomeJobState> = new Set<OutcomeJobState>([
  "BLOCKED",
  "RECOVERING",
  "ESCALATED",
  "STOPPED",
]);

/**
 * T7: the one thing the canonical source actually specifies about
 * exception states is that entering one preserves an auditable
 * transition reason. This function implements exactly that - and
 * nothing about exit/recovery: the source does not specify which
 * states an exception state can return to, or whether BLOCKED /
 * RECOVERING / ESCALATED / STOPPED differ from each other in that
 * respect, so no such graph is implemented or guessed here (this
 * checkpoint's explicit instruction: do not invent the unspecified
 * recovery/exception transition graph).
 *
 * Only two preconditions are asserted, both directly implied by
 * material already in this file rather than invented:
 * - A `CLOSED` job cannot enter an exception state (`CLOSED` already
 *   has no outbound edges in `MAIN_PATH_TRANSITIONS`).
 * - A job already in an exception state cannot "enter" one again
 *   (entry is a meaningful transition, not a no-op re-entry).
 *
 * `reason` is required (not optional) and preserved verbatim on the
 * returned `AuditEvent` - that preservation is the entire, specified
 * point of this function.
 */
export function enterExceptionState(input: {
  job: OutcomeJob;
  to: unknown;
  eventId: unknown;
  actorRef: unknown;
  timestamp: unknown;
  reason: unknown;
}): { job: OutcomeJob; auditEvent: AuditEvent } {
  if (input.job.state === "CLOSED") {
    throw new InvalidExceptionStateEntryError(
      "a CLOSED OutcomeJob cannot enter an exception state",
    );
  }
  if (EXCEPTION_STATES.has(input.job.state)) {
    throw new InvalidExceptionStateEntryError(
      `OutcomeJob is already in exception state ${input.job.state}`,
    );
  }
  if (
    typeof input.to !== "string" ||
    !EXCEPTION_STATES.has(input.to as OutcomeJobState)
  ) {
    throw new InvalidExceptionStateEntryError(
      "to must be one of BLOCKED, RECOVERING, ESCALATED, STOPPED",
    );
  }
  const to: ExceptionState = input.to as ExceptionState;
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new InvalidExceptionStateEntryError(
      "reason is required and must be a non-empty string (T7: transition reason must be preserved)",
    );
  }

  const updatedJob: OutcomeJob = { ...input.job, state: to };
  const auditEvent = createAuditEvent({
    job: input.job,
    eventId: input.eventId,
    actorRef: input.actorRef,
    eventType: `EXCEPTION_STATE_ENTERED:${to}`,
    timestamp: input.timestamp,
    reason: input.reason,
  });
  return { job: updatedJob, auditEvent };
}

export class InvalidExceptionRecoveryError extends Error {
  constructor(reason: string) {
    super(`Invalid exception-state recovery: ${reason}`);
    this.name = "InvalidExceptionRecoveryError";
  }
}

/**
 * SALE-TO-CLOSE Rev91/92/93/94: the mandatory "temporary provider/
 * execution failure recovery" acceptance case, explicitly authorized as a
 * bounded extension of this already-closed/VERIFIED state contract rather
 * than a Founder-gated question. This is the SMALLEST addition that
 * satisfies it - not a general exception-exit graph, and not a second
 * workflow/state system:
 *
 * - Only `BLOCKED` and `RECOVERING` are recoverable through this path.
 *   Rev91's own text names these two states specifically as "temporary"
 *   exception states; `ESCALATED` (implies a human decision path this
 *   function does not model) and `STOPPED` (a governed terminal
 *   disposition - see `applyExternalSaleDisposition` in
 *   `external-sale-bootstrap.ts` - that must never be silently undone "as
 *   though nothing happened") are both deliberately excluded, not merely
 *   forgotten.
 * - The recovery target (`to`) is restricted to `READY`, `EXECUTING`, or
 *   `VERIFYING` - every state that still requires passing through the
 *   unmodified, separate `verifyOutcomeJob` gate to ever reach `VERIFIED`.
 *   `VERIFIED` and `CLOSED` are structurally unreachable as recovery
 *   targets, so recovery can never bypass execution or verification by
 *   construction, not merely by convention.
 * - Recovery requires both an explicit `AuthorityContext` with
 *   `canPerformProtectedActions: true` (reusing `authority.ts`'s existing
 *   protected-action gate - the same primitive `governed-evaluation-
 *   loop.ts`'s MATERIAL-change path already uses, not a new authority
 *   system) and a non-empty `evidenceRef` - "recovery must require
 *   sufficient evidence/authority" is enforced, not merely documented.
 * - It always produces a new `AuditEvent` (via the same `createAuditEvent`
 *   every other transition in this file uses) recording the exact
 *   `from -> to` transition, the reason, and the evidence reference as a
 *   `relatedRefs` entry - the prior exception-entry `AuditEvent` this
 *   recovers from is a separate, already-returned object this function
 *   never touches or erases, so the full audit trail (entry then
 *   recovery) is preserved by construction as long as a caller persists
 *   both, exactly as it already must for every other transition here.
 */
const RECOVERABLE_EXCEPTION_STATES: ReadonlySet<OutcomeJobState> = new Set<OutcomeJobState>([
  "BLOCKED",
  "RECOVERING",
]);

const RECOVERY_TARGET_STATES: ReadonlySet<OutcomeJobState> = new Set<OutcomeJobState>([
  "READY",
  "EXECUTING",
  "VERIFYING",
]);

export function recoverFromExceptionState(input: {
  job: OutcomeJob;
  authority: AuthorityContext;
  to: unknown;
  eventId: unknown;
  actorRef: unknown;
  timestamp: unknown;
  reason: unknown;
  evidenceRef: unknown;
}): { job: OutcomeJob; auditEvent: AuditEvent } {
  requireSameTenant(input.authority, input.job.tenantId);
  if (!RECOVERABLE_EXCEPTION_STATES.has(input.job.state)) {
    throw new InvalidExceptionRecoveryError(
      `only a job in BLOCKED or RECOVERING can be recovered through this governed path; current state: ${input.job.state}`,
    );
  }
  requireProtectedActionAuthorization(input.authority, "recoverFromExceptionState");

  if (typeof input.to !== "string" || !RECOVERY_TARGET_STATES.has(input.to as OutcomeJobState)) {
    throw new InvalidExceptionRecoveryError(
      "to must be one of READY, EXECUTING, VERIFYING - recovery can never bypass execution or verification",
    );
  }
  const to = input.to as OutcomeJobState;

  if (typeof input.evidenceRef !== "string" || input.evidenceRef.trim().length === 0) {
    throw new InvalidExceptionRecoveryError(
      "evidenceRef is required and must be a non-empty string - recovery must be evidence-backed",
    );
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new InvalidExceptionRecoveryError("reason is required and must be a non-empty string");
  }

  const fromState = input.job.state;
  const recoveredJob: OutcomeJob = { ...input.job, state: to };
  const auditEvent = createAuditEvent({
    job: input.job,
    eventId: input.eventId,
    actorRef: input.actorRef,
    eventType: `EXCEPTION_STATE_RECOVERED:${fromState}->${to}`,
    timestamp: input.timestamp,
    reason: input.reason,
    relatedRefs: [input.evidenceRef],
  });
  return { job: recoveredJob, auditEvent };
}
