import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import { requireSameTenant, requirePermission, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";
import type { ProtectedDecisionRecord } from "./protected-decision-record.js";

export class InvalidProtectedDecisionWaitRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid ProtectedDecisionWaitRequest: ${reason}`);
    this.name = "InvalidProtectedDecisionWaitRequestError";
  }
}

export class ProtectedDecisionWaitStaleError extends Error {
  constructor(reason: string) {
    super(`Protected-decision WAIT resume refused - stale currentness: ${reason}`);
    this.name = "ProtectedDecisionWaitStaleError";
  }
}

type WaitRequestId = string & { readonly __brand: "ProtectedDecisionWaitRequestId" };

/**
 * OS-V0-10 benchmark-audit amendment: "minimum durable authenticated
 * protected-decision/approval WAIT→RESUME gate when a real protected human
 * decision is activated; exact effect/request binding, single-use/
 * idempotent resume and currentness recheck before effect." Mirrors
 * `ApprovalReference`'s own exact-identity-binding discipline
 * (`approval-reference.ts`) rather than inventing a parallel approval
 * ledger: one `ProtectedDecisionWaitRequest` binds exactly one effect
 * (`effectRef`, opaque to this module - a `TaskPacket.nextAuthorizedAction`,
 * an `ExternalEffectIntent.effectIntentId`, or any other caller-meaningful
 * handle) to the exact job/run/attempt it was raised for, plus the
 * activation fingerprint that was current AT WAIT TIME - never a generic
 * workflow-engine WAIT state.
 */
export interface ProtectedDecisionWaitRequest {
  readonly waitRequestId: WaitRequestId;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly runId: string;
  readonly attempt: number;
  readonly effectRef: string;
  readonly decisionRef: string;
  readonly reason: string;
  readonly activationFingerprintAtWait: string;
  readonly raisedAt: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidProtectedDecisionWaitRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Raising a wait is never itself authority-gated - any EXECUTE-permitted
 * caller may durably record that a protected decision is needed (fail
 * CLOSED by pausing is always safe); only RESUMING one requires protected-
 * action authorization. `attempt` must be a positive integer - this binds
 * to a real, already-started execution attempt, never attempt 0 or a
 * negative/fabricated one.
 */
export function createProtectedDecisionWaitRequest(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  job: OutcomeJob;
  waitRequestId: unknown;
  runId: unknown;
  attempt: unknown;
  effectRef: unknown;
  decisionRef: unknown;
  reason: unknown;
  activationFingerprintAtWait: unknown;
  raisedAt: unknown;
}): ProtectedDecisionWaitRequest {
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProtectedDecisionWaitRequestError("customer does not belong to the given tenantScope");
  }
  if (input.project.tenantId !== input.tenantScope.tenantId || input.project.customerId !== input.customer.customerId) {
    throw new InvalidProtectedDecisionWaitRequestError("project does not belong to the given tenantScope/customer");
  }
  if (
    input.job.tenantId !== input.tenantScope.tenantId ||
    input.job.customerId !== input.customer.customerId ||
    input.job.projectId !== input.project.projectId
  ) {
    throw new InvalidProtectedDecisionWaitRequestError("job does not belong to the given tenantScope/customer/project");
  }
  if (typeof input.attempt !== "number" || !Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new InvalidProtectedDecisionWaitRequestError("attempt must be a positive integer");
  }
  return {
    waitRequestId: requireNonEmptyString(input.waitRequestId, "waitRequestId") as WaitRequestId,
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    jobId: input.job.jobId,
    runId: requireNonEmptyString(input.runId, "runId"),
    attempt: input.attempt,
    effectRef: requireNonEmptyString(input.effectRef, "effectRef"),
    decisionRef: requireNonEmptyString(input.decisionRef, "decisionRef"),
    reason: requireNonEmptyString(input.reason, "reason"),
    activationFingerprintAtWait: requireNonEmptyString(input.activationFingerprintAtWait, "activationFingerprintAtWait"),
    raisedAt: requireNonEmptyString(input.raisedAt, "raisedAt"),
  };
}

/**
 * Rev186 F3: the single-use resume authorization a durable store's
 * `putIfAbsent` produces exactly once per `waitRequestId` - see
 * `durable-protected-decision-wait-store.ts`. This domain module never
 * persists anything itself; it only validates the decision at the exact
 * moment of resume. `resolvedByPrincipalRef` is the current authenticated
 * principal's own membership identity (never a bare caller-supplied label),
 * and `decisionRef`/`decisionEvidenceRef` are carried forward verbatim from
 * the exact durable `ProtectedDecisionRecord` that authorized this resume.
 */
export interface ProtectedDecisionResumeAuthorization {
  readonly waitRequestId: WaitRequestId;
  readonly effectRef: string;
  readonly resolvedAt: string;
  readonly resolvedByPrincipalRef: string;
  readonly decisionRef: string;
  readonly decisionEvidenceRef: string;
}

/**
 * "Resume must re-resolve current authority/config/connection/quota before
 * effect" (packet's own text). Rev186 F3 widened this gate's own two
 * checks; Rev187 F3b widens the second again - a decision "outcome" is no
 * longer a bare caller-constructed object of strings, it is a real durable
 * `ProtectedDecisionRecord` (`protected-decision-record.ts`) the caller
 * must have already fetched from `DurableProtectedDecisionRecordStore`
 * (this function itself has no persistence, so it cannot fetch one):
 *
 * 1. `access` must be a current, GRANTED `EffectiveAccessResolution`
 *    (`effective-organization-access.ts`) bound to a real
 *    `OrganizationMembership` - never a bare caller-supplied `authorityId`
 *    string. `access.membershipId` becomes `resolvedByPrincipalRef`: the
 *    current authenticated principal who performed this resume, not an
 *    unauthenticated label.
 * 2. `decisionRecord` must be a real durable `ProtectedDecisionRecord` for
 *    the SAME tenant as this wait (a foreign-tenant record can never
 *    resume it), whose own `decisionRef` exactly equals
 *    `waitRequest.decisionRef` (a record for a different decision can
 *    never resume this wait), and whose `outcome` is exactly `"APPROVED"`
 *    - a `"DENIED"` or `"REVOKED"` record fails closed just as certainly
 *    as no record at all (the caller fetching `undefined` from the
 *    durable store is an even earlier fail-closed point, before this
 *    function is even called - see `resume-protected-decision-for-
 *    connector-effect.ts`).
 *
 * The existing activation-fingerprint currentness check is unchanged (the
 * same `assertCurrentActivation` discipline `outcome-job-execution-
 * runtime.ts` already established, reapplied here for the WAIT/RESUME
 * edge). Connection/quota currentness, where applicable to a specific
 * protected-effect consumer, is re-resolved by that consumer itself
 * immediately before invoking its own effect (see
 * `resume-protected-decision-for-connector-effect.ts`) - this generic gate
 * has no dependency on any one effect family's own currentness dimensions.
 * The caller-supplied durable store's own `claimResume` is what then
 * actually makes resume single-use/idempotent (this function alone cannot
 * enforce that - it has no persistence).
 */
export function authorizeProtectedDecisionResume(input: {
  readonly waitRequest: ProtectedDecisionWaitRequest;
  readonly access: EffectiveAccessResolution;
  readonly authority: AuthorityContext;
  readonly decisionRecord: ProtectedDecisionRecord;
  readonly currentActivationFingerprint: string;
  readonly now: unknown;
}): ProtectedDecisionResumeAuthorization {
  requireSameTenant(input.authority, input.waitRequest.tenantId);
  requirePermission(input.authority, "EXECUTE");
  requireProtectedActionAuthorization(input.authority, "authorizeProtectedDecisionResume");
  if (input.access.decision !== "GRANTED") {
    throw new ProtectedDecisionWaitStaleError("access must be a GRANTED EffectiveAccessResolution to resume a protected decision");
  }
  if (input.access.tenantId !== input.waitRequest.tenantId) {
    throw new ProtectedDecisionWaitStaleError("access does not belong to the given waitRequest's own tenant");
  }
  if (input.access.membershipId === undefined) {
    throw new ProtectedDecisionWaitStaleError(
      "access must be bound to a real OrganizationMembership (a current authenticated principal) to resume a protected decision",
    );
  }
  if (input.decisionRecord.tenantId !== input.waitRequest.tenantId) {
    throw new ProtectedDecisionWaitStaleError(
      "decisionRecord does not belong to the given waitRequest's own tenant - a foreign-tenant decision record can never resume this wait",
    );
  }
  if (input.decisionRecord.decisionRef !== input.waitRequest.decisionRef) {
    throw new ProtectedDecisionWaitStaleError(
      `decisionRecord.decisionRef "${input.decisionRecord.decisionRef}" does not match this wait's own decisionRef "${input.waitRequest.decisionRef}" - a decision record for a different decision can never resume this wait`,
    );
  }
  if (input.decisionRecord.outcome !== "APPROVED") {
    throw new ProtectedDecisionWaitStaleError(
      `decisionRecord's own outcome is "${input.decisionRecord.outcome}", not "APPROVED" - a denied or revoked decision can never resume this wait`,
    );
  }
  if (input.currentActivationFingerprint !== input.waitRequest.activationFingerprintAtWait) {
    throw new ProtectedDecisionWaitStaleError(
      `activation fingerprint changed since this wait was raised (at-wait: "${input.waitRequest.activationFingerprintAtWait}", current: "${input.currentActivationFingerprint}") - re-raise a fresh wait against current context instead of resuming this stale one`,
    );
  }
  return {
    waitRequestId: input.waitRequest.waitRequestId,
    effectRef: input.waitRequest.effectRef,
    resolvedAt: requireNonEmptyString(input.now, "now"),
    resolvedByPrincipalRef: input.access.membershipId,
    decisionRef: input.decisionRecord.decisionRef,
    decisionEvidenceRef: input.decisionRecord.evidenceRef,
  };
}
