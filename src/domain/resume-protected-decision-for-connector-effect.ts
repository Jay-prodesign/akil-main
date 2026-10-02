import type { TenantScope } from "./tenant-scope.js";
import {
  authorizeProtectedDecisionResume,
  type ProtectedDecisionWaitRequest,
  type ProtectedDecisionResumeAuthorization,
} from "./protected-decision-wait-gate.js";
import type { DurableProtectedDecisionWaitStore } from "./durable-protected-decision-wait-store.js";
import type { DurableProtectedDecisionRecordStore } from "./durable-protected-decision-record-store.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";
import type { AuthorityContext } from "./authority.js";
import {
  executeConnectorCapabilityAsVerifiedEffect,
  type VerifiedConnectorEffectOutcome,
  type ConnectorCapabilityReadback,
} from "./connector-capability-verified-effect.js";
import type { executeConnectorCapability, ConnectorTransport, SecretResolver, CurrentConnectorConnectionReader } from "./connector-execution.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { ExternalEffectRetryClassification } from "./external-effect-envelope.js";
import type { QuotaAdmissionPort } from "../application/outcome-job-execution-runtime.js";
import {
  createQuotaReservationIdentity,
  deriveQuotaReservationIdempotencyKey,
  assertCurrentQuotaEnvelope,
  type QuotaEnvelope,
} from "./execution-quota-admission.js";

export class ProtectedDecisionRecordNotFoundError extends Error {
  constructor(tenantId: string, decisionRef: string) {
    super(`No durable ProtectedDecisionRecord exists for tenant "${tenantId}" decisionRef "${decisionRef}" - absent decision evidence can never resume a protected decision`);
    this.name = "ProtectedDecisionRecordNotFoundError";
  }
}

export class ProtectedEffectBindingMismatchError extends Error {
  constructor(waitEffectRef: string, actualEffectIntentId: string) {
    super(
      `waitRequest.effectRef "${waitEffectRef}" does not identify the exact effectIntentId "${actualEffectIntentId}" passed to this resume call - a wait for one effect can never execute a different effect`,
    );
    this.name = "ProtectedEffectBindingMismatchError";
  }
}

export class ProtectedEffectQuotaRejectedError extends Error {
  constructor(reason: string) {
    super(`Protected-effect resume refused - quota admission rejected: ${reason}`);
    this.name = "ProtectedEffectQuotaRejectedError";
  }
}

/**
 * Rev186 F3: "prove one real protected-effect path consumes [the resume
 * claim] once." This is that one real consumer - it binds WAIT→RESUME
 * directly to the one real protected-effect wrapper this task built
 * (`executeConnectorCapabilityAsVerifiedEffect`, Live Gap C1), so the
 * durable store's own single-use `claimResume` is what decides whether the
 * connector transport is ever invoked at all, not merely whether the same
 * authorization value is returned twice.
 *
 * `claimResume` is called only AFTER every currentness/binding check below
 * passes - only the call that durably wins the claim (`created: true`)
 * proceeds to the real effect. A second call for the same `waitRequestId`
 * (ours replayed, or a concurrent racer) finds `created: false` and returns
 * `ALREADY_RESUMED_NO_EFFECT` without ever invoking the transport - this is
 * the atomicity "returning the same authorization repeatedly" alone could
 * not prove.
 *
 * Rev187 residuals, all closed in this one consumer:
 *
 * - **F3a (exact-effect binding)**: `waitRequest.effectRef` must identify
 *   the EXACT `effectIntentId` this call is about to execute - checked
 *   BEFORE the durable decision-record lookup, the resume authorization,
 *   and the claim, so a wait for effect A can never win `claimResume` or
 *   invoke the transport for a different effect B.
 * - **F3b (durable decision)**: the durable `ProtectedDecisionRecord` for
 *   this exact `(tenantId, decisionRef)` is fetched fresh from
 *   `decisionRecordStore` immediately before use (never cached across
 *   calls, so a later-recorded REVOKED/DENIED record is always observed) -
 *   absent is the earliest fail-closed point, before
 *   `authorizeProtectedDecisionResume` even runs (which itself rejects a
 *   foreign-tenant, mismatched, or non-`"APPROVED"` record).
 * - **F3c (quota currentness)**: `assertCurrentQuotaEnvelope` plus a real
 *   `quotaAdmission.admit(...)` call (the SAME `QuotaAdmissionPort`/
 *   `QuotaReservationIdentity` primitives `outcome-job-execution-
 *   runtime.ts`'s own dispatch already composes, reused verbatim - no
 *   second quota system) - a stale envelope or a `REJECTED` admission
 *   blocks the effect with zero transport invocation, checked before the
 *   durable claim exactly like activation currentness. Config/policy
 *   currentness beyond the activation-fingerprint re-check
 *   `authorizeProtectedDecisionResume` already performs has no dedicated
 *   existing "current" resolver this consumer can compose without
 *   fabricating one (`resolveEffectiveConfigurationPolicy` is a pure
 *   precedence resolver over a caller-supplied control snapshot, not a
 *   queryable "current controls for this tenant" source) - honestly
 *   disclosed here rather than invented. Connection currentness remains
 *   re-checked by `executeConnectorCapability` itself (unchanged, always
 *   re-reads the CURRENT durable connection record - never a caller
 *   snapshot).
 */
