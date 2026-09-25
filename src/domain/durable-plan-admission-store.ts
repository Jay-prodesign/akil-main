import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { ProjectPlanVersion } from "./project-plan.js";
import type { PlanAdmissionResult } from "./plan-admission.js";
import {
  createAnswerRecordedEvent,
  createEvaluationRecordedEvent,
  type PlanAdmissionEvent,
} from "./plan-admission-event.js";
import {
  reconstructPlanAdmissionState,
  type PlanAdmissionRunState,
} from "./plan-admission-run-state.js";

export class InvalidPlanAdmissionAnswerError extends Error {
  constructor(reason: string) {
    super(`Invalid plan admission answer: ${reason}`);
    this.name = "InvalidPlanAdmissionAnswerError";
  }
}

export class CorruptedPlanAdmissionEventError extends Error {
  constructor(reason: string) {
    super(`Corrupted persisted PlanAdmissionEvent: ${reason}`);
    this.name = "CorruptedPlanAdmissionEventError";
  }
}

const RECOGNIZED_ADMISSION_STATUSES: ReadonlySet<string> = new Set(["ADMITTED", "BLOCKED", "WAITING"]);

function requireNonEmptyStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new CorruptedPlanAdmissionEventError(
      `${field} must be a non-empty string with no leading/trailing whitespace, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requirePositiveIntegerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new CorruptedPlanAdmissionEventError(
      `${field} must be a positive integer, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * OS-V0-03 Phase A: persisted plan-admission event JSON is untrusted replay
 * input, exactly like every other durable store in this repository that
 * already revalidates on read (`validatePersistedConnectorConnection`,
 * `validatePersistedOutcomeJobRow`). Before this correction,
 * `FileDurablePlanAdmissionStore.getEvents` blindly `JSON.parse`-cast every
 * line as `PlanAdmissionEvent` - since `plan-admission-run-state.ts`'s pure
 * reducer initializes a run's `tenantId`/`customerId`/`projectId`/`planId`
 * from the FIRST event it is ever folded against (there is no prior state to
 * compare a first event to), a corrupted or forged foreign-scoped first
 * event placed in the requested tuple's own file could construct a foreign
 * `PlanAdmissionRunState` under that tuple's identity. This validator closes
 * that gap at the store boundary, before any event ever reaches the reducer:
 * every persisted event's own identity fields must exactly equal the tuple
 * `getEvents` was actually asked for, and (for `EVALUATION_RECORDED`) the
 * nested `PlanAdmissionResult`'s identity/version must exactly equal the
 * event envelope it is nested inside. Every failure throws
 * `CorruptedPlanAdmissionEventError` (fail-closed) rather than silently
 * dropping or coercing a bad record.
 */
function validatePersistedPlanAdmissionEvent(
  raw: unknown,
  expected: {
    tenantId: TenantScope["tenantId"];
    customerId: Customer["customerId"];
    projectId: Project["projectId"];
    planId: ProjectPlanVersion["planId"];
  },
): PlanAdmissionEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptedPlanAdmissionEventError("persisted event must be a JSON object, not an array or primitive");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.type !== "EVALUATION_RECORDED" && candidate.type !== "ANSWER_RECORDED") {
    throw new CorruptedPlanAdmissionEventError(
      `unrecognized persisted event type: ${JSON.stringify(candidate.type)}`,
    );
  }

  requireNonEmptyStringField(candidate.eventId, "eventId");
  const tenantId = requireNonEmptyStringField(candidate.tenantId, "tenantId");
  const customerId = requireNonEmptyStringField(candidate.customerId, "customerId");
  const projectId = requireNonEmptyStringField(candidate.projectId, "projectId");
  const planId = requireNonEmptyStringField(candidate.planId, "planId");
  const planVersion = requirePositiveIntegerField(candidate.planVersion, "planVersion");
  requireNonEmptyStringField(candidate.recordedAt, "recordedAt");

  const envelopeScopeMismatch =
    tenantId !== expected.tenantId ||
    customerId !== expected.customerId ||
    projectId !== expected.projectId ||
    planId !== expected.planId;
  if (envelopeScopeMismatch) {
    throw new CorruptedPlanAdmissionEventError(
      `persisted event tenant/customer/project/plan ("${tenantId}"/"${customerId}"/"${projectId}"/"${planId}") does not match the requested scope ("${expected.tenantId}"/"${expected.customerId}"/"${expected.projectId}"/"${expected.planId}")`,
    );
  }

  if (candidate.type === "EVALUATION_RECORDED") {
    const rawResult = candidate.result;
    if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
      throw new CorruptedPlanAdmissionEventError("EVALUATION_RECORDED.result must be a JSON object");
    }
    const result = rawResult as Record<string, unknown>;
    const resultTenantId = requireNonEmptyStringField(result.tenantId, "result.tenantId");
    const resultCustomerId = requireNonEmptyStringField(result.customerId, "result.customerId");
    const resultProjectId = requireNonEmptyStringField(result.projectId, "result.projectId");
    const resultPlanId = requireNonEmptyStringField(result.planId, "result.planId");
    const resultPlanVersion = requirePositiveIntegerField(result.planVersion, "result.planVersion");
    const nestedResultMismatch =
      resultTenantId !== tenantId ||
      resultCustomerId !== customerId ||
      resultProjectId !== projectId ||
      resultPlanId !== planId ||
      resultPlanVersion !== planVersion;
    if (nestedResultMismatch) {
      throw new CorruptedPlanAdmissionEventError(
        "EVALUATION_RECORDED.result tenant/customer/project/plan/version does not exactly match its own event envelope",
      );
    }
    if (typeof result.status !== "string" || !RECOGNIZED_ADMISSION_STATUSES.has(result.status)) {
      throw new CorruptedPlanAdmissionEventError(
        `EVALUATION_RECORDED.result.status is not a recognized AdmissionStatus: ${JSON.stringify(result.status)}`,
      );
    }
    return candidate as unknown as PlanAdmissionEvent;
  }

  // ANSWER_RECORDED
  requireNonEmptyStringField(candidate.answeredEntity, "answeredEntity");
  return candidate as unknown as PlanAdmissionEvent;
}

