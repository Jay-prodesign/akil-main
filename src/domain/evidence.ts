import type { OutcomeJob } from "./outcome-job.js";

export class InvalidEvidenceReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid EvidenceReference: ${reason}`);
    this.name = "InvalidEvidenceReferenceError";
  }
}

type EvidenceId = string & { readonly __brand: "EvidenceId" };

/**
 * Source/reference locator rather than embedded secret material
 * (AKI-BE-001 execution record, "Scope (Minimum Domain Objects)" #5).
 * Supports a verification claim; it is not itself a verification result
 * (DEC-122 RG-04 - these semantics stay structurally separate).
 */
export interface EvidenceReference {
  readonly evidenceId: EvidenceId;
  readonly tenantId: OutcomeJob["tenantId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly evidenceType: string;
  readonly sourceLocator: string;
  readonly capturedAt: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidEvidenceReferenceError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidEvidenceReferenceError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidEvidenceReferenceError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidEvidenceReferenceError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createEvidenceReference(input: {
  job: OutcomeJob;
  evidenceId: unknown;
  evidenceType: unknown;
  sourceLocator: unknown;
  capturedAt: unknown;
}): EvidenceReference {
  const evidenceId = requireNonEmptyString(input.evidenceId, "evidenceId");
  const evidenceType = requireNonEmptyString(input.evidenceType, "evidenceType");
  const sourceLocator = requireNonEmptyString(input.sourceLocator, "sourceLocator");
  const capturedAt = requireNonEmptyString(input.capturedAt, "capturedAt");
  return {
    evidenceId: evidenceId as EvidenceId,
    tenantId: input.job.tenantId,
    jobId: input.job.jobId,
    evidenceType,
    sourceLocator,
    capturedAt,
  };
}
