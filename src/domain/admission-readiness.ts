import type { ProjectPlanVersion } from "./project-plan.js";
import type { CustomerEvidenceItem } from "./customer-evidence.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidAdmissionReadinessError extends Error {
  constructor(reason: string) {
    super(`Invalid admission readiness input: ${reason}`);
    this.name = "InvalidAdmissionReadinessError";
  }
}

/**
 * DEL-003 second bounded slice correction (F1): binds a CustomerEvidenceItem
 * to the exact plan version it was asserted against. Reusing
 * `CustomerEvidenceItem` verbatim (not a new evidence vocabulary) for
 * "required capability/access/evidence" readiness - the blueprint already
 * models access/connection declarations as ordinary requirement nodes
 * (e.g. "required-access-connections"), so one uniform readiness contract
 * covers capability/access/evidence without inventing per-category types.
 * `assertedForPlanVersion` is what makes a "stale" prerequisite
 * representable: an assertion made against an earlier plan version does not
 * satisfy a later one, even if the requirementId is unchanged.
 */
export interface EvidenceReadinessAssertion {
  readonly evidence: CustomerEvidenceItem;
  readonly assertedForPlanVersion: ProjectPlanVersion["version"];
}

export type ReadinessGapKind = "MISSING" | "STALE" | "AMBIGUOUS";

export interface ReadinessGap {
  readonly requirementId: RequirementId;
  readonly kind: ReadinessGapKind;
  readonly reason: string;
}

export interface ReadinessResult {
  readonly status: "READY" | "NOT_READY";
  readonly gaps: ReadonlyArray<ReadinessGap>;
}

function requireOwnedAssertion(
  assertion: EvidenceReadinessAssertion,
  plan: ProjectPlanVersion,
  index: number,
): void {
  if (
    assertion.evidence.tenantId !== plan.tenantId ||
    assertion.evidence.projectId !== plan.projectId
  ) {
    throw new InvalidAdmissionReadinessError(
      `readinessAssertions[${index}] does not belong to the given plan's tenant/project`,
    );
  }
}

/**
 * F1: deterministic capability/access/evidence readiness gate, evaluated
 * per REQUIRED requirementId. A requirement is READY only when at least one
 * assertion exists for it, asserted for the exact current plan version, and
 * every such current assertion is an unambiguous FACT - a HYPOTHESIS/UNKNOWN
 * assertion, or a mix of conflicting kinds, is AMBIGUOUS, not readiness.
 * Gaps are returned in `requiredRequirementIds` order for determinism.
 */
export function evaluateReadiness(input: {
  plan: ProjectPlanVersion;
  requiredRequirementIds: ReadonlyArray<RequirementId>;
  assertions: ReadonlyArray<EvidenceReadinessAssertion>;
}): ReadinessResult {
  input.assertions.forEach((assertion, index) =>
    requireOwnedAssertion(assertion, input.plan, index),
  );

  const gaps: ReadinessGap[] = [];
  for (const requirementId of input.requiredRequirementIds) {
    const matching = input.assertions.filter(
      (assertion) => assertion.evidence.relatedRequirementId === requirementId,
    );
    if (matching.length === 0) {
      gaps.push({
        requirementId,
        kind: "MISSING",
        reason: `no readiness evidence asserted for required requirement "${requirementId}"`,
      });
      continue;
    }
    const current = matching.filter(
      (assertion) => assertion.assertedForPlanVersion === input.plan.version,
    );
    if (current.length === 0) {
      gaps.push({
        requirementId,
        kind: "STALE",
        reason: `readiness evidence for "${requirementId}" was asserted against an earlier plan version and does not cover plan version ${input.plan.version}`,
      });
      continue;
    }
    const kinds = new Set(current.map((assertion) => assertion.evidence.kind));
    if (kinds.size > 1 || !kinds.has("FACT")) {
      gaps.push({
        requirementId,
        kind: "AMBIGUOUS",
        reason: `readiness evidence for "${requirementId}" is not an unambiguous FACT (found: ${[...kinds].sort().join(", ")})`,
      });
    }
  }

  return { status: gaps.length === 0 ? "READY" : "NOT_READY", gaps };
}