/**
 * Brain Rev44 F2 correction: raw `::`-delimited concatenation of
 * tenantId/customerId/projectId/planId is not actually collision-safe -
 * these components are validated only as non-empty strings elsewhere,
 * never as delimiter-free, so a component containing `::` can shift the
 * apparent tuple boundaries and make two distinct tenant/customer/
 * project/plan tuples resolve to the same key (base64url-encoding the
 * result afterward does not restore the lost boundaries - it just
 * encodes the same already-ambiguous string). `JSON.stringify` of the
 * identity tuple as an array is injective for this purpose: JSON string
 * escaping means two distinct tuples can never serialize to the same
 * string, so this key (before being base64url-encoded into a filename by
 * `filePathFor`) is unambiguous.
 */
function planKey(
  tenantId: TenantScope["tenantId"],
  customerId: Customer["customerId"],
  projectId: Project["projectId"],
  planId: ProjectPlanVersion["planId"],
): string {
  return JSON.stringify([tenantId, customerId, projectId, planId]);
}

/**
 * F2: the durable persistence boundary for plan admission/wait state -
 * mirrors `DurableEngineeringStore`'s contract (append raw, reconstruct via
 * full-log replay) over the plan-admission-specific event vocabulary.
 */
export interface DurablePlanAdmissionStore {
  appendEvent(event: PlanAdmissionEvent): void;
  getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): ReadonlyArray<PlanAdmissionEvent>;
  getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): PlanAdmissionRunState | undefined;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency (matches T10/T12). One append-only
 * JSON-lines file per tenant/customer/project/plan under `baseDir`;
 * `getState` always reads the full file and replays it through the pure
 * reducer, proving
 * restart-safety by construction (T7) exactly as `FileDurableEngineeringStore`
 * does for ENG-ORCH-001.
 */
