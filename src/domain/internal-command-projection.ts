import type { OperationsAttentionItem } from "./operations-attention.js";
import type { InternalAttentionLevel } from "./attention-state.js";
import {
  resolvePartnerCapabilityClaimStatus,
  type PartnerCapabilityClaim,
  type PartnerCapabilityClaimStatus,
} from "./partner-capability-admission.js";

export class InvalidInternalCommandProjectionError extends Error {
  constructor(reason: string) {
    super(`Invalid InternalCommandProjection: ${reason}`);
    this.name = "InvalidInternalCommandProjectionError";
  }
}

/**
 * V5 Workstream J (§14, "V5 Unified Command / Customer Progress Frontend")
 * floor: a pure, read-only aggregation covering two of the eight named
 * internal conceptual surfaces - "Company / Portfolio Attention" and
 * "Partners" - built directly from already-merged V5/V4/V3 domain
 * read-models (`OperationsAttentionItem`, V4 Workstream B; `PartnerCapabilityClaim`,
 * V5 Workstream H). This is deliberately cross-tenant: the existing
 * customer-facing shell (`resolveActiveOperationsAttention`,
 * `operations-attention.ts`) correctly filters to one tenant/customer/
 * project at a time, but an internal company-wide command view is exactly
 * the case where seeing across every tenant is the intended, authorized
 * behavior for internal staff - never for a customer session.
 *
 * GENUINE BOUNDARY, DISCLOSED RATHER THAN FABRICATED: this repository has
 * no internal/staff authentication concept anywhere. `AuthenticatedPrincipal`
 * / `SessionContext` / `TenantContext` (`src/web/session-context.ts`) are
 * exclusively customer/tenant-scoped, built for the customer-facing
 * Client Portal (V2-APP-001/V2-CDO-006). §14's own required UX truths
 * demand internal and customer projections stay separate ("customer
 * projection excludes internal prompts/secrets/private reasoning/
 * irrelevant repo detail") - reusing the customer `AuthenticatedPrincipal`
 * for this internal surface would blur exactly that boundary, and
 * inventing a new internal-principal/session concept is a genuine new
 * architectural decision, not a bounded floor slice. This module
 * therefore has NO HTTP/session/route wiring: it is a pure, caller-
 * invoked aggregation function only. Live route names and internal
 * authentication remain explicitly open dependencies (§14: "live route
 * names resolved later"), not fabricated here.
 */
export interface InternalCommandCenterProjection {
  readonly generatedAt: string;
  readonly companyPortfolioAttention: {
    readonly items: ReadonlyArray<OperationsAttentionItem>;
    readonly activeCount: number;
    readonly levelTally: Readonly<Record<InternalAttentionLevel, number>>;
  };
  readonly partners: {
    readonly claims: ReadonlyArray<PartnerCapabilityClaim>;
    readonly statusTally: Readonly<Record<PartnerCapabilityClaimStatus, number>>;
  };
}

function requireValidTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidInternalCommandProjectionError(`${field} must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidInternalCommandProjectionError(`${field} must be a valid ISO timestamp`);
  }
  return value;
}

/**
 * §14 acceptance direction (implicit in "reflect governed state rather
 * than agent narration"): every field in the returned projection is read
 * directly off already-governed domain records, or computed
 * deterministically from them via each record's own exported resolution
 * function (`resolvePartnerCapabilityClaimStatus`) - this function adds no
 * independent judgment, invents no status, and promotes/demotes nothing.
 *
 * Partner status tally uses `resolvePartnerCapabilityClaimStatus` (not the
 * claim's raw stored `status`) so that `EXPIRED` - a computed, never-
 * stored disposition - is correctly reflected as of the caller-supplied
 * `asOf`, exactly like the underlying module's own discipline (never
 * `Date.now()`, fully deterministic and replayable).
 */
export function buildInternalCommandCenterProjection(input: {
  attentionItems: ReadonlyArray<OperationsAttentionItem>;
  partnerClaims: ReadonlyArray<PartnerCapabilityClaim>;
  generatedAt: unknown;
  asOf: unknown;
}): InternalCommandCenterProjection {
  const generatedAt = requireValidTimestamp(input.generatedAt, "generatedAt");
  const asOf = requireValidTimestamp(input.asOf, "asOf");

  const levelTally: Record<InternalAttentionLevel, number> = {
    NORMAL: 0,
    EXCEPTION: 0,
    ESCALATED: 0,
  };
  let activeCount = 0;
  for (const item of input.attentionItems) {
    levelTally[item.internalAttentionLevel] += 1;
    if (item.isActive) {
      activeCount += 1;
    }
  }

  const statusTally: Record<PartnerCapabilityClaimStatus, number> = {
    UNVERIFIED: 0,
    ADMITTED: 0,
    EXPIRED: 0,
    REVOKED: 0,
  };
  for (const claim of input.partnerClaims) {
    const effectiveStatus = resolvePartnerCapabilityClaimStatus({ claim, asOf });
    statusTally[effectiveStatus] += 1;
  }

  return {
    generatedAt,
    companyPortfolioAttention: {
      items: input.attentionItems,
      activeCount,
      levelTally,
    },
    partners: {
      claims: input.partnerClaims,
      statusTally,
    },
  };
}
