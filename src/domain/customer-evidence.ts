import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidCustomerEvidenceError extends Error {
  constructor(reason: string) {
    super(`Invalid CustomerEvidenceItem: ${reason}`);
    this.name = "InvalidCustomerEvidenceError";
  }
}

type EvidenceItemId = string & { readonly __brand: "CustomerEvidenceItemId" };

export type CustomerEvidenceKind = "FACT" | "HYPOTHESIS" | "UNKNOWN";

/**
 * Typed evidence reference (DEL-003 "Input contracts" #2): a locator, not
 * embedded secret/raw customer-payload content - matches the
 * `EvidenceReference` "reference, not embedded secret material"
 * discipline already established for AKI-BE-001. `relatedRequirementId`
 * is optional lineage only; the compiler attaches matching evidence to a
 * PlanNode for transparency, it never uses evidence content to decide
 * disposition (deterministic invariant: "Compiler never treats one
 * LLM/model response as completeness authority").
 */
export interface CustomerEvidenceItem {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: Project["projectId"];
  readonly evidenceRef: EvidenceItemId;
  readonly kind: CustomerEvidenceKind;
  readonly subject: string;
  readonly sourceLocator: string;
  readonly relatedRequirementId?: RequirementId;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCustomerEvidenceError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidCustomerEvidenceError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidCustomerEvidenceError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidCustomerEvidenceError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createCustomerEvidenceItem(input: {
  tenantScope: TenantScope;
  project: Project;
  evidenceRef: unknown;
  kind: unknown;
  subject: unknown;
  sourceLocator: unknown;
  relatedRequirementId?: unknown;
}): CustomerEvidenceItem {
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidCustomerEvidenceError(
      "project does not belong to the given tenantScope",
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  if (input.kind !== "FACT" && input.kind !== "HYPOTHESIS" && input.kind !== "UNKNOWN") {
    throw new InvalidCustomerEvidenceError(
      'kind must be "FACT", "HYPOTHESIS", or "UNKNOWN"',
    );
  }
  const subject = requireNonEmptyString(input.subject, "subject");
  const sourceLocator = requireNonEmptyString(input.sourceLocator, "sourceLocator");

  let relatedRequirementId: string | undefined;
  if (input.relatedRequirementId !== undefined) {
    relatedRequirementId = requireNonEmptyString(
      input.relatedRequirementId,
      "relatedRequirementId",
    );
  }

  return {
    tenantId: input.tenantScope.tenantId,
    projectId: input.project.projectId,
    evidenceRef: evidenceRef as EvidenceItemId,
    kind: input.kind,
    subject,
    sourceLocator,
    ...(relatedRequirementId !== undefined
      ? { relatedRequirementId: relatedRequirementId as RequirementId }
      : {}),
  };
}
