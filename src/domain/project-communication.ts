import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { ProjectPlanVersion } from "./project-plan.js";
import type { OutcomeJob } from "./outcome-job.js";

export class InvalidProjectCommunicationError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectCommunicationRecord: ${reason}`);
    this.name = "InvalidProjectCommunicationError";
  }
}

type CommunicationId = string & { readonly __brand: "CommunicationId" };

export type CommunicationDirection = "CUSTOMER_TO_AKILTA" | "AKILTA_TO_CUSTOMER";

export type CommunicationClassification = "INFORMATIONAL" | "ACTION_REQUIRED";

export type RequiredActor = "NONE" | "CUSTOMER" | "AKILTA";

export type CommunicationObservationState =
  | "RECORDED_ONLY"
  | "DELIVERY_UNVERIFIED"
  | "DELIVERY_VERIFIED"
  | "DELIVERY_FAILED";

const DIRECTION_VALUES: ReadonlySet<string> = new Set<string>([
  "CUSTOMER_TO_AKILTA",
  "AKILTA_TO_CUSTOMER",
]);

const CLASSIFICATION_VALUES: ReadonlySet<string> = new Set<string>([
  "INFORMATIONAL",
  "ACTION_REQUIRED",
]);

const REQUIRED_ACTOR_VALUES: ReadonlySet<string> = new Set<string>([
  "NONE",
  "CUSTOMER",
  "AKILTA",
]);

const OBSERVATION_STATE_VALUES: ReadonlySet<string> = new Set<string>([
  "RECORDED_ONLY",
  "DELIVERY_UNVERIFIED",
  "DELIVERY_VERIFIED",
  "DELIVERY_FAILED",
]);

/**
 * V2-CDO-003 "ProjectCommunicationRecord" (IN SCOPE #2). A customer-safe
 * communication/message record bound to exactly one ownership tuple.
 * `relatedPlanVersionId`/`relatedJobId` reuse the existing branded ID
 * types from `project-plan.ts`/`outcome-job.ts` (imported `import type`
 * only - this module has no runtime/value dependency on either module,
 * so it cannot call any transition/verification function from them; see
 * O8). All fields here are the complete customer-safe shape: no internal
 * notes, margins, prompts, credentials, raw secrets, or provider payload
 * fields exist on this type (O9).
 */
export interface ProjectCommunicationRecord {
  readonly communicationId: CommunicationId;
  readonly ownership: ProjectOwnershipRef;
  readonly direction: CommunicationDirection;
  readonly classification: CommunicationClassification;
  readonly requiredActor: RequiredActor;
  readonly observationState: CommunicationObservationState;
  readonly evidenceRef?: string;
  readonly relatedPlanVersionId?: ProjectPlanVersion["planId"];
  readonly relatedJobId?: OutcomeJob["jobId"];
  readonly relatedArtifactRef?: string;
  readonly timestamp: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidProjectCommunicationError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidProjectCommunicationError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidProjectCommunicationError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidProjectCommunicationError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

/**
 * O3-O5 construction-time validation.
 *
 * O4: classification/requiredActor compatibility is deterministic -
 * INFORMATIONAL requires NONE; ACTION_REQUIRED requires CUSTOMER or
 * AKILTA. No implicit actor is inferred from either value.
 *
 * O5: DELIVERY_VERIFIED requires a non-empty `evidenceRef`. This
 * constructor is the only way to produce a `ProjectCommunicationRecord` -
 * there is no separate "mark delivered" mutation function anywhere in
 * this module - so RECORDED_ONLY/DELIVERY_UNVERIFIED can never be
 * silently promoted to DELIVERY_VERIFIED after construction; a different
 * observation state requires constructing a new record.
 */
export function createProjectCommunicationRecord(input: {
  communicationId: unknown;
  ownership: ProjectOwnershipRef;
  direction: unknown;
  classification: unknown;
  requiredActor: unknown;
  observationState: unknown;
  evidenceRef?: unknown;
  relatedPlanVersionId?: unknown;
  relatedJobId?: unknown;
  relatedArtifactRef?: unknown;
  timestamp: unknown;
}): ProjectCommunicationRecord {
  const communicationId = requireNonEmptyString(input.communicationId, "communicationId");

  if (typeof input.direction !== "string" || !DIRECTION_VALUES.has(input.direction)) {
    throw new InvalidProjectCommunicationError(
      `direction must be one of ${Array.from(DIRECTION_VALUES).join(", ")}`,
    );
  }
  const direction = input.direction as CommunicationDirection;

  if (typeof input.classification !== "string" || !CLASSIFICATION_VALUES.has(input.classification)) {
    throw new InvalidProjectCommunicationError(
      `classification must be one of ${Array.from(CLASSIFICATION_VALUES).join(", ")}`,
    );
  }
  const classification = input.classification as CommunicationClassification;

  if (typeof input.requiredActor !== "string" || !REQUIRED_ACTOR_VALUES.has(input.requiredActor)) {
    throw new InvalidProjectCommunicationError(
      `requiredActor must be one of ${Array.from(REQUIRED_ACTOR_VALUES).join(", ")}`,
    );
  }
  const requiredActor = input.requiredActor as RequiredActor;

  // O4: deterministic classification/requiredActor compatibility.
  if (classification === "INFORMATIONAL" && requiredActor !== "NONE") {
    throw new InvalidProjectCommunicationError(
      "an INFORMATIONAL communication requires requiredActor NONE",
    );
  }
  if (classification === "ACTION_REQUIRED" && requiredActor === "NONE") {
    throw new InvalidProjectCommunicationError(
      "an ACTION_REQUIRED communication requires requiredActor CUSTOMER or AKILTA",
    );
  }

  if (
    typeof input.observationState !== "string" ||
    !OBSERVATION_STATE_VALUES.has(input.observationState)
  ) {
    throw new InvalidProjectCommunicationError(
      `observationState must be one of ${Array.from(OBSERVATION_STATE_VALUES).join(", ")}`,
    );
  }
  const observationState = input.observationState as CommunicationObservationState;

  const evidenceRef = requireOptionalNonEmptyString(input.evidenceRef, "evidenceRef");
  // O5: DELIVERY_VERIFIED requires a non-empty evidence reference.
  if (observationState === "DELIVERY_VERIFIED" && evidenceRef === undefined) {
    throw new InvalidProjectCommunicationError(
      "observationState DELIVERY_VERIFIED requires a non-empty evidenceRef",
    );
  }

  const relatedPlanVersionId = requireOptionalNonEmptyString(
    input.relatedPlanVersionId,
    "relatedPlanVersionId",
  );
  const relatedJobId = requireOptionalNonEmptyString(input.relatedJobId, "relatedJobId");
  const relatedArtifactRef = requireOptionalNonEmptyString(
    input.relatedArtifactRef,
    "relatedArtifactRef",
  );
  const timestamp = requireNonEmptyString(input.timestamp, "timestamp");

  return {
    communicationId: communicationId as CommunicationId,
    ownership: input.ownership,
    direction,
    classification,
    requiredActor,
    observationState,
    ...(evidenceRef !== undefined ? { evidenceRef } : {}),
    ...(relatedPlanVersionId !== undefined
      ? { relatedPlanVersionId: relatedPlanVersionId as ProjectPlanVersion["planId"] }
      : {}),
    ...(relatedJobId !== undefined ? { relatedJobId: relatedJobId as OutcomeJob["jobId"] } : {}),
    ...(relatedArtifactRef !== undefined ? { relatedArtifactRef } : {}),
    timestamp,
  };
}

/**
 * V2-CDO-003 "bounded communication history/set" (O6/O7). A validated,
 * ownership-bound collection of `ProjectCommunicationRecord`s.
 */
export interface ProjectCommunicationHistory {
  readonly ownership: ProjectOwnershipRef;
  readonly records: ReadonlyArray<ProjectCommunicationRecord>;
}

/**
 * O6: every record's ownership tuple must match the given ownership
 * exactly (tenantId + customerId + projectId) - same "cross-tenant/wrong-
 * project binding fails closed" discipline as `buildDeliveryTimeline`
 * (DEL-003 T7 lineage). A mismatched record is rejected, not silently
 * dropped or rebound.
 * O7: communicationId must be unique within the history.
 */
export function buildProjectCommunicationHistory(input: {
  ownership: ProjectOwnershipRef;
  records: unknown;
}): ProjectCommunicationHistory {
  if (!Array.isArray(input.records)) {
    throw new InvalidProjectCommunicationError("records must be an array");
  }
  const records = input.records as ProjectCommunicationRecord[];

  for (const record of records) {
    if (record.ownership.tenantId !== input.ownership.tenantId) {
      throw new InvalidProjectCommunicationError(
        `communication ${record.communicationId} belongs to a different tenant than the given ownership`,
      );
    }
    if (record.ownership.customerId !== input.ownership.customerId) {
      throw new InvalidProjectCommunicationError(
        `communication ${record.communicationId} belongs to a different customer than the given ownership`,
      );
    }
    if (record.ownership.projectId !== input.ownership.projectId) {
      throw new InvalidProjectCommunicationError(
        `communication ${record.communicationId} belongs to a different project than the given ownership`,
      );
    }
  }

  const seenIds = new Set<string>();
  for (const record of records) {
    if (seenIds.has(record.communicationId)) {
      throw new InvalidProjectCommunicationError(
        `duplicate communicationId "${record.communicationId}"`,
      );
    }
    seenIds.add(record.communicationId);
  }

  return { ownership: input.ownership, records };
}
