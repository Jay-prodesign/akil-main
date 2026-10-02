import type { TenantScope } from "./tenant-scope.js";
import {
  authorizeProtectedDecisionResume,
  type ProtectedDecisionWaitRequest,
  type ProtectedDecisionResumeAuthorization,
} from "./protected-decision-wait-gate.js";
import type { DurableProtectedDecisionWaitStore } from "./durable-protected-decision-wait-store.js";
import type { DurableProtectedDecisionRecordStore } from "./durable-protected-decision-record-store.js";
import { resolveEffectiveOrganizationAccess } from "./effective-organization-access.js";
import type { Organization } from "./organization.js";
import type { OrganizationMembership } from "./organization-membership.js";
import type { OrganizationAccessRoleContext } from "./organization-access-role.js";
import type { AuthorityContext } from "./authority.js";
import {
  executeConnectorCapabilityAsVerifiedEffect,
  type VerifiedConnectorEffectOutcome,
  type ConnectorCapabilityReadback,
} from "./connector-capability-verified-effect.js";
import type { executeConnectorCapability, ConnectorTransport, SecretResolver, CurrentConnectorConnectionReader } from "./connector-execution.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { ExternalEffectRetryClassification } from "./external-effect-envelope.js";
import type { QuotaAdmissionPort, CurrentQuotaEnvelopeResolver, ExecutionEconomicsPort } from "../application/outcome-job-execution-runtime.js";
import {
  createQuotaReservationIdentity,
  deriveQuotaReservationIdempotencyKey,
  assertCurrentQuotaEnvelope,
  quotaScopeKey,
  type QuotaEnvelope,
  type QuotaAdmissionScope,
} from "./execution-quota-admission.js";
import { createExecutionEconomicsLineage, recordExecutionEconomicsEvent } from "./execution-economics-attribution.js";

export class ProtectedDecisionRecordNotFoundError extends Error {
  constructor(tenantId: string, decisionRef: string) {
    super(`No durable ProtectedDecisionRecord exists for tenant "${tenantId}" decisionRef "${decisionRef}" - absent decision evidence can never resume a protected decision`);
    this.name = "ProtectedDecisionRecordNotFoundError";
  }
}

