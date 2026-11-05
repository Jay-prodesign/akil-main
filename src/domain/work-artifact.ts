import type { OutcomeJob } from "./outcome-job.js";

export class InvalidWorkArtifactError extends Error {
  constructor(reason: string) {
    super(`Invalid WorkArtifact: ${reason}`);
    this.name = "InvalidWorkArtifactError";
  }
}

type ArtifactId = string & { readonly __brand: "ArtifactId" };

/**
 * The real deliverable content a job's `EXECUTING` step actually produced -
 * the piece `evidence.ts`'s own `EvidenceReference` deliberately never holds
 * ("source/reference locator rather than embedded secret material"). An
 * `EvidenceReference`'s `sourceLocator` is expected to point AT a
 * `WorkArtifact` (via its `artifactId`) once one exists for a job, not
 * duplicate its content.
 *
 * `producedByConnectorKind` is an opaque string (this module does not import
 * `integration-connector-catalog.ts`'s `ConnectorKind` union) so a caller can
 * record provenance for content produced by any connector kind, including
 * ones this module has no reason to enumerate - mirrors `evidence.ts`'s own
 * "evidenceType: string" convention rather than inventing a second closed
 * enum of the same information.
 *
 * `content` is deliberately NOT required to be canonically pre-trimmed the
 * way identifier fields (`artifactId`/`tenantId`/.../`producedByConnectorKind`)
 * are - real generated text legitimately carries interior whitespace and a
 * trailing newline is common and harmless. Only "non-empty after trimming"
 * is enforced; the exact bytes a caller supplies are stored verbatim.
 */
export interface WorkArtifact {
  readonly artifactId: ArtifactId;
  readonly tenantId: OutcomeJob["tenantId"];
  readonly customerId: OutcomeJob["customerId"];
  readonly projectId: OutcomeJob["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly artifactType: string;
  readonly content: string;
  readonly producedByConnectorKind: string;
  readonly producedAt: string;
}

function requireNonEmptyTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidWorkArtifactError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidWorkArtifactError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidWorkArtifactError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireNonEmptyContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidWorkArtifactError("content must be a string");
  }
  if (value.trim().length === 0) {
    throw new InvalidWorkArtifactError("content must not be empty or whitespace-only");
  }
  return value;
}

export function createWorkArtifact(input: {
  job: OutcomeJob;
  artifactId: unknown;
  artifactType: unknown;
  content: unknown;
  producedByConnectorKind: unknown;
  producedAt: unknown;
}): WorkArtifact {
  return {
    artifactId: requireNonEmptyTrimmedString(input.artifactId, "artifactId") as ArtifactId,
    tenantId: input.job.tenantId,
    customerId: input.job.customerId,
    projectId: input.job.projectId,
    jobId: input.job.jobId,
    artifactType: requireNonEmptyTrimmedString(input.artifactType, "artifactType"),
    content: requireNonEmptyContent(input.content),
    producedByConnectorKind: requireNonEmptyTrimmedString(input.producedByConnectorKind, "producedByConnectorKind"),
    producedAt: requireNonEmptyTrimmedString(input.producedAt, "producedAt"),
  };
}

/** `artifact://{tenantId}/{artifactId}` - the locator convention an `EvidenceReference.sourceLocator` uses to point at a recorded `WorkArtifact`. */
export function workArtifactLocator(artifact: Pick<WorkArtifact, "tenantId" | "artifactId">): string {
  return `artifact://${artifact.tenantId}/${artifact.artifactId}`;
}
