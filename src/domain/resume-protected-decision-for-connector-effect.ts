import type { TenantScope } from "./tenant-scope.js";
import {
  authorizeProtectedDecisionResume,
  type ProtectedDecisionWaitRequest,
  type ProtectedDecisionOutcomeEvidence,
  type ProtectedDecisionResumeAuthorization,
} from "./protected-decision-wait-gate.js";
import type { DurableProtectedDecisionWaitStore } from "./durable-protected-decision-wait-store.js";
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

/**
 * Rev186 F3: "prove one real protected-effect path consumes [the resume
 * claim] once." This is that one real consumer - it binds WAIT→RESUME
 * directly to the one real protected-effect wrapper this task built
 * (`executeConnectorCapabilityAsVerifiedEffect`, Live Gap C1), so the
 * durable store's own single-use `claimResume` is what decides whether the
 * connector transport is ever invoked at all, not merely whether the same
 * authorization value is returned twice.
 *
 * `claimResume` is called BEFORE `executeConnectorCapabilityAsVerifiedEffect`
 * - only the call that durably wins the claim (`created: true`) proceeds to
 * the real effect. A second call for the same `waitRequestId` (ours
 * replayed, or a concurrent racer) finds `created: false` and returns
 * `ALREADY_RESUMED_NO_EFFECT` without ever invoking the transport - this is
 * the atomicity "returning the same authorization repeatedly" alone could
 * not prove.
 *
 * Currentness re-resolution immediately before effect: activation
 * currentness is re-checked by `authorizeProtectedDecisionResume` itself
 * (unchanged); connection currentness is re-checked by
 * `executeConnectorCapability` itself (unchanged, always re-reads the
 * CURRENT durable connection record - never a caller snapshot). Config/
 * policy and quota currentness are honestly NOT modeled here: no existing
 * owner in this repository binds either dimension to a connector-capability
 * effect, so re-checking them would be fabricating a dimension this exact
 * consumer does not have - "the applicable current activation/config/
 * policy plus connection/quota/current authority" (Rev186 F3's own
 * phrasing) resolves, for this consumer, to activation + connection +
 * current authority only.
 */
export type ResumeAndExecuteConnectorEffectResult =
  | { readonly kind: "EFFECT_EXECUTED"; readonly outcome: VerifiedConnectorEffectOutcome; readonly resume: ProtectedDecisionResumeAuthorization }
  | { readonly kind: "ALREADY_RESUMED_NO_EFFECT"; readonly resume: ProtectedDecisionResumeAuthorization };

export function resumeProtectedDecisionAndExecuteConnectorEffect(input: {
  readonly waitStore: DurableProtectedDecisionWaitStore;
  readonly waitRequest: ProtectedDecisionWaitRequest;
  readonly access: EffectiveAccessResolution;
  readonly authority: AuthorityContext;
  readonly decisionOutcome: ProtectedDecisionOutcomeEvidence;
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
}): ResumeAndExecuteConnectorEffectResult {
  const authorization = authorizeProtectedDecisionResume({
    waitRequest: input.waitRequest,
    access: input.access,
    authority: input.authority,
    decisionOutcome: input.decisionOutcome,
    currentActivationFingerprint: input.currentActivationFingerprint,
    now: input.now,
  });

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