export class ProtectedEffectBindingMismatchError extends Error {
  constructor(waitEffectRef: string, actualEffectFingerprint: string) {
    super(
      `waitRequest.effectRef "${waitEffectRef}" does not identify the exact connector-effect fingerprint "${actualEffectFingerprint}" (effectIntentId/actionRef/retryClassification/capabilityRef/connectionBindingId/requestPayload) this resume call is about to execute - a wait raised for one effect, action, capability, connection, or request body can never execute a substituted one`,
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
 * Rev188 F3-item5 (quota lineage): mirrors `outcome-job-execution-runtime.ts`'s
 * own (unexported) `assertQuotaScopeMatchesActivationLineage` exactly - same
 * tuple, same comparison - reimplemented here using only the primitives this
 * domain file may import (`QuotaAdmissionScope` alone; the runtime's own
 * class is an application-layer export this domain file must not take a
 * value dependency on). Binds `quotaEnvelope.scope` to THIS wait's own real
 * tenant/customer/project identity plus the caller's freshly-resolved
 * current activation plan lineage - never a parallel identity shape, and
 * never merely trusted from the caller-supplied scope alone.
 */
export class ProtectedEffectQuotaLineageMismatchError extends Error {
  constructor(
    scope: { readonly tenantId: string; readonly customerId: string; readonly projectId: string; readonly planId: string; readonly planVersion: number },
    activation: { readonly tenantId: string; readonly customerId: string; readonly projectId: string; readonly planId: string; readonly planVersion: number },
  ) {
    super(
      `quota admission scope (tenant "${scope.tenantId}", customer "${scope.customerId}", project "${scope.projectId}", plan "${scope.planId}"@${scope.planVersion}) does not match this protected-decision wait's own current activation lineage (tenant "${activation.tenantId}", customer "${activation.customerId}", project "${activation.projectId}", plan "${activation.planId}"@${activation.planVersion}) - a quota scope bound to a foreign or stale activation can never fund this effect`,
    );
    this.name = "ProtectedEffectQuotaLineageMismatchError";
  }
}

/**
 * Rev188 F3-item3: the canonical exact-effect binding this WAIT->RESUME gate
 * enforces. Rev187 F3a bound `waitRequest.effectRef` to the bare
 * `effectIntentId` alone - a substitution attack that kept the SAME
 * `effectIntentId` while swapping `actionRef`/`capabilityRef`/
 * `connectionBindingId`/`requestPayload` underneath it would still pass
 * that check. This fingerprint instead covers every caller-meaningful
 * dimension of "what effect is this", using the same collision-safe
 * `JSON.stringify`-of-ordered-tuple convention this codebase already
 * establishes for every other cross-module idempotency/event key
 * (`quotaScopeKey`, `deriveQuotaReservationEventId`, etc.). Exported so the
 * SAME fingerprint can be computed once at WAIT-RAISE time (bound to
 * `waitRequest.effectRef`) and recomputed here at RESUME time for
 * comparison - never two independent encodings of the same identity that
 * could drift out of sync.
 */
export function computeConnectorEffectFingerprint(input: {
  readonly effectIntentId: unknown;
  readonly actionRef: unknown;
  readonly retryClassification: unknown;
  readonly capabilityRef: unknown;
  readonly connectionBindingId: unknown;
  readonly requestPayload?: unknown;
}): string {
  const effectIntentId = typeof input.effectIntentId === "string" ? input.effectIntentId : String(input.effectIntentId);
  return JSON.stringify([
    effectIntentId,
    input.actionRef,
    input.retryClassification,
    input.capabilityRef,
    input.connectionBindingId,
    input.requestPayload ?? null,
  ]);
}

function assertQuotaScopeMatchesWaitLineage(input: {
  readonly scope: QuotaAdmissionScope;
  readonly waitRequest: ProtectedDecisionWaitRequest;
  readonly currentActivationPlanId: string;
  readonly currentActivationPlanVersion: number;
}): void {
  if (
    input.scope.tenantId !== input.waitRequest.tenantId ||
    input.scope.customerId !== input.waitRequest.customerId ||
    input.scope.projectId !== input.waitRequest.projectId ||
    input.scope.planId !== input.currentActivationPlanId ||
    input.scope.planVersion !== input.currentActivationPlanVersion
  ) {
    throw new ProtectedEffectQuotaLineageMismatchError(
      {
        tenantId: input.scope.tenantId,
        customerId: input.scope.customerId,
        projectId: input.scope.projectId,
        planId: input.scope.planId,
        planVersion: input.scope.planVersion,
      },
      {
        tenantId: input.waitRequest.tenantId,
        customerId: input.waitRequest.customerId,
        projectId: input.waitRequest.projectId,
        planId: input.currentActivationPlanId,
        planVersion: input.currentActivationPlanVersion,
      },
    );
  }
}

/**
 * Rev188 F3-item5 (latest-moment recheck): mirrors `outcome-job-execution-
 * runtime.ts`'s own (unexported) `assertQuotaStillCurrentBeforeEffect` -
 * called exactly once, immediately before `executeConnectorCapabilityAsVerifiedEffect`,
 * the latest possible moment before real effect. Compares the FRESHLY
 * resolved current envelope against the exact envelope this reservation was
 * durably admitted against - never against a possibly-now-stale caller
 * input re-read later.
 */
async function quotaStillCurrentImmediatelyBeforeEffect(input: {
  readonly quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver;
  readonly reservedEnvelope: QuotaEnvelope;
}): Promise<boolean> {
  const freshEnvelope = await input.quotaEnvelopeResolver.resolveCurrentQuotaEnvelope();
  return (
    quotaScopeKey(freshEnvelope.scope) === quotaScopeKey(input.reservedEnvelope.scope) &&
    freshEnvelope.envelopeRef === input.reservedEnvelope.envelopeRef &&
    freshEnvelope.sourceFingerprint === input.reservedEnvelope.sourceFingerprint
  );
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
 * `ALREADY_RESUMED_NO_EFFECT` without ever invoking the transport.
 *
 * Rev187/Rev188 residuals, all closed in this one consumer:
 *
 * - **F3a/item3 (exact-effect binding)**: `waitRequest.effectRef` must
 *   equal a canonical fingerprint covering `effectIntentId`/`actionRef`/
 *   `retryClassification`/`capabilityRef`/`connectionBindingId`/
 *   `requestPayload` (`computeConnectorEffectFingerprint`) - checked BEFORE
 *   the durable decision-record lookup, the resume authorization, and the
 *   claim, so a wait for one exact effect/action/capability/connection/
 *   payload can never win `claimResume` or invoke the transport for a
 *   substituted one.
 * - **F3b (durable decision)**: the durable `ProtectedDecisionRecord` for
 *   this exact `(tenantId, decisionRef)` is fetched fresh from
 *   `decisionRecordStore` immediately before use.
 * - **item2 (authenticated access)**: this function never accepts a
 *   precomputed `EffectiveAccessResolution` - `resolveEffectiveOrganizationAccess`'s
 *   own doc comment is explicit that re-invoking it with CURRENT inputs is
 *   the only way to obtain a current answer. Callers instead pass the raw
 *   `organization`/`membership`/`currentPrincipalRef`/`roleContext`
 *   ingredients (mirroring `mutateConnectorConnectionStateAsAdmin`'s own
 *   Rev187 F2 fix exactly), and this function re-resolves access itself,
 *   immediately before `authorizeProtectedDecisionResume` - a membership
 *   revoked (or role withdrawn) since an earlier resolution is caught here,
 *   not silently honored from a stale cached grant. A forged identity (no
 *   real authenticated session behind the supplied membership/principal) is
 *   the web-layer's own responsibility to have already rejected before this
 *   domain function is ever reached (see the analogous web-layer wrapper
 *   this task adds alongside this file - domain code never depends on
 *   `src/web/`).
 * - **item5 (quota currentness/lifecycle)**: `quotaEnvelope.scope` is bound
 *   to this wait's own tenant/customer/project plus the caller's current
 *   activation plan lineage (`assertQuotaScopeMatchesWaitLineage`) before
 *   admission; the admitted reservation is re-verified against a FRESH
 *   `quotaEnvelopeResolver` read immediately before invoking the transport
 *   (`quotaStillCurrentImmediatelyBeforeEffect`) - on a mismatch the
 *   reservation is released and `EFFECT_BLOCKED_STALE_QUOTA` is returned
 *   with zero transport invocation (the resume claim itself, already won,
 *   is never undone - exactly like the dispatch runtime's own "BLOCKED
 *   before release" attempt-closing discipline); a thrown exception from
 *   the verified-effect call releases the reservation before propagating;
 *   any normal (non-thrown) outcome commits actual usage as honestly
 *   `UNKNOWN` (G5/G6 - the activated transport reports no real cost
 *   telemetry) and correlates it to exactly one `ExecutionEconomicsEvent`
 *   via the SAME `ExecutionEconomicsPort`/lineage primitives
 *   `outcome-job-execution-runtime.ts` already composes, reused verbatim -
 *   no second quota or economics system.
 */
export type ResumeAndExecuteConnectorEffectResult =
  | { readonly kind: "EFFECT_EXECUTED"; readonly outcome: VerifiedConnectorEffectOutcome; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "ALREADY_RESUMED_NO_EFFECT"; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "EFFECT_BLOCKED_STALE_QUOTA"; readonly resume: ProtectedDecisionResumeAuthorization };

export async function resumeProtectedDecisionAndExecuteConnectorEffect(input: {
  readonly waitStore: DurableProtectedDecisionWaitStore;
  readonly decisionRecordStore: DurableProtectedDecisionRecordStore;
  readonly waitRequest: ProtectedDecisionWaitRequest;
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
  readonly currentPrincipalRef: string;
  readonly roleContext?: OrganizationAccessRoleContext;
  readonly authority: AuthorityContext;
  readonly currentActivationFingerprint: string;
  readonly currentActivationPlanId: string;
  readonly currentActivationPlanVersion: number;
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
  readonly quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver;
  readonly estimatedCost: { readonly presence: unknown; readonly amountMinorUnits?: unknown; readonly currency?: unknown };
  readonly economicsPort: ExecutionEconomicsPort;
  readonly economicsTaskRef: unknown;
  readonly economicsUsageSource: unknown;
}): Promise<ResumeAndExecuteConnectorEffectResult> {
  // item5 (replay safety): once a real attempt has committed or released
  // its quota reservation, that reservation's idempotencyKey (derived from
  // the exact same jobId/runId/attempt identity `waitRequestId` is bound
  // to) has reached a genuine terminal disposition and can never be
  // re-admitted (see `admitQuotaReservation`'s own terminal-disposition
  // guard). A replayed/racing call for an ALREADY-durably-resumed
  // `waitRequestId` must therefore short-circuit here, before touching
  // quota admission again - exactly the same answer `claimResume` below
  // would eventually report, just without redoing (or re-erroring on) any
  // of the re-validated work in between.
  const existingResume = input.waitStore.getResume(input.waitRequest.tenantId, input.waitRequest.waitRequestId);
  if (existingResume !== undefined) {
    return { kind: "ALREADY_RESUMED_NO_EFFECT", resume: existingResume };
  }

  // item3: canonical exact-effect binding - checked before anything else
  // below even reads the durable decision record.
  const connectionBindingId = input.bound.instance.binding.connectionBindingId;
  const effectFingerprint = computeConnectorEffectFingerprint({
    effectIntentId: input.effectIntentId,
    actionRef: input.actionRef,
    retryClassification: input.retryClassification,
    capabilityRef: input.capabilityRef,
    connectionBindingId,
    requestPayload: input.requestPayload,
  });
  if (input.waitRequest.effectRef !== effectFingerprint) {
    throw new ProtectedEffectBindingMismatchError(input.waitRequest.effectRef, effectFingerprint);
  }

  // F3b: a fresh durable decision-record lookup, immediately before use.
  const decisionRecord = input.decisionRecordStore.getDecisionRecord(input.waitRequest.tenantId, input.waitRequest.decisionRef);
  if (decisionRecord === undefined) {
    throw new ProtectedDecisionRecordNotFoundError(input.waitRequest.tenantId, input.waitRequest.decisionRef);
  }

  // item2: access is re-resolved from raw, caller-supplied ingredients
  // immediately before use - never trusted as a precomputed value.
  const access = resolveEffectiveOrganizationAccess({
    organization: input.organization,
    membership: input.membership,
    currentPrincipalRef: input.currentPrincipalRef,
    authority: input.authority,
    ...(input.roleContext !== undefined ? { roleContext: input.roleContext } : {}),
  });

  const authorization = authorizeProtectedDecisionResume({
    waitRequest: input.waitRequest,
    access,
    authority: input.authority,
    decisionRecord,
    currentActivationFingerprint: input.currentActivationFingerprint,
    now: input.now,
  });

  // item5a: quota scope lineage, then entry-point currentness - both
  // re-resolved immediately before the durable claim, exactly where
  // activation currentness is also checked above.
  assertQuotaScopeMatchesWaitLineage({
    scope: input.quotaEnvelope.scope,
    waitRequest: input.waitRequest,
    currentActivationPlanId: input.currentActivationPlanId,
    currentActivationPlanVersion: input.currentActivationPlanVersion,
  });
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

  // item5b: the latest-moment recheck, immediately before invoking the
  // transport - the claim itself (already durably won above) is never
  // undone by a post-claim staleness finding; only the effect is blocked
  // and the reservation released for a later retry to re-admit fresh.
  const stillCurrent = await quotaStillCurrentImmediatelyBeforeEffect({
    quotaEnvelopeResolver: input.quotaEnvelopeResolver,
    reservedEnvelope: input.quotaEnvelope,
  });
  if (!stillCurrent) {
    await input.quotaAdmission.release({
      identity: quotaIdentity,
      idempotencyKey: quotaIdempotencyKey,
      occurredAt: input.now,
      reason: "quota envelope changed between admission and invocation - zero connector effect; reservation released for a later retry to re-admit under current policy",
    });
    return { kind: "EFFECT_BLOCKED_STALE_QUOTA", resume: claim.value };
  }

  let outcome: VerifiedConnectorEffectOutcome;
  try {
    outcome = executeConnectorCapabilityAsVerifiedEffect({
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
  } catch (cause) {
    // executeConnectorCapabilityAsVerifiedEffect itself normalizes every
    // connection/transport/readback failure into a FAILED/UNKNOWN outcome -
    // it never throws for those. A thrown exception here can only be an
    // authority/validation failure inside that boundary itself, which
    // means no real effect was ever attempted; still release the
    // reservation rather than leave it claimed against zero real effect.
    await input.quotaAdmission.release({
      identity: quotaIdentity,
      idempotencyKey: quotaIdempotencyKey,
      occurredAt: input.now,
      reason: "executeConnectorCapabilityAsVerifiedEffect threw before any outcome could be recorded - releasing the reservation rather than leaving it claimed against zero real effect",
    });
    throw cause;
  }

  // item5d/e: G5/G6 - commit actual usage (honestly UNKNOWN; the activated
  // transport reports no real cost telemetry) after ANY real invoked
  // outcome, regardless of VERIFIED/FAILED/UNKNOWN, then correlate it to
  // exactly one ExecutionEconomicsEvent.
  await input.quotaAdmission.commit({
    identity: quotaIdentity,
    idempotencyKey: quotaIdempotencyKey,
    actualAmount: { presence: "UNKNOWN" },
    occurredAt: input.now,
  });
  const economicsLineage = createExecutionEconomicsLineage({
    tenantScope: input.tenantScope,
    customerId: input.waitRequest.customerId,
    projectId: input.waitRequest.projectId,
    planId: input.currentActivationPlanId,
    planVersion: input.currentActivationPlanVersion,
    jobId: input.waitRequest.jobId,
    taskRef: input.economicsTaskRef,
    runRef: input.waitRequest.runId,
    attemptRef: String(input.waitRequest.attempt),
  });
  const economicsIdempotencyKey = JSON.stringify([
    economicsLineage.tenantId,
    economicsLineage.customerId,
    economicsLineage.projectId,
    economicsLineage.planId,
    economicsLineage.planVersion,
    economicsLineage.jobId,
    economicsLineage.taskRef,
    economicsLineage.runRef,
    economicsLineage.attemptRef,
  ]);
  const economicsEvent = recordExecutionEconomicsEvent({
    lineage: economicsLineage,
    idempotencyKey: economicsIdempotencyKey,
    usageSource: input.economicsUsageSource,
    costBuckets: [{ kind: "MARGINAL_CASH", amount: { presence: "UNKNOWN" } }],
    attribution: {},
    capturedAt: input.now,
  });
  await input.economicsPort.recordSettledAttempt(economicsEvent);

  return { kind: "EFFECT_EXECUTED", outcome, resume: claim.value };
}
