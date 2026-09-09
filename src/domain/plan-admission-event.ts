import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { ProjectPlanVersion } from "./project-plan.js";
import { validatePersistedPlanAdmissionResult, type PlanAdmissionResult } from "./plan-admission.js";

export class InvalidPlanAdmissionEventError extends Error {
  constructor(reason: string) {
    super(`Invalid PlanAdmissionEvent: ${reason}`);
    this.name = "InvalidPlanAdmissionEventError";
  }
}

export type PlanAdmissionEventId = string & { readonly __brand: "PlanAdmissionEventId" };

/**
 * DEL-003 second bounded slice correction (F2): the smallest
 * domain-specific durable event vocabulary needed to prove exact awaited
 * entity/reason, answer binding, one authorized resume, restart
 * reconstruction, and duplicate/out-of-order safety for plan admission -
 * deliberately NOT the ENG-ORCH-001 `EngineeringEventEnvelope`/WORKER-
 * BRAIN-OWNER vocabulary, per Brain's explicit correction guidance not to
 * force engineering-specific event semantics onto a smaller domain record.
 *
 * `EVALUATION_RECORDED` durably persists one `admitPlan` result (itself a
 * pure, already-fail-closed computation - see `plan-admission.ts`).
 * `ANSWER_RECORDED` durably binds an answer to the exact awaited entity of
 * the most recently recorded WAITING evaluation; `eventId` is the caller's
 * idempotency key for that specific answer, so a duplicate/replayed answer
 * (same eventId) is provably a no-op on reconstruction (T4/T8).
 */
export type PlanAdmissionEvent =
  | {
      readonly type: "EVALUATION_RECORDED";
      readonly eventId: PlanAdmissionEventId;
      readonly tenantId: TenantScope["tenantId"];
      readonly projectId: Project["projectId"];
      readonly planId: ProjectPlanVersion["planId"];
      readonly planVersion: ProjectPlanVersion["version"];
      readonly result: PlanAdmissionResult;
      readonly recordedAt: string;
    }
  | {
      readonly type: "ANSWER_RECORDED";
      readonly eventId: PlanAdmissionEventId;
      readonly tenantId: TenantScope["tenantId"];
      readonly projectId: Project["projectId"];
      readonly planId: ProjectPlanVersion["planId"];
      readonly planVersion: ProjectPlanVersion["version"];
      readonly answeredEntity: string;
      readonly recordedAt: string;
    };

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidPlanAdmissionEventError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidPlanAdmissionEventError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidPlanAdmissionEventError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * Deterministic idempotency key for the durable record of one `admitPlan`
 * result: recording the same plan version's evaluation twice (e.g. a
 * retried "resume" recomputation) always produces the exact same eventId,
 * so replay is a no-op by construction rather than by separate dedup logic
 * the caller must remember to apply.
 */
export function evaluationEventId(
  result: Pick<PlanAdmissionResult, "planId" | "planVersion">,
): PlanAdmissionEventId {
  return `${result.planId}:v${result.planVersion}:evaluation` as PlanAdmissionEventId;
}

export function createEvaluationRecordedEvent(input: {
  result: PlanAdmissionResult;
  recordedAt: unknown;
}): PlanAdmissionEvent {
  const recordedAt = requireNonEmptyString(input.recordedAt, "recordedAt");
  return {
    type: "EVALUATION_RECORDED",
    eventId: evaluationEventId(input.result),
    tenantId: input.result.tenantId,
    projectId: input.result.projectId,
    planId: input.result.planId,
    planVersion: input.result.planVersion,
    result: input.result,
    recordedAt,
  };
}

/**
 * AUD-DURABILITY-GAP: re-validates an already-persisted `PlanAdmissionEvent`
 * line (e.g. read back from `FileDurablePlanAdmissionStore`) against this
 * union's own shape, rather than trusting a blind `JSON.parse(...) as
 * PlanAdmissionEvent` cast on replay. Discriminates on `type`, validates
 * every field with the same non-empty/non-whitespace rule the constructors
 * enforce, and - for `EVALUATION_RECORDED` - re-validates the nested
 * `result` via `validatePersistedPlanAdmissionResult`. A corrupted or forged
 * persisted line fails closed here instead of silently flowing into
 * `reconstructPlanAdmissionState`.
 */
export function parsePersistedPlanAdmissionEvent(raw: unknown): PlanAdmissionEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidPlanAdmissionEventError("persisted PlanAdmissionEvent must be an object");
  }
  const record = raw as Record<string, unknown>;
  const eventId = requireNonEmptyString(record.eventId, "eventId") as PlanAdmissionEventId;
  const tenantId = requireNonEmptyString(record.tenantId, "tenantId") as TenantScope["tenantId"];
  const projectId = requireNonEmptyString(record.projectId, "projectId") as Project["projectId"];
  const planId = requireNonEmptyString(record.planId, "planId") as ProjectPlanVersion["planId"];
  if (
    typeof record.planVersion !== "number" ||
    !Number.isInteger(record.planVersion) ||
    record.planVersion < 1
  ) {
    throw new InvalidPlanAdmissionEventError("planVersion must be a positive integer");
  }
  const planVersion = record.planVersion as ProjectPlanVersion["version"];
  const recordedAt = requireNonEmptyString(record.recordedAt, "recordedAt");

  if (record.type === "EVALUATION_RECORDED") {
    const result = validatePersistedPlanAdmissionResult(record.result);
    return {
      type: "EVALUATION_RECORDED",
      eventId,
      tenantId,
      projectId,
      planId,
      planVersion,
      result,
      recordedAt,
    };
  }
  if (record.type === "ANSWER_RECORDED") {
    const answeredEntity = requireNonEmptyString(record.answeredEntity, "answeredEntity");
    return {
      type: "ANSWER_RECORDED",
      eventId,
      tenantId,
      projectId,
      planId,
      planVersion,
      answeredEntity,
      recordedAt,
    };
  }
  throw new InvalidPlanAdmissionEventError(
    `type must be one of "EVALUATION_RECORDED", "ANSWER_RECORDED" (got ${JSON.stringify(record.type)})`,
  );
}

export function createAnswerRecordedEvent(input: {
  tenantId: TenantScope["tenantId"];
  projectId: Project["projectId"];
  planId: ProjectPlanVersion["planId"];
  planVersion: ProjectPlanVersion["version"];
  answeredEntity: unknown;
  eventId: unknown;
  recordedAt: unknown;
}): PlanAdmissionEvent {
  const answeredEntity = requireNonEmptyString(input.answeredEntity, "answeredEntity");
  const eventId = requireNonEmptyString(input.eventId, "eventId");
  const recordedAt = requireNonEmptyString(input.recordedAt, "recordedAt");
  return {
    type: "ANSWER_RECORDED",
    eventId: eventId as PlanAdmissionEventId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    planId: input.planId,
    planVersion: input.planVersion,
    answeredEntity,
    recordedAt,
  };
}
