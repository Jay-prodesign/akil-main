import type { TenantScope } from "./tenant-scope.js";

export class InvalidCrossDomainIntelligenceRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid CrossDomainIntelligenceRequest: ${reason}`);
    this.name = "InvalidCrossDomainIntelligenceRequestError";
  }
}

/**
 * V5 Workstream F (Cross-Domain Company Intelligence), §10 text, verbatim:
 * "combine authorized evidence from sales, delivery, operations,
 * engineering, commercial and product surfaces." A closed set matching the
 * blueprint's own six named surfaces - an insight from any other domain is
 * rejected, not silently accepted, so this module cannot become a
 * catch-all for undeclared data sources.
 */
export type IntelligenceSourceDomain =
  | "SALES"
  | "DELIVERY"
  | "OPERATIONS"
  | "ENGINEERING"
  | "COMMERCIAL"
  | "PRODUCT";

const SOURCE_DOMAINS: ReadonlySet<string> = new Set<IntelligenceSourceDomain>([
  "SALES",
  "DELIVERY",
  "OPERATIONS",
  "ENGINEERING",
  "COMMERCIAL",
  "PRODUCT",
]);

/**
 * §10: "derived recommendation cannot mutate source truth" and "derived
 * estimate clearly distinguished from observed truth." `kind` is carried on
 * every insight and preserved verbatim through reconciliation - this module
 * never converts a DERIVED value into an OBSERVED one or vice versa.
 */
export type IntelligenceEvidenceKind = "OBSERVED" | "DERIVED";

/**
 * One piece of evidence about one subject, from one domain. `value` is an
 * opaque string - this module never interprets domain-specific value
 * semantics, only compares insights about the same `subjectRef` for
 * equality to detect agreement/conflict. `sourceRef` is a pointer to the
 * already-existing typed record (e.g. a `CommercialAuthoritySnapshot` or
 * `OperationsAttentionItem`) this insight was read from - this module never
 * reads or reaches into that record itself, matching every other
 * `src/domain/` module's isolation. `sourceRef` must be non-empty and
 * `capturedAt` must not be in the future relative to the request's `asOf` -
 * both enforced by `buildCrossDomainIntelligenceSnapshot`, not merely
 * documented.
 */
export interface IntelligenceInsight {
  readonly tenantScope: TenantScope;
  readonly projectRef: string;
  readonly domain: IntelligenceSourceDomain;
  readonly subjectRef: string;
  readonly kind: IntelligenceEvidenceKind;
  readonly value: string;
  readonly capturedAt: string;
  readonly sourceRef: string;
}

export type ReconciledInsightStatus = "CURRENT" | "STALE" | "CONFLICTING";

/**
 * §10 acceptance: "conflicting sources remain unresolved until reconciled"
 * and "stale evidence cannot masquerade as current." `agreedValue` is
 * present only for `CURRENT` - never fabricated for `STALE` or
 * `CONFLICTING`, so a caller can never read a stale or disputed value as if
 * it were settled.
 */
export interface ReconciledInsight {
  readonly subjectRef: string;
  readonly status: ReconciledInsightStatus;
  readonly insights: ReadonlyArray<IntelligenceInsight>;
  readonly agreedValue?: string;
}

export interface CrossDomainIntelligenceRequest {
  readonly tenantScope: TenantScope;
  readonly projectRef: string;
  readonly insights: ReadonlyArray<IntelligenceInsight>;
  readonly freshnessThresholdMs: number;
  /**
   * Caller-supplied "now" for freshness comparison - this pure function
   * never reads the system clock itself, so its output is fully
   * deterministic and replayable from the same input.
   */
  readonly asOf: string;
}

export interface RejectedIntelligenceInsight {
  readonly insight: IntelligenceInsight;
  readonly reason: string;
}

export interface CrossDomainIntelligenceSnapshot {
  readonly tenantScope: TenantScope;
  readonly projectRef: string;
  readonly asOf: string;
  readonly reconciled: ReadonlyArray<ReconciledInsight>;
  readonly rejectedInsights: ReadonlyArray<RejectedIntelligenceInsight>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCrossDomainIntelligenceRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Builds a governed cross-domain intelligence snapshot from raw insights.
 * Structure/aggregation only - never mutates or re-derives the underlying
 * domain records an insight points to via `sourceRef`.
 *
 * Fail-closed on scope mismatch (§10: "tenant/customer confidential data
 * stays access-scoped" / "no cross-client data leakage"): an insight whose
 * `tenantScope`/`projectRef` differs from the request's is rejected, never
 * silently included. Also fail-closed on an empty `sourceRef` (an insight
 * with no real provenance pointer is not an insight) and on a `capturedAt`
 * in the future relative to `asOf` (evidence cannot be "captured" after the
 * point in time the snapshot is being built for - without this check a
 * future-dated insight's negative age would otherwise satisfy any
 * non-negative freshness threshold and be wrongly treated as current).
 *
 * For each remaining `subjectRef`, insights captured within
 * `freshnessThresholdMs` of `asOf` are "fresh"; the rest are "stale".
 * - No fresh insight exists -> `STALE`, no `agreedValue` (§10: stale
 *   evidence cannot masquerade as current).
 * - Fresh insights disagree on `value` -> `CONFLICTING`, no `agreedValue`
 *   (§10: conflicting sources remain unresolved until reconciled).
 * - Fresh insights agree on `value` -> `CURRENT`, `agreedValue` set.
 */
export function buildCrossDomainIntelligenceSnapshot(
  request: CrossDomainIntelligenceRequest,
): CrossDomainIntelligenceSnapshot {
  const projectRef = requireNonEmptyString(request.projectRef, "projectRef");
  const asOf = requireNonEmptyString(request.asOf, "asOf");
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) {
    throw new InvalidCrossDomainIntelligenceRequestError("asOf must be a valid ISO timestamp");
  }
  if (
    typeof request.freshnessThresholdMs !== "number" ||
    !Number.isFinite(request.freshnessThresholdMs) ||
    request.freshnessThresholdMs < 0
  ) {
    throw new InvalidCrossDomainIntelligenceRequestError(
      "freshnessThresholdMs must be a non-negative finite number",
    );
  }

  const accepted: IntelligenceInsight[] = [];
  const rejectedInsights: RejectedIntelligenceInsight[] = [];

  for (const insight of request.insights) {
    if (!SOURCE_DOMAINS.has(insight.domain)) {
      rejectedInsights.push({ insight, reason: `"${insight.domain}" is not a recognized source domain` });
      continue;
    }
    if (
      insight.tenantScope.tenantId !== request.tenantScope.tenantId ||
      insight.projectRef !== projectRef
    ) {
      rejectedInsights.push({
        insight,
        reason: "insight tenantScope/projectRef does not match the request scope",
      });
      continue;
    }
    if (typeof insight.sourceRef !== "string" || insight.sourceRef.trim().length === 0) {
      rejectedInsights.push({ insight, reason: "sourceRef must be non-empty" });
      continue;
    }
    const capturedAtMs = Date.parse(insight.capturedAt);
    if (Number.isNaN(capturedAtMs)) {
      rejectedInsights.push({ insight, reason: "capturedAt is not a valid ISO timestamp" });
      continue;
    }
    if (capturedAtMs > asOfMs) {
      // A capturedAt in the future relative to asOf cannot be genuine
      // evidence "as of" this snapshot - reject it outright rather than
      // letting the freshness filter below treat it as fresh (a negative
      // age is still "<= freshnessThresholdMs").
      rejectedInsights.push({ insight, reason: "capturedAt cannot be in the future relative to asOf" });
      continue;
    }
    accepted.push(insight);
  }

  const bySubject = new Map<string, IntelligenceInsight[]>();
  for (const insight of accepted) {
    const existing = bySubject.get(insight.subjectRef);
    if (existing === undefined) {
      bySubject.set(insight.subjectRef, [insight]);
    } else {
      existing.push(insight);
    }
  }

  const reconciled: ReconciledInsight[] = [];
  for (const [subjectRef, subjectInsights] of bySubject) {
    const fresh = subjectInsights.filter(
      (insight) => asOfMs - Date.parse(insight.capturedAt) <= request.freshnessThresholdMs,
    );
    if (fresh.length === 0) {
      reconciled.push({ subjectRef, status: "STALE", insights: subjectInsights });
      continue;
    }
    const distinctFreshValues = new Set(fresh.map((insight) => insight.value));
    if (distinctFreshValues.size > 1) {
      reconciled.push({ subjectRef, status: "CONFLICTING", insights: subjectInsights });
      continue;
    }
    const [firstFresh] = fresh;
    reconciled.push({
      subjectRef,
      status: "CURRENT",
      insights: subjectInsights,
      agreedValue: (firstFresh as IntelligenceInsight).value,
    });
  }

  return {
    tenantScope: request.tenantScope,
    projectRef,
    asOf,
    reconciled,
    rejectedInsights,
  };
}
