import { createHash } from "node:crypto";
import type { ProjectPlanVersion } from "./project-plan.js";

export class InvalidApprovalReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid ApprovalReference: ${reason}`);
    this.name = "InvalidApprovalReferenceError";
  }
}

type ApprovalId = string & { readonly __brand: "ApprovalId" };

/**
 * Binds an approval decision to the exact plan artifact/version/payload
 * identity it was given for (DEL-003 T10). `payloadHash` is a
 * deterministic digest of the plan's own content (not just its
 * id/version), so `isApprovalValidForPlan` fails closed even if a plan
 * were reconstructed with the same id/version but different node
 * content - only a payload-identical reconstruction of the exact
 * approved version would still validate.
 *
 * Rev62 AUD-V2-01 correction: `ProjectPlanVersion` is tenant/project-
 * scoped, but the identity above previously carried only `planId`/
 * `planVersion`/`payloadHash` - none of which include tenant or project.
 * A plan is free to reuse the same `planId`/version/content shape across
 * different tenants or projects (nothing in `project-plan.ts` forbids
 * it), so an approval genuinely granted for Project A's plan could
 * validate against a payload-identical Project B plan carrying the same
 * planId/version. `tenantId`/`projectId` are now bound directly on the
 * reference (not merely folded into the hash) so validation fails closed
 * even before comparing content.
 */
export interface ApprovalReference {
  readonly approvalId: ApprovalId;
  readonly tenantId: ProjectPlanVersion["tenantId"];
  readonly projectId: ProjectPlanVersion["projectId"];
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly payloadHash: string;
  readonly approvedAt: string;
  readonly approverRef: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidApprovalReferenceError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidApprovalReferenceError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidApprovalReferenceError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidApprovalReferenceError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * Deterministic content digest of a plan's nodes: stable key order and
 * array order (node order is already deterministic - derived from
 * blueprint requirement order in `compilePlan`) so the same plan content
 * always hashes identically, and any node/disposition/dependency change
 * changes the hash.
 */
function hashPlanPayload(plan: ProjectPlanVersion): string {
  const canonical = JSON.stringify({
    tenantId: plan.tenantId,
    projectId: plan.projectId,
    planId: plan.planId,
    version: plan.version,
    sourceBlueprintId: plan.sourceBlueprintId,
    sourceBlueprintVersion: plan.sourceBlueprintVersion,
    sourceSoldScopeId: plan.sourceSoldScopeId,
    nodes: plan.nodes.map((node) => ({
      requirementId: node.requirementId,
      dependsOn: node.dependsOn,
      disposition: node.disposition,
      dispositionReason: node.dispositionReason,
      evidenceRefs: node.evidenceRefs,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createApprovalReference(input: {
  plan: ProjectPlanVersion;
  approvalId: unknown;
  approvedAt: unknown;
  approverRef: unknown;
}): ApprovalReference {
  const approvalId = requireNonEmptyString(input.approvalId, "approvalId");
  const approvedAt = requireNonEmptyString(input.approvedAt, "approvedAt");
  const approverRef = requireNonEmptyString(input.approverRef, "approverRef");
  return {
    approvalId: approvalId as ApprovalId,
    tenantId: input.plan.tenantId,
    projectId: input.plan.projectId,
    planId: input.plan.planId,
    planVersion: input.plan.version,
    payloadHash: hashPlanPayload(input.plan),
    approvedAt,
    approverRef,
  };
}

/**
 * T10: an approval is valid for a plan only if it names the exact same
 * tenant, project, planId, version, AND content-hash. A material change
 * (new version, same version number reconstructed with different
 * content, or - Rev62 AUD-V2-01 - a payload-identical plan belonging to a
 * different tenant/project) invalidates it - prior approval never
 * silently carries forward across a materially changed or
 * cross-tenant/cross-project artifact.
 */
export function isApprovalValidForPlan(
  approval: ApprovalReference,
  plan: ProjectPlanVersion,
): boolean {
  return (
    approval.tenantId === plan.tenantId &&
    approval.projectId === plan.projectId &&
    approval.planId === plan.planId &&
    approval.planVersion === plan.version &&
    approval.payloadHash === hashPlanPayload(plan)
  );
}