export type ResumeAndExecuteConnectorEffectResult =
  | { readonly kind: "EFFECT_EXECUTED"; readonly outcome: VerifiedConnectorEffectOutcome; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "ALREADY_RESUMED_NO_EFFECT"; readonly resume: ProtectedDecisionResumeAuthorization };

export async function resumeProtectedDecisionAndExecuteConnectorEffect(input: {
  readonly waitStore: DurableProtectedDecisionWaitStore;
  readonly decisionRecordStore: DurableProtectedDecisionRecordStore;
  readonly waitRequest: ProtectedDecisionWaitRequest;
  readonly access: EffectiveAccessResolution;
  readonly authority: AuthorityContext;
  readonly currentActivationFingerprint: string;
  readonly now: unknown;
  readonly tenantScope: TenantScope;
  readonly effectIntentId: unknown;
  readonly actionRef: unknown;
  readonly retryClassification: ExternalEffectRetryClassification;
  readonly attemptId: unknown;
  readonly approvalEvidenceRef?: unknown;
  readonly bound: Parameters<typeof executeConnectorCapability>[0]["bound"];
  readonly capabilityRef: unknown;
  readonly requestingOwnership: ProjectOwnershipRef;
  readonly connectionStore: CurrentConnectorConnectionReader;
  readonly secretResolver: SecretResolver;
  readonly transport: ConnectorTransport;
  readonly requestPayload?: unknown;
  readonly readback: ConnectorCapabilityReadback;
  readonly quotaAdmission: QuotaAdmissionPort;
  readonly quotaEnvelope: QuotaEnvelope;
  readonly currentQuotaSourceFingerprint: string;
  readonly estimatedCost: { readonly presence: unknown; readonly amountMinorUnits?: unknown; readonly currency?: unknown };
}): Promise<ResumeAndExecuteConnectorEffectResult> {
  // F3a: exact effect/request binding - checked before anything else below
  // even reads the durable decision record.
  const effectIntentId = typeof input.effectIntentId === "string" ? input.effectIntentId : String(input.effectIntentId);
  if (input.waitRequest.effectRef !== effectIntentId) {
    throw new ProtectedEffectBindingMismatchError(input.waitRequest.effectRef, effectIntentId);
  }

  // F3b: a fresh durable decision-record lookup, immediately before use.
  const decisionRecord = input.decisionRecordStore.getDecisionRecord(input.waitRequest.tenantId, input.waitRequest.decisionRef);
  if (decisionRecord === undefined) {
    throw new ProtectedDecisionRecordNotFoundError(input.waitRequest.tenantId, input.waitRequest.decisionRef);
  }

  const authorization = authorizeProtectedDecisionResume({
    waitRequest: input.waitRequest,
    access: input.access,
    authority: input.authority,
    decisionRecord,
    currentActivationFingerprint: input.currentActivationFingerprint,
    now: input.now,
  });

  // F3c: quota currentness/admission, re-resolved immediately before the
  // durable claim - exactly where activation currentness is also checked
  // (inside authorizeProtectedDecisionResume above), before any single-use
  // commitment is made.
  assertCurrentQuotaEnvelope(input.quotaEnvelope, input.currentQuotaSourceFingerprint);
  const quotaIdentity = createQuotaReservationIdentity({
    scope: input.quotaEnvelope.scope,
    jobId: input.waitRequest.jobId as unknown as string,
    runId: input.waitRequest.runId,
    attemptRef: String(input.waitRequest.attempt),
  });
  const quotaIdempotencyKey = deriveQuotaReservationIdempotencyKey(quotaIdentity);
  const quotaDecision = await input.quotaAdmission.admit({
    envelope: input.quotaEnvelope,
    identity: quotaIdentity,
    idempotencyKey: quotaIdempotencyKey,
    requestedAmount: input.estimatedCost,
    occurredAt: input.now,
  });
  if (quotaDecision.status === "REJECTED") {
    throw new ProtectedEffectQuotaRejectedError(quotaDecision.event.reason ?? "quota admission rejected this reservation");
  }

  const claim = input.waitStore.claimResume(input.waitRequest.tenantId, input.waitRequest.waitRequestId, authorization);
  if (!claim.created) {
    return { kind: "ALREADY_RESUMED_NO_EFFECT", resume: claim.value };
  }

  const outcome = executeConnectorCapabilityAsVerifiedEffect({
    tenantScope: input.tenantScope,
    authority: input.authority,
    effectIntentId: input.effectIntentId,
    actionRef: input.actionRef,
    retryClassification: input.retryClassification,
    attemptId: input.attemptId,
    ...(input.approvalEvidenceRef !== undefined ? { approvalEvidenceRef: input.approvalEvidenceRef } : {}),
    bound: input.bound,
    capabilityRef: input.capabilityRef,
    requestingOwnership: input.requestingOwnership,
    connectionStore: input.connectionStore,
    secretResolver: input.secretResolver,
    transport: input.transport,
    ...(input.requestPayload !== undefined ? { requestPayload: input.requestPayload } : {}),
    readback: input.readback,
  });
  return { kind: "EFFECT_EXECUTED", outcome, resume: claim.value };
}
