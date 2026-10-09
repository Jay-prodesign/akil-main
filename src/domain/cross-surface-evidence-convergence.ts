import type { TenantScope } from "./tenant-scope.js";
import type { CustomerEvidenceItem } from "./customer-evidence.js";
import type { ReconciledInsight } from "./cross-domain-intelligence.js";
import type { ExternalEffectAttempt, ExternalEffectAttemptState } from "./external-effect-envelope.js";
import type { MetricReadModel, MetricReadModelStatus } from "./observability-telemetry.js";

export class InvalidCrossSurfaceEvidenceError extends Error {
  constructor(reason: string) {
    super(`Invalid cross-surface evidence operation: ${reason}`);
    this.name = "InvalidCrossSurfaceEvidenceError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCrossSurfaceEvidenceError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Rev98/Rev101 Family 7 (cross-surface evidence/outcome reporting
 * convergence): four existing, independently-governed evidence surfaces -
 * `customer-evidence.ts`, `cross-domain-intelligence.ts`,
 * `external-effect-envelope.ts`, `observability-telemetry.ts` - each
 * already produce their own honest disposition, but in four different,
 * incomparable vocabularies (`FACT`/`HYPOTHESIS`/`UNKNOWN`,
 * `CURRENT`/`STALE`/`CONFLICTING`, `APPLIED`/`VERIFIED`/`FAILED`/`UNKNOWN`/
 * `ROLLED_BACK`, `REPORTED_FRESH`/`REPORTED_STALE`/`MISSING`/
 * `NOT_MONITORED`). This module never re-derives or duplicates any of
 * those four modules' own logic (type-only imports throughout) - it only
 * projects each existing status onto one small, shared, comparable
 * vocabulary (`provenance` and `comparability`), while always preserving
 * the exact original status string alongside the projection so nothing is
 * blurred or lost (§7 "provenance").
 */
export type ConvergedEvidenceSourceSurface =
  | "CUSTOMER_EVIDENCE"
  | "CROSS_DOMAIN_INTELLIGENCE"
  | "EXTERNAL_EFFECT"
  | "TELEMETRY";

export type ConvergedEvidenceDisposition = "CONFIRMED" | "UNCERTAIN" | "CONTRADICTED" | "UNAVAILABLE";

export interface ConvergedEvidenceItem {
  readonly sourceSurface: ConvergedEvidenceSourceSurface;
  readonly disposition: ConvergedEvidenceDisposition;
  readonly sourceRef: string;
  readonly originalStatus: string;
}

/**
 * `FACT` is the only customer-evidence kind this repository ever treats
 * as settled; `HYPOTHESIS` is explicitly unsettled (matching
 * `customer-evidence.ts`'s own naming); `UNKNOWN` has no positive claim to
 * make, so it converges to `UNAVAILABLE` rather than a guessed middle
 * ground.
 */
export function convergeCustomerEvidenceItem(item: CustomerEvidenceItem): ConvergedEvidenceItem {
  const disposition: ConvergedEvidenceDisposition =
    item.kind === "FACT" ? "CONFIRMED" : item.kind === "HYPOTHESIS" ? "UNCERTAIN" : "UNAVAILABLE";
  return {
    sourceSurface: "CUSTOMER_EVIDENCE",
    disposition,
    sourceRef: item.evidenceRef,
    originalStatus: item.kind,
  };
}

/**
 * `cross-domain-intelligence.ts`'s own §10 discipline already distinguishes
 * settled (`CURRENT`) from unsettled (`STALE`) from actively disputed
 * (`CONFLICTING`) - this is a direct, lossless projection of that same
 * distinction onto the shared vocabulary.
 */
export function convergeIntelligenceInsight(insight: ReconciledInsight): ConvergedEvidenceItem {
  const disposition: ConvergedEvidenceDisposition =
    insight.status === "CURRENT" ? "CONFIRMED" : insight.status === "STALE" ? "UNCERTAIN" : "CONTRADICTED";
  return {
    sourceSurface: "CROSS_DOMAIN_INTELLIGENCE",
    disposition,
    sourceRef: insight.subjectRef,
    originalStatus: insight.status,
  };
}

const EFFECT_STATE_TO_DISPOSITION: Readonly<Record<ExternalEffectAttemptState, ConvergedEvidenceDisposition>> = {
  NOT_STARTED: "UNAVAILABLE",
  // Mirrors external-effect-envelope.ts's own "readback is authoritative
  // over a claimed outcome" discipline: a merely APPLIED effect is not yet
  // independently confirmed, so it converges to UNCERTAIN, not CONFIRMED.
  APPLIED: "UNCERTAIN",
  VERIFIED: "CONFIRMED",
  FAILED: "CONTRADICTED",
  UNKNOWN: "UNCERTAIN",
  // A rollback is a deliberate, governed undo of something that DID apply
  // - it contradicts any assumption the original effect still holds.
  ROLLED_BACK: "CONTRADICTED",
};

export function convergeExternalEffectAttempt(attempt: ExternalEffectAttempt): ConvergedEvidenceItem {
  return {
    sourceSurface: "EXTERNAL_EFFECT",
    disposition: EFFECT_STATE_TO_DISPOSITION[attempt.state],
    sourceRef: attempt.attemptId,
    originalStatus: attempt.state,
  };
}

const METRIC_STATUS_TO_DISPOSITION: Readonly<Record<MetricReadModelStatus, ConvergedEvidenceDisposition>> = {
  REPORTED_FRESH: "CONFIRMED",
  REPORTED_STALE: "UNCERTAIN",
  MISSING: "UNAVAILABLE",
  NOT_MONITORED: "UNAVAILABLE",
};

export function convergeMetricReadModel(metric: MetricReadModel): ConvergedEvidenceItem {
  return {
    sourceSurface: "TELEMETRY",
    disposition: METRIC_STATUS_TO_DISPOSITION[metric.status],
    sourceRef: metric.metricRef,
    originalStatus: metric.status,
  };
}

export interface ConvergedEvidenceSnapshot {
  readonly tenantId: TenantScope["tenantId"];
  readonly subjectRef: string;
  readonly items: ReadonlyArray<ConvergedEvidenceItem>;
}

/**
 * Pure aggregation only - this module never fetches or re-derives
 * evidence itself; the caller supplies already-converged items (via the
 * four `converge*` functions above) for exactly one subject.
 */
export function buildConvergedEvidenceSnapshot(input: {
  tenantScope: TenantScope;
  subjectRef: unknown;
  items: ReadonlyArray<ConvergedEvidenceItem>;
}): ConvergedEvidenceSnapshot {
  const subjectRef = requireNonEmptyString(input.subjectRef, "subjectRef");
  if (!Array.isArray(input.items)) {
    throw new InvalidCrossSurfaceEvidenceError("items must be an array");
  }
  return { tenantId: input.tenantScope.tenantId, subjectRef, items: input.items };
}

const DISPOSITION_SEVERITY: Readonly<Record<ConvergedEvidenceDisposition, number>> = {
  CONFIRMED: 0,
  UNAVAILABLE: 1,
  UNCERTAIN: 2,
  CONTRADICTED: 3,
};

/**
 * §7 "customer-safe projection": structurally cannot carry `sourceRef`,
 * `originalStatus`, or which internal surface(s) contributed - not
 * omitted by convention, but structurally absent from this type.
 */
export interface CustomerSafeEvidenceSummary {
  readonly subjectRef: string;
  readonly overallDisposition: ConvergedEvidenceDisposition;
  readonly itemCount: number;
}

/**
 * §7 "comparability": `overallDisposition` is the pessimistic (most
 * severe) disposition across every item - a single `CONTRADICTED` item
 * can never be hidden behind otherwise-confirmed evidence, and an empty
 * snapshot (nothing converged yet) is honestly `UNAVAILABLE`, never a
 * fabricated `CONFIRMED`.
 */
export function projectCustomerSafeEvidenceSummary(
  snapshot: ConvergedEvidenceSnapshot,
): CustomerSafeEvidenceSummary {
  if (snapshot.items.length === 0) {
    return { subjectRef: snapshot.subjectRef, overallDisposition: "UNAVAILABLE", itemCount: 0 };
  }
  let worst: ConvergedEvidenceDisposition = "CONFIRMED";
  for (const item of snapshot.items) {
    if (DISPOSITION_SEVERITY[item.disposition] > DISPOSITION_SEVERITY[worst]) {
      worst = item.disposition;
    }
  }
  return { subjectRef: snapshot.subjectRef, overallDisposition: worst, itemCount: snapshot.items.length };
}
