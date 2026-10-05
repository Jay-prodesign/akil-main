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
import type { executeConnectorCapability, ConnectorTransport, SecretResolver, CurrentConnectorConnectionReader, ConnectorExecutionResult } from "./connector-execution.js";
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
  type QuotaReservationIdentity,
} from "./execution-quota-admission.js";
import {
  createExecutionEconomicsLineage,
  recordExecutionEconomicsEvent,
  type ExecutionEconomicsLineage,
} from "./execution-economics-attribution.js";

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
  readonly approvalEvidenceRef?: unknown;
}): string {
  const effectIntentId = typeof input.effectIntentId === "string" ? input.effectIntentId : String(input.effectIntentId);
  // Rev189 R3: `requiresApproval` is bound too, derived the SAME way
  // `createExternalEffectIntent` derives it (`approvalEvidenceRef !==
  // undefined`) - never a separately-declared boolean that could drift
  // from the real intent's own semantics. Keeping the SAME effectIntentId
  // while flipping approval-required state underneath it must now fail
  // this fingerprint, not just substituting action/capability/connection/
  // payload.
  const requiresApproval = input.approvalEvidenceRef !== undefined;
  return JSON.stringify([
    effectIntentId,
    input.actionRef,
    input.retryClassification,
    input.capabilityRef,
    input.connectionBindingId,
    input.requestPayload ?? null,
    requiresApproval,
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
 * Rev189 R1/R2: the ONE canonical economics-correlation derivation and
 * append, factored out so both the normal post-transport path and the
 * crash/restart recovery path (`recoverEconomicsIfSettled` below) use the
 * exact same lineage/idempotencyKey encoding - never two independent
 * derivations that could drift. Mirrors `outcome-job-execution-runtime.ts`'s
 * own `recordExecutionEconomicsForSettledAttempt`/`JSON.stringify`-of-
 * ordered-tuple convention verbatim.
 */
function deriveEconomicsLineageAndKey(input: {
  readonly tenantScope: TenantScope;
  readonly waitRequest: ProtectedDecisionWaitRequest;
  readonly currentActivationPlanId: string;
  readonly currentActivationPlanVersion: number;
  readonly economicsTaskRef: unknown;
}): { readonly lineage: ExecutionEconomicsLineage; readonly idempotencyKey: string } {
  const lineage = createExecutionEconomicsLineage({
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
  const idempotencyKey = JSON.stringify([
    lineage.tenantId,
    lineage.customerId,
    lineage.projectId,
    lineage.planId,
    lineage.planVersion,
    lineage.jobId,
    lineage.taskRef,
    lineage.runRef,
    lineage.attemptRef,
  ]);
  return { lineage, idempotencyKey };
}

async function recordAttemptEconomics(input: {
  readonly economicsPort: ExecutionEconomicsPort;
  readonly lineage: ExecutionEconomicsLineage;
  readonly idempotencyKey: string;
  readonly economicsUsageSource: unknown;
  readonly now: unknown;
}): Promise<void> {
  const economicsEvent = recordExecutionEconomicsEvent({
    lineage: input.lineage,
    idempotencyKey: input.idempotencyKey,
    usageSource: input.economicsUsageSource,
    costBuckets: [{ kind: "MARGINAL_CASH", amount: { presence: "UNKNOWN" } }],
    attribution: {},
    capturedAt: input.now,
  });
  await input.economicsPort.recordSettledAttempt(economicsEvent);
}

/**
 * Rev189 R1 (crash/restart disposition gap): on a REPLAY (an already-
 * durably-resumed `waitRequestId`), `peekSettlement` is the ONLY safe way
 * to learn whether the prior/current attempt reached a genuine terminal
 * settlement (`COMMITTED`/`RECONCILIATION_REQUIRED`) - never a guess, and
 * never a blind re-release/re-invoke of ambiguous post-claim work (a
 * still-RESERVED reservation could belong to a call genuinely still
 * in-flight concurrently, not only a crashed one; releasing it here would
 * corrupt that in-flight caller's own later commit). When settled, the
 * commit itself already happened - only the economics correlation might be
 * missing (a crash in the narrow commit-before-economics window), and
 * `economicsPort.recordSettledAttempt` is independently idempotent per
 * `idempotencyKey`, so recovering it here is always a safe no-op if it was
 * already recorded. Mirrors `outcome-job-execution-runtime.ts`'s own
 * `recoverMissedEconomicsIfSettled`, reusing the exact same primitives.
 */
async function recoverEconomicsIfSettled(input: {
  readonly quotaAdmission: QuotaAdmissionPort;
  readonly quotaIdentity: QuotaReservationIdentity;
  readonly quotaIdempotencyKey: string;
  readonly economicsPort: ExecutionEconomicsPort;
  readonly lineage: ExecutionEconomicsLineage;
  readonly economicsIdempotencyKey: string;
  readonly economicsUsageSource: unknown;
  readonly now: unknown;
}): Promise<boolean> {
  const peek = await input.quotaAdmission.peekSettlement({
    identity: input.quotaIdentity,
    idempotencyKey: input.quotaIdempotencyKey,
  });
  if (!peek.settled) {
    return false;
  }
  await recordAttemptEconomics({
    economicsPort: input.economicsPort,
    lineage: input.lineage,
    idempotencyKey: input.economicsIdempotencyKey,
    economicsUsageSource: input.economicsUsageSource,
    now: input.now,
  });
  return true;
}

/**
 * Rev190 (F6/R1 remainder): the ONLY way a restart may resolve a
 * `STARTED_OR_EFFECT_POSSIBLE` disposition - an INDEPENDENT readback,
 * never a second `transport.execute()` call (Golden C's own "transport
 * SUCCESS alone is never sufficient" discipline applies with equal force
 * to a crash-recovery path as it does to the first invocation). The
 * minimal `ConnectorExecutionResult` passed to the caller-injected
 * `readback` carries only addressing fields (`connectorKind`/
 * `connectionBindingId`/`capabilityRef`) - exactly what a real readback
 * implementation needs to independently ask the provider "was this
 * applied", never a transport response this function fabricates. Returns
 * `"APPLIED"` only when the readback itself affirmatively confirms it;
 * anything else - including the readback itself throwing, which is
 * genuine uncertainty, not a negative answer - is `"UNKNOWN"`, never
 * silently treated as a negative that would license a bypass of this
 * boundary's own fail-closed discipline.
 */
function reconcileStartedDispositionViaReadback(input: {
  readonly bound: Parameters<typeof executeConnectorCapability>[0]["bound"];
  readonly capabilityRef: unknown;
  readonly readback: ConnectorCapabilityReadback;
}): { readonly disposition: "APPLIED"; readonly evidenceRef: string } | { readonly disposition: "UNKNOWN" } {
  try {
    const minimalResult = {
      connectorKind: input.bound.instance.connectorKind,
      connectionBindingId: input.bound.instance.binding.connectionBindingId,
      capabilityRef: input.capabilityRef,
    } as unknown as ConnectorExecutionResult;
    if (input.readback.confirmsApplied(minimalResult)) {
      return { disposition: "APPLIED", evidenceRef: input.readback.evidenceRef(minimalResult) };
    }
    return { disposition: "UNKNOWN" };
  } catch {
    // The readback itself could not determine disposition - genuine
    // uncertainty, fail closed exactly like any other unresolved state.
    return { disposition: "UNKNOWN" };
  }
}

/**
 * Rev186 F3: "prove one real protected-effect path consumes [the resume
 * claim] once." This is that one real consumer - it binds WAIT→RESUME
 * directly to the one real protected-effect wrapper this task built
 * (`executeConnectorCapabilityAsVerifiedEffect`, Live Gap C1), so the
 * durable store's own single-use `claimResume` is what decides whether a
 * `waitRequestId` is authorized to proceed at all - and, separately
 * (Rev190), the durable `claimEffectStarted` marker is what decides
 * whether the transport boundary has a single operation owner.
 *
 * Rev187/Rev188/Rev189 residuals, all closed in this one consumer (see
 * each revision's own exec-plan section for detail): F3a/item3 exact-
 * effect binding (now widened by Rev189 R3 with `requiresApproval`); F3b
 * durable decision, fetched fresh; item2 authenticated access, re-resolved
 * fresh; item5 quota currentness/lifecycle; Rev189 R2's `BLOCKED_NO_EFFECT`
 * release-without-commit; Rev189 R4's truthful `decidedByPrincipalRef`.
 *
 * Rev190 (F6/R1 remainder) - the durable effect-operation lifecycle:
 * `claimResume` alone only proves "a resume was authorized" - it does NOT
 * prove the transport boundary was ever approached, so a replay that only
 * ever checked `getResume`/quota-settlement (Rev189's own R1 fix) could
 * never safely distinguish "crashed before even trying" from "crashed
 * after maybe applying it", and so was forced to report both as the SAME
 * `EFFECT_DISPOSITION_UNKNOWN_RECONCILE_REQUIRED` - truthful, but
 * stranding the common, genuinely safe case forever. `claimEffectStarted`
 * (`durable-protected-decision-wait-store.ts`) adds the minimum needed
 * third state:
 *
 * - **CLAIMED_NOT_STARTED** (`getEffectStarted` absent): the resume was
 *   won, but the transport boundary (`executeConnectorCapabilityAsVerifiedEffect`)
 *   was never invoked - the admitted quota reservation is still exactly
 *   `RESERVED` (every release/commit path only runs AFTER
 *   `claimEffectStarted` durably succeeds, by construction). Safe to
 *   continue the one real attempt now, reusing the SAME reservation.
 * - **STARTED_OR_EFFECT_POSSIBLE** (`getEffectStarted` present, not yet
 *   terminally settled): the transport boundary was approached and may
 *   have applied the effect before a crash. NEVER blind-reinvoked - the
 *   only resolution is an INDEPENDENT readback (never a second
 *   `transport.execute()`), settling on confirmation or else honestly
 *   preserving `EFFECT_DISPOSITION_UNKNOWN_RECONCILE_REQUIRED` until a
 *   separate, deliberate reconciliation decision resolves it.
 * - **TERMINAL/RECONCILED** (quota `COMMITTED`/`RECONCILIATION_REQUIRED`):
 *   unchanged from Rev189 R1 - `ALREADY_RESUMED_SETTLED`, with any missing
 *   economics correlation recovered idempotently.
 *
 * `claimEffectStarted` is itself an atomic single-use claim (the same
 * `linkSync` pattern as `claimResume`), so it is what gives the transport
 * boundary exactly one operation owner globally for a `waitRequestId` -
 * not just `claimResume`'s own single authorization owner. A concurrent
 * racer who loses this claim, or a losing racer of `claimResume` itself,
 * is redirected into the SAME reconciliation path a later replay would
 * use - never a second transport invocation, never a stale blanket
 * "no effect" that could be false the moment the winner is already
 * mid-flight.
 */
export type ResumeAndExecuteConnectorEffectResult =
  | { readonly kind: "EFFECT_EXECUTED"; readonly outcome: VerifiedConnectorEffectOutcome; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "EFFECT_BLOCKED_STALE_QUOTA"; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "ALREADY_RESUMED_SETTLED"; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "EFFECT_DISPOSITION_UNKNOWN_RECONCILE_REQUIRED"; readonly resume: ProtectedDecisionResumeAuthorization };

type ResumeAndExecuteConnectorEffectInput = Parameters<typeof resumeProtectedDecisionAndExecuteConnectorEffect>[0];

function deriveQuotaIdentityAndKey(
  waitRequest: ProtectedDecisionWaitRequest,
  quotaScope: QuotaAdmissionScope,
): { readonly quotaIdentity: QuotaReservationIdentity; readonly quotaIdempotencyKey: string } {
  const quotaIdentity = createQuotaReservationIdentity({
    scope: quotaScope,
    jobId: waitRequest.jobId as unknown as string,
    runId: waitRequest.runId,
    attemptRef: String(waitRequest.attempt),
  });
  return { quotaIdentity, quotaIdempotencyKey: deriveQuotaReservationIdempotencyKey(quotaIdentity) };
}

/**
 * Rev190: the ONE reconciliation path for an already-durably-resumed
 * `waitRequestId` - reached on a genuine replay (`getResume` already
 * returns a value) AND on a same-call race that lost `claimResume` or
 * `claimEffectStarted` (both redirect here rather than guessing). See this
 * module's own top-of-file doc comment for the full CLAIMED_NOT_STARTED /
 * STARTED_OR_EFFECT_POSSIBLE / TERMINAL disposition contract.
 */
async function reconcileExistingResume(
  input: ResumeAndExecuteConnectorEffectInput,
  resume: ProtectedDecisionResumeAuthorization,
): Promise<ResumeAndExecuteConnectorEffectResult> {
  const { quotaIdentity, quotaIdempotencyKey } = deriveQuotaIdentityAndKey(input.waitRequest, input.quotaEnvelope.scope);
  const { lineage: economicsLineage, idempotencyKey: economicsIdempotencyKey } = deriveEconomicsLineageAndKey({
    tenantScope: input.tenantScope,
    waitRequest: input.waitRequest,
    currentActivationPlanId: input.currentActivationPlanId,
    currentActivationPlanVersion: input.currentActivationPlanVersion,
    economicsTaskRef: input.economicsTaskRef,
  });

  const settled = await recoverEconomicsIfSettled({
    quotaAdmission: input.quotaAdmission,
    quotaIdentity,
    quotaIdempotencyKey,
    economicsPort: input.economicsPort,
    lineage: economicsLineage,
    economicsIdempotencyKey,
    economicsUsageSource: input.economicsUsageSource,
    now: input.now,
  });
  if (settled) {
    return { kind: "ALREADY_RESUMED_SETTLED", resume };
  }

  const started = input.waitStore.getEffectStarted(input.waitRequest.tenantId, input.waitRequest.waitRequestId);
  if (!started) {
    // CLAIMED_NOT_STARTED: the transport boundary was never approached for
    // this waitRequestId - the reservation admitted when the resume was
    // first won is still exactly RESERVED, reused as-is (never re-admitted).
    return await proceedToInvokeEffect(input, resume, quotaIdentity, quotaIdempotencyKey);
  }

  // STARTED_OR_EFFECT_POSSIBLE and not yet terminally settled - never
  // blind-reinvoke. The only resolution is an independent readback.
  const reconciled = reconcileStartedDispositionViaReadback({
    bound: input.bound,
    capabilityRef: input.capabilityRef,
    readback: input.readback,
  });
  if (reconciled.disposition === "APPLIED") {
    await input.quotaAdmission.commit({
      identity: quotaIdentity,
      idempotencyKey: quotaIdempotencyKey,
      actualAmount: { presence: "UNKNOWN" },
      occurredAt: input.now,
    });
    await recordAttemptEconomics({
      economicsPort: input.economicsPort,
      lineage: economicsLineage,
      idempotencyKey: economicsIdempotencyKey,
      economicsUsageSource: input.economicsUsageSource,
      now: input.now,
    });
    return { kind: "ALREADY_RESUMED_SETTLED", resume };
  }
  // Preserve UNKNOWN until a deliberate, separate reconciliation decision
  // resolves it - never guessed, never retried blindly, here.
  return { kind: "EFFECT_DISPOSITION_UNKNOWN_RECONCILE_REQUIRED", resume };
}

/**
 * Rev190: the ONLY place `executeConnectorCapabilityAsVerifiedEffect` is
 * ever called - gated by `claimEffectStarted`'s own atomic single-use
 * claim, so exactly one caller, ever, becomes the sole operation owner of
 * the transport boundary for this `waitRequestId`. Reached either from the
 * first-time path (quota just admitted, resume claim just won) or from
 * `reconcileExistingResume`'s CLAIMED_NOT_STARTED branch (quota and resume
 * claim both already exist from an earlier call) - both reuse the SAME
 * still-`RESERVED` reservation, never re-admitting.
 */
async function proceedToInvokeEffect(
  input: ResumeAndExecuteConnectorEffectInput,
  resume: ProtectedDecisionResumeAuthorization,
  quotaIdentity: QuotaReservationIdentity,
  quotaIdempotencyKey: string,
): Promise<ResumeAndExecuteConnectorEffectResult> {
  const startClaim = input.waitStore.claimEffectStarted(input.waitRequest.tenantId, input.waitRequest.waitRequestId);
  if (!startClaim.created) {
    // Lost the race to become sole owner of the transport boundary -
    // someone else is now (or already was) the owner. Re-derive the
    // current, possibly now-different disposition instead of guessing.
    return await reconcileExistingResume(input, resume);
  }

  // item5b: the latest-moment recheck, immediately before invoking the
  // transport - the claim itself (already durably won) is never undone
  // by a post-claim staleness finding; only the effect is blocked and
  // the reservation released for a later retry to re-admit fresh.
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
    return { kind: "EFFECT_BLOCKED_STALE_QUOTA", resume };
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

  // Rev189 R2: `BLOCKED_NO_EFFECT` is a definitive proof that
  // `transport.execute()` was NEVER invoked (a pre-transport connection/
  // secret failure) - the reservation is released exactly like the
  // stale-quota block above, and no attempted-effect economics is ever
  // recorded for a call that never attempted anything.
  if (outcome.kind === "BLOCKED_NO_EFFECT") {
    await input.quotaAdmission.release({
      identity: quotaIdentity,
      idempotencyKey: quotaIdempotencyKey,
      occurredAt: input.now,
      reason: "executeConnectorCapabilityAsVerifiedEffect reported BLOCKED_NO_EFFECT - transport.execute() was never invoked; reservation released for a later retry to re-admit under current policy",
    });
    return { kind: "EFFECT_EXECUTED", outcome, resume };
  }

  // item5d/e: G5/G6 - commit actual usage (honestly UNKNOWN; the activated
  // transport reports no real cost telemetry) after any ATTEMPTED/ambiguous
  // transport outcome (VERIFIED/FAILED-with-readback/FAILED-authorization/
  // UNKNOWN - every case where transport.execute() genuinely ran), then
  // correlate it to exactly one ExecutionEconomicsEvent.
  await input.quotaAdmission.commit({
    identity: quotaIdentity,
    idempotencyKey: quotaIdempotencyKey,
    actualAmount: { presence: "UNKNOWN" },
    occurredAt: input.now,
  });
  const { lineage: economicsLineage, idempotencyKey: economicsIdempotencyKey } = deriveEconomicsLineageAndKey({
    tenantScope: input.tenantScope,
    waitRequest: input.waitRequest,
    currentActivationPlanId: input.currentActivationPlanId,
    currentActivationPlanVersion: input.currentActivationPlanVersion,
    economicsTaskRef: input.economicsTaskRef,
  });
  await recordAttemptEconomics({
    economicsPort: input.economicsPort,
    lineage: economicsLineage,
    idempotencyKey: economicsIdempotencyKey,
    economicsUsageSource: input.economicsUsageSource,
    now: input.now,
  });

  return { kind: "EFFECT_EXECUTED", outcome, resume };
}

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
  // Rev190: a replay (an already-durably-resumed waitRequestId) is
  // resolved by the SAME disposition-reconciliation path a losing
  // same-call racer below also uses - never a separate, potentially
  // drifting copy of that logic.
  const existingResume = input.waitStore.getResume(input.waitRequest.tenantId, input.waitRequest.waitRequestId);
  if (existingResume !== undefined) {
    return await reconcileExistingResume(input, existingResume);
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
    approvalEvidenceRef: input.approvalEvidenceRef,
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
  const { quotaIdentity, quotaIdempotencyKey } = deriveQuotaIdentityAndKey(input.waitRequest, input.quotaEnvelope.scope);
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
    // Lost the race to a concurrent winner - redirect to the SAME
    // reconciliation path a replay would use (never a stale blanket
    // "no effect" - the winner may already be mid-flight).
    return await reconcileExistingResume(input, claim.value);
  }

  return await proceedToInvokeEffect(input, claim.value, quotaIdentity, quotaIdempotencyKey);
}
