export class InvalidDec138ProvenanceError extends Error {
  constructor(reason: string) {
    super(`Invalid Dec138Provenance: ${reason}`);
    this.name = "InvalidDec138ProvenanceError";
  }
}

export type AttributionBasisConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNVERIFIED";

/**
 * The field set required by DEC-138 ("AKI-BE-001 DURABLE HANDOFF
 * PROVENANCE REQUIREMENT") for any Brain-readable Drive/QA handoff,
 * codified here as an actual domain type for the first time (previously
 * expressed only as prose in exported evidence documents) so an
 * EngineeringEventEnvelope can carry it structurally. `generatedByWorkerModel`
 * is optional: DEC-138 requires using it "only when supportable" and
 * falling back to an unverified attribution otherwise - callers that
 * cannot independently establish generator identity should omit it and
 * set `attributionBasisConfidence: "UNVERIFIED"` rather than guessing.
 */
export interface Dec138Provenance {
  readonly taskId: string;
  readonly repository: string;
  readonly branch: string;
  readonly baseSha?: string;
  readonly checkpointSha?: string;
  readonly generatedAt: string;
  readonly generatedByRole: string;
  readonly generatedByWorkerModel?: string;
  readonly executionSurface: string;
  readonly sourceSurface: string;
  readonly transportedByPrincipal: string;
  readonly transportMethod: string;
  readonly sourceEvidenceReferences: ReadonlyArray<string>;
  readonly attributionBasisConfidence: AttributionBasisConfidence;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidDec138ProvenanceError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidDec138ProvenanceError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidDec138ProvenanceError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidDec138ProvenanceError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

export function createDec138Provenance(input: {
  taskId: unknown;
  repository: unknown;
  branch: unknown;
  baseSha?: unknown;
  checkpointSha?: unknown;
  generatedAt: unknown;
  generatedByRole: unknown;
  generatedByWorkerModel?: unknown;
  executionSurface: unknown;
  sourceSurface: unknown;
  transportedByPrincipal: unknown;
  transportMethod: unknown;
  sourceEvidenceReferences: unknown;
  attributionBasisConfidence: unknown;
}): Dec138Provenance {
  const taskId = requireNonEmptyString(input.taskId, "taskId");
  const repository = requireNonEmptyString(input.repository, "repository");
  const branch = requireNonEmptyString(input.branch, "branch");
  const baseSha = optionalNonEmptyString(input.baseSha, "baseSha");
  const checkpointSha = optionalNonEmptyString(input.checkpointSha, "checkpointSha");
  const generatedAt = requireNonEmptyString(input.generatedAt, "generatedAt");
  const generatedByRole = requireNonEmptyString(input.generatedByRole, "generatedByRole");
  const generatedByWorkerModel = optionalNonEmptyString(
    input.generatedByWorkerModel,
    "generatedByWorkerModel",
  );
  const executionSurface = requireNonEmptyString(input.executionSurface, "executionSurface");
  const sourceSurface = requireNonEmptyString(input.sourceSurface, "sourceSurface");
  const transportedByPrincipal = requireNonEmptyString(
    input.transportedByPrincipal,
    "transportedByPrincipal",
  );
  const transportMethod = requireNonEmptyString(input.transportMethod, "transportMethod");
  if (!Array.isArray(input.sourceEvidenceReferences)) {
    throw new InvalidDec138ProvenanceError("sourceEvidenceReferences must be an array");
  }
  const sourceEvidenceReferences = input.sourceEvidenceReferences.map((ref, index) =>
    requireNonEmptyString(ref, `sourceEvidenceReferences[${index}]`),
  );
  const attributionBasisConfidence = input.attributionBasisConfidence;
  if (
    attributionBasisConfidence !== "HIGH" &&
    attributionBasisConfidence !== "MEDIUM" &&
    attributionBasisConfidence !== "LOW" &&
    attributionBasisConfidence !== "UNVERIFIED"
  ) {
    throw new InvalidDec138ProvenanceError(
      'attributionBasisConfidence must be "HIGH", "MEDIUM", "LOW", or "UNVERIFIED"',
    );
  }
  if (generatedByWorkerModel === undefined && attributionBasisConfidence !== "UNVERIFIED") {
    throw new InvalidDec138ProvenanceError(
      "attributionBasisConfidence must be \"UNVERIFIED\" when generatedByWorkerModel is not supplied",
    );
  }

  return {
    taskId,
    repository,
    branch,
    ...(baseSha !== undefined ? { baseSha } : {}),
    ...(checkpointSha !== undefined ? { checkpointSha } : {}),
    generatedAt,
    generatedByRole,
    ...(generatedByWorkerModel !== undefined ? { generatedByWorkerModel } : {}),
    executionSurface,
    sourceSurface,
    transportedByPrincipal,
    transportMethod,
    sourceEvidenceReferences,
    attributionBasisConfidence,
  };
}