export class FileDurablePlanAdmissionStore implements DurablePlanAdmissionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): string {
    const safeKey = Buffer.from(planKey(tenantId, customerId, projectId, planId), "utf8").toString(
      "base64url",
    );
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  appendEvent(event: PlanAdmissionEvent): void {
    const filePath = this.filePathFor(event.tenantId, event.customerId, event.projectId, event.planId);
    const line = `${JSON.stringify(event)}\n`;
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existing + line, "utf8");
    } else {
      writeFileSync(filePath, line, "utf8");
    }
  }

  getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): ReadonlyArray<PlanAdmissionEvent> {
    const filePath = this.filePathFor(tenantId, customerId, projectId, planId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) =>
        validatePersistedPlanAdmissionEvent(JSON.parse(line), { tenantId, customerId, projectId, planId }),
      );
  }

  getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): PlanAdmissionRunState | undefined {
    return reconstructPlanAdmissionState(this.getEvents(tenantId, customerId, projectId, planId));
  }
}

/**
 * F2: durably records one `admitPlan` result. Idempotent by construction -
 * `createEvaluationRecordedEvent` derives a deterministic eventId from
 * planId+planVersion, so recording the same version's result twice (a
 * retried recomputation) is a provable no-op on reconstruction rather than
 * something the caller must separately deduplicate.
 */
export function recordEvaluation(input: {
  store: DurablePlanAdmissionStore;
  result: PlanAdmissionResult;
  recordedAt: string;
}): PlanAdmissionRunState {
  const event = createEvaluationRecordedEvent({
    result: input.result,
    recordedAt: input.recordedAt,
  });
  input.store.appendEvent(event);
  const state = input.store.getState(
    input.result.tenantId,
    input.result.customerId,
    input.result.projectId,
    input.result.planId,
  );
  if (state === undefined) {
    throw new InvalidPlanAdmissionAnswerError("internal error: state missing immediately after recordEvaluation");
  }
  return state;
}

/**
 * F2: durably binds an answer to the exact awaited entity of the most
 * recently recorded evaluation - "answer binding", not a free-floating
 * flag. Fails closed (throws, does not append) unless the current durable
 * state is WAITING for exactly this entity: a caller cannot answer a
 * question that was never asked, nor answer an already-BLOCKED/ADMITTED
 * plan back into authorization. `eventId` is the caller's own idempotency
 * key for this specific answer - replaying with the same eventId is a
 * durable no-op (T4: "duplicate answer/replay cannot double-resume"),
 * proven via the reducer's `appliedEventIds` dedup.
 */
export function recordAnswer(input: {
  store: DurablePlanAdmissionStore;
  tenantId: TenantScope["tenantId"];
  customerId: Customer["customerId"];
  projectId: Project["projectId"];
  planId: ProjectPlanVersion["planId"];
  answeredEntity: string;
  eventId: string;
  recordedAt: string;
}): PlanAdmissionRunState {
  const state = input.store.getState(input.tenantId, input.customerId, input.projectId, input.planId);
  if (state?.latestResult === undefined || state.latestResult.status !== "WAITING") {
    throw new InvalidPlanAdmissionAnswerError(
      "no WAITING plan admission evaluation is durably recorded for this plan",
    );
  }
  if (state.latestResult.awaiting?.entity !== input.answeredEntity) {
    throw new InvalidPlanAdmissionAnswerError(
      `answer "${input.answeredEntity}" does not bind to the exact awaited entity "${state.latestResult.awaiting?.entity}"`,
    );
  }
  const event = createAnswerRecordedEvent({
    tenantId: input.tenantId,
    customerId: input.customerId,
    projectId: input.projectId,
    planId: input.planId,
    planVersion: state.latestResult.planVersion,
    answeredEntity: input.answeredEntity,
    eventId: input.eventId,
    recordedAt: input.recordedAt,
  });
  input.store.appendEvent(event);
  const nextState = input.store.getState(input.tenantId, input.customerId, input.projectId, input.planId);
  if (nextState === undefined) {
    throw new InvalidPlanAdmissionAnswerError("internal error: state missing immediately after recordAnswer");
  }
  return nextState;
}
