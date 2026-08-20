import { createCustomerEvidenceItem } from "../../src/domain/customer-evidence.js";
import type { TenantScope } from "../../src/domain/tenant-scope.js";
import type { Project } from "../../src/domain/project.js";
import type { ProjectPlanVersion } from "../../src/domain/project-plan.js";
import type { EvidenceReadinessAssertion } from "../../src/domain/admission-readiness.js";

/**
 * F1 test helper: builds one unambiguous FACT readiness assertion,
 * structurally reporting `readinessOutcome: "SATISFIED"`, for the exact
 * current plan version, for every REQUIRED node in `plan` - the minimum a
 * caller must supply for `admitPlan`'s readiness gate to clear. Individual
 * tests remove/mutate entries from this list to exercise
 * MISSING/STALE/AMBIGUOUS/UNSATISFIED gaps.
 */
export function buildFullReadinessAssertions(
  tenantScope: TenantScope,
  project: Project,
  plan: ProjectPlanVersion,
): EvidenceReadinessAssertion[] {
  return plan.nodes
    .filter((node) => node.disposition === "REQUIRED")
    .map((node) => ({
      evidence: createCustomerEvidenceItem({
        tenantScope,
        project,
        evidenceRef: `ev-readiness-${node.requirementId}-v${plan.version}`,
        kind: "FACT",
        subject: `Readiness confirmed for ${node.requirementId}`,
        sourceLocator: `internal://test-fixtures/readiness/${node.requirementId}`,
        relatedRequirementId: node.requirementId,
      }),
      assertedForPlanVersion: plan.version,
      readinessOutcome: "SATISFIED" as const,
    }));
}
