import type { TenantScope } from "./tenant-scope.js";
import {
  executeConnectorCapability,
  ConnectorExecutionAuthorizationError,
  ConnectorExecutionTransportError,
  type ConnectorExecutionResult,
  type ConnectorTransport,
  type SecretResolver,
  type CurrentConnectorConnectionReader,
} from "./connector-execution.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import {
  createExternalEffectIntent,
  startExternalEffectAttempt,
  reportExternalEffectOutcome,
  verifyExternalEffectReadback,
  type ExternalEffectIntent,
  type ExternalEffectAttempt,
  type ExternalEffectRetryClassification,
} from "./external-effect-envelope.js";
import { requireSameTenant, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";

export class InvalidVerifiedConnectorEffectError extends Error {
  constructor(reason: string) {
    super(`Invalid verified connector effect operation: ${reason}`);
    this.name = "InvalidVerifiedConnectorEffectError";
  }
}

/**
 * OS-V0-10 Live Gap C1 ("transport success is not Golden-C verified
 * effect"): `executeConnectorCapability` (`connector-execution.ts`,
 * unmodified - the correct OS-V0-06 execution floor) normalizes transport
 * SUCCESS/AUTHORIZATION_FAILED/TRANSPORT_ERROR, but Golden C requires
 * explicit external-effect identity plus independent post-action readback/
 * evidence (`external-effect-envelope.ts`, already built, previously with
 * no caller anywhere in the repository). This function is that caller: it
 * composes `createExternalEffectIntent` + `startExternalEffectAttempt` +
 * the EXISTING, UNMODIFIED `executeConnectorCapability` +
 * `reportExternalEffectOutcome` + a caller-injected independent readback +
 * `verifyExternalEffectReadback`.
 *
 * Provider/transport acknowledgement (a successful `executeConnectorCapability`
 * call) marks the attempt APPLIED at most - this function never itself
 * returns VERIFIED without the caller's own `readback` independently
 * confirming it, and a disagreeing readback corrects the attempt to FAILED
 * rather than leaving a false APPLIED standing. An exception thrown by
 * `executeConnectorCapability` that is NOT a recognized authorization/
 * transport-error class (e.g. the injected transport itself throwing, or
 * any other ambiguous failure this boundary cannot classify) is reported as
 * UNKNOWN - genuinely unknown whether the effect applied - and this
 * function never retries it itself; `retryExternalEffectAttempt`
 * (`external-effect-envelope.ts`, unmodified) remains the only governed
 * path out of UNKNOWN, and only for a `SAFE_TO_RETRY` intent.
 */
export interface ConnectorCapabilityReadback {
  confirmsApplied(result: ConnectorExecutionResult): boolean;
  evidenceRef(result: ConnectorExecutionResult): string;
}

export type VerifiedConnectorEffectOutcome =
  | { readonly kind: "VERIFIED"; readonly attempt: ExternalEffectAttempt; readonly result: ConnectorExecutionResult }
  | { readonly kind: "FAILED"; readonly attempt: ExternalEffectAttempt }
  | { readonly kind: "UNKNOWN"; readonly attempt: ExternalEffectAttempt };

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidVerifiedConnectorEffectError(`${field} must be a non-empty string`);
  }
  return value;
}

export function executeConnectorCapabilityAsVerifiedEffect(input: {
  readonly tenantScope: TenantScope;
  readonly authority: AuthorityContext;
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
}): VerifiedConnectorEffectOutcome {
  requireSameTenant(input.authority, input.tenantScope.tenantId);
  requireProtectedActionAuthorization(input.authority, "executeConnectorCapabilityAsVerifiedEffect");

  const intent: ExternalEffectIntent = createExternalEffectIntent({
    tenantScope: input.tenantScope,
    effectIntentId: input.effectIntentId,
    actionRef: input.actionRef,
    retryClassification: input.retryClassification,
    requiresApproval: input.approvalEvidenceRef !== undefined,
  });

  let attempt: ExternalEffectAttempt = startExternalEffectAttempt({
    intent,
    attemptId: input.attemptId,
    ...(input.approvalEvidenceRef !== undefined
      ? { approval: { authority: input.authority, evidenceRef: input.approvalEvidenceRef } }
      : {}),
  });

  let result: ConnectorExecutionResult | undefined;
  let outcome: "APPLIED" | "FAILED" | "UNKNOWN";
  let externalCorrelationRef: string;
  try {
    result = executeConnectorCapability({
      bound: input.bound,
      capabilityRef: input.capabilityRef,
      requestingOwnership: input.requestingOwnership,
      connectionStore: input.connectionStore,
      secretResolver: input.secretResolver,
      transport: input.transport,
      ...(input.requestPayload !== undefined ? { requestPayload: input.requestPayload } : {}),
    });
    outcome = "APPLIED";
    externalCorrelationRef = `${result.connectorKind}:${result.connectionBindingId}:${result.capabilityRef}`;
  } catch (cause) {
    if (cause instanceof ConnectorExecutionAuthorizationError || cause instanceof ConnectorExecutionTransportError) {
      // A definitive, classified failure - the transport/authorization
      // layer itself proved no effect occurred.
      outcome = "FAILED";
      externalCorrelationRef = `error:${cause.name}`;
    } else {
      // Anything else (an unclassified/unexpected exception, including the
      // injected transport itself throwing) is genuinely ambiguous - this
      // boundary cannot prove the effect did or did not apply.
      outcome = "UNKNOWN";
      externalCorrelationRef = `error:${cause instanceof Error ? cause.name : "unknown"}`;
    }
  }

  attempt = reportExternalEffectOutcome({ attempt, outcome, externalCorrelationRef });

  if (outcome === "FAILED" || outcome === "UNKNOWN") {
    return { kind: outcome, attempt };
  }

  // outcome === "APPLIED": only an independent readback can move this to
  // VERIFIED - a transport SUCCESS alone is never sufficient (Live Gap C1).
  const appliedResult = result as ConnectorExecutionResult;
  const confirmsApplied = input.readback.confirmsApplied(appliedResult);
  const evidenceRef = requireNonEmptyString(input.readback.evidenceRef(appliedResult), "readback.evidenceRef(result)");
  attempt = verifyExternalEffectReadback({ attempt, readbackConfirmsApplied: confirmsApplied, evidenceRef });

  if (attempt.state === "VERIFIED") {
    return { kind: "VERIFIED", attempt, result: appliedResult };
  }
  return { kind: "FAILED", attempt };
}
