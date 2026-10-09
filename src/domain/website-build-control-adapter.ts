import type { TenantScope } from "./tenant-scope.js";
import type { AuthorityContext } from "./authority.js";
import type { ExecutionMaturity } from "./service-capability-routing.js";
import type { ConnectorExecutionResult } from "./connector-execution.js";
import { executeConnectorCapability, ConnectorExecutionTransportError } from "./connector-execution.js";
import type { ExternalEffectIntent, ExternalEffectAttempt } from "./external-effect-envelope.js";
import { createExternalEffectIntent, startExternalEffectAttempt, reportExternalEffectOutcome } from "./external-effect-envelope.js";

export class InvalidWebsiteBuildControlAdapterError extends Error {
  constructor(reason: string) {
    super(`Invalid Website Build control adapter operation: ${reason}`);
    this.name = "InvalidWebsiteBuildControlAdapterError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidWebsiteBuildControlAdapterError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Rev98/Rev101 Family 5: the first real Service-Specific Control Adapter
 * (V4 Full Blueprint §7, Workstream C) for one bounded path - Website
 * Build. `service-capability-routing.ts`'s own doc comments record that
 * "no real provider adapter (read, diagnose, recommend, draft, apply)
 * exists anywhere in this repository yet," capping every route at
 * `READ_ONLY`. This module is that adapter: it composes CONN-001's
 * `connector-execution.ts` (the READ/APPLY transport boundary) and
 * V4-EFF-001's `external-effect-envelope.ts` (the DRAFT/APPROVAL/VERIFY
 * governance) to walk one real request through
 * READ_ONLY -> DIAGNOSE -> RECOMMEND -> DRAFT_PREVIEW -> APPROVAL_REQUIRED
 * -> CONTROLLED_APPLY, reusing `ExecutionMaturity`'s own existing closed
 * vocabulary (type-only import) rather than inventing an eleventh rung.
 * The final "VERIFIED EFFECT" step has no corresponding `ExecutionMaturity`
 * literal - it is exactly `external-effect-envelope.ts`'s own
 * `verifyExternalEffectReadback`, called directly by the caller against
 * this module's own `controlledApplyWebsiteBuildEffect` output; this
 * module does not wrap it, since a passthrough wrapper with no added
 * logic would be pointless indirection.
 *
 * No real content-inspection or website-analysis intelligence exists
 * anywhere in this repository, so `diagnoseWebsiteBuildSignal` and
 * `recommendWebsiteBuildAction` never infer a severity or an action
 * themselves - exactly like `service-capability-routing.ts`'s own
 * "declared, not yet producible" discipline, the caller declares the
 * diagnosis/recommendation and this module only governs its structure,
 * lineage, and fail-closed progression through the ladder.
 */
export interface WebsiteBuildSignal {
  readonly executionMaturity: Extract<ExecutionMaturity, "READ_ONLY">;
  readonly result: ConnectorExecutionResult;
}

/**
 * The READ_ONLY rung - a thin, unmodified pass-through to
 * `executeConnectorCapability`. Every one of that function's own
 * fail-closed checks (tenant/project ownership, `VERIFIED` connection
 * state, declared capability, resolvable secret) applies unchanged; this
 * wrapper adds only the `executionMaturity` tag.
 */
export function readWebsiteBuildSignal(input: Parameters<typeof executeConnectorCapability>[0]): WebsiteBuildSignal {
  const result = executeConnectorCapability(input);
  return { executionMaturity: "READ_ONLY", result };
}

export type WebsiteBuildDiagnosisSeverity = "HEALTHY" | "ISSUE_DETECTED" | "CRITICAL";

const RECOGNIZED_SEVERITIES: ReadonlySet<string> = new Set(["HEALTHY", "ISSUE_DETECTED", "CRITICAL"]);

export interface WebsiteBuildDiagnosis {
  readonly executionMaturity: Extract<ExecutionMaturity, "DIAGNOSE">;
  readonly severity: WebsiteBuildDiagnosisSeverity;
  readonly evidenceRef: string;
  readonly basedOnResult: ConnectorExecutionResult;
}

/**
 * The DIAGNOSE rung. `severity` and `evidenceRef` are caller-declared
 * (this module cannot itself analyze `signal.result.data`) but are
 * structurally bound to the exact `ConnectorExecutionResult` the READ
 * step produced - a diagnosis can never float free of the signal it
 * claims to explain.
 */
export function diagnoseWebsiteBuildSignal(input: {
  signal: WebsiteBuildSignal;
  severity: unknown;
  evidenceRef: unknown;
}): WebsiteBuildDiagnosis {
  if (typeof input.severity !== "string" || !RECOGNIZED_SEVERITIES.has(input.severity)) {
    throw new InvalidWebsiteBuildControlAdapterError(
      'severity must be one of "HEALTHY", "ISSUE_DETECTED", "CRITICAL"',
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return {
    executionMaturity: "DIAGNOSE",
    severity: input.severity as WebsiteBuildDiagnosisSeverity,
    evidenceRef,
    basedOnResult: input.signal.result,
  };
}

export interface WebsiteBuildRecommendation {
  readonly executionMaturity: Extract<ExecutionMaturity, "RECOMMEND">;
  readonly actionRef: string;
  readonly rationale: string;
  readonly basedOnDiagnosis: WebsiteBuildDiagnosis;
}

/**
 * The RECOMMEND rung. Fails closed on a `HEALTHY` diagnosis - this
 * module never manufactures a change to recommend against a site that
 * was just diagnosed as healthy, regardless of what `actionRef` a caller
 * supplies.
 */
export function recommendWebsiteBuildAction(input: {
  diagnosis: WebsiteBuildDiagnosis;
  actionRef: unknown;
  rationale: unknown;
}): WebsiteBuildRecommendation {
  if (input.diagnosis.severity === "HEALTHY") {
    throw new InvalidWebsiteBuildControlAdapterError(
      "cannot recommend an action against a HEALTHY diagnosis",
    );
  }
  const actionRef = requireNonEmptyString(input.actionRef, "actionRef");
  const rationale = requireNonEmptyString(input.rationale, "rationale");
  return { executionMaturity: "RECOMMEND", actionRef, rationale, basedOnDiagnosis: input.diagnosis };
}

export interface WebsiteBuildEffectDraft {
  readonly executionMaturity: Extract<ExecutionMaturity, "DRAFT_PREVIEW">;
  readonly intent: ExternalEffectIntent;
}

/**
 * The DRAFT_PREVIEW rung. `intent.requiresApproval` is always `true` -
 * not a caller-settable field - because every effect this adapter can
 * produce is a real customer-facing website mutation; this module
 * structurally cannot construct a draft that skips approval.
 */
export function draftWebsiteBuildEffectIntent(input: {
  recommendation: WebsiteBuildRecommendation;
  tenantScope: TenantScope;
  effectIntentId: unknown;
  retryClassification: unknown;
}): WebsiteBuildEffectDraft {
  const intent = createExternalEffectIntent({
    tenantScope: input.tenantScope,
    effectIntentId: input.effectIntentId,
    actionRef: input.recommendation.actionRef,
    retryClassification: input.retryClassification,
    requiresApproval: true,
  });
  return { executionMaturity: "DRAFT_PREVIEW", intent };
}

export interface WebsiteBuildApprovedAttempt {
  readonly executionMaturity: Extract<ExecutionMaturity, "APPROVAL_REQUIRED">;
  readonly attempt: ExternalEffectAttempt;
}

/**
 * The APPROVAL_REQUIRED rung. A thin, unmodified pass-through to
 * `startExternalEffectAttempt` - since `draftWebsiteBuildEffectIntent`
 * always sets `requiresApproval: true`, a granted, same-tenant,
 * protected-action-authorized `authority` and non-empty `evidenceRef`
 * are always mandatory here, never optional.
 */
export function startWebsiteBuildEffectAttempt(input: {
  draft: WebsiteBuildEffectDraft;
  attemptId: unknown;
  authority: AuthorityContext;
  evidenceRef: unknown;
}): WebsiteBuildApprovedAttempt {
  const attempt = startExternalEffectAttempt({
    intent: input.draft.intent,
    attemptId: input.attemptId,
    approval: { authority: input.authority, evidenceRef: input.evidenceRef },
  });
  return { executionMaturity: "APPROVAL_REQUIRED", attempt };
}

export interface WebsiteBuildAppliedAttempt {
  readonly executionMaturity: Extract<ExecutionMaturity, "CONTROLLED_APPLY">;
  readonly attempt: ExternalEffectAttempt;
}

/**
 * The CONTROLLED_APPLY rung - the only function in this module that ever
 * calls the injected connector transport for a write. Composes
 * `executeConnectorCapability` (every one of its own fail-closed checks
 * applies unchanged) with `reportExternalEffectOutcome`: a successful
 * execution reports `APPLIED`; a transport-level error
 * (`ConnectorExecutionTransportError`) reports `UNKNOWN` - the write may
 * or may not have taken effect on the provider side, so this module never
 * guesses `FAILED`; every other connector error (not-authorized,
 * authorization-failed, unresolved-secret) definitively means nothing was
 * sent, so it reports `FAILED`. `externalCorrelationRef` is always
 * caller-supplied, matching the envelope's own "mandatory on every
 * outcome" discipline - only the real transport/provider can honestly
 * originate a correlation identifier, not this module.
 */
export function controlledApplyWebsiteBuildEffect(input: {
  approvedAttempt: WebsiteBuildApprovedAttempt;
  connectorRequest: Parameters<typeof executeConnectorCapability>[0];
  externalCorrelationRef: unknown;
}): WebsiteBuildAppliedAttempt {
  try {
    executeConnectorCapability(input.connectorRequest);
    const attempt = reportExternalEffectOutcome({
      attempt: input.approvedAttempt.attempt,
      outcome: "APPLIED",
      externalCorrelationRef: input.externalCorrelationRef,
    });
    return { executionMaturity: "CONTROLLED_APPLY", attempt };
  } catch (cause) {
    const outcome = cause instanceof ConnectorExecutionTransportError ? "UNKNOWN" : "FAILED";
    const attempt = reportExternalEffectOutcome({
      attempt: input.approvedAttempt.attempt,
      outcome,
      externalCorrelationRef: input.externalCorrelationRef,
    });
    return { executionMaturity: "CONTROLLED_APPLY", attempt };
  }
}
