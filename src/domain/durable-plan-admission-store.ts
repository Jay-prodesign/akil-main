import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
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

function planKey(
  tenantId: TenantScope["tenantId"],
  projectId: Project["projectId"],
  planId: ProjectPlanVersion["planId"],
): string {
  return `${tenantId}::${projectId}::${planId}`;
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
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): ReadonlyArray<PlanAdmissionEvent>;
  getState(
    tenantId: TenantScope["tenantId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): PlanAdmissionRunState | undefined;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency (matches T10/T12). One append-only
 * JSON-lines file per tenant/project/plan under `baseDir`; `getState` always
 * reads the full file and replays it through the pure reducer, proving
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
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): string {
    const safeKey = Buffer.from(planKey(tenantId, projectId, planId), "utf8").toString(
      "base64url",
    );
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  appendEvent(event: PlanAdmissionEvent): void {
    const filePath = this.filePathFor(event.tenantId, event.projectId, event.planId);
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
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): ReadonlyArray<PlanAdmissionEvent> {
    const filePath = this.filePathFor(tenantId, projectId, planId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PlanAdmissionEvent);
  }

  getState(
    tenantId: TenantScope["tenantId"],
    projectId: Project["projectId"],
    planId: ProjectPlanVersion["planId"],
  ): PlanAdmissionRunState | undefined {
    return reconstructPlanAdmissionState(this.getEvents(tenantId, projectId, planId));
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
  projectId: Project["projectId"];
  planId: ProjectPlanVersion["planId"];
  answeredEntity: string;
  eventId: string;
  recordedAt: string;
}): PlanAdmissionRunState {
  const state = input.store.getState(input.tenantId, input.projectId, input.planId);
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
    projectId: input.projectId,
    planId: input.planId,
    planVersion: state.latestResult.planVersion,
    answeredEntity: input.answeredEntity,
    eventId: input.eventId,
    recordedAt: input.recordedAt,
  });
  input.store.appendEvent(event);
  const nextState = input.store.getState(input.tenantId, input.projectId, input.planId);
  if (nextState === undefined) {
    throw new InvalidPlanAdmissionAnswerError("internal error: state missing immediately after recordAnswer");
  }
  return nextState;
}
