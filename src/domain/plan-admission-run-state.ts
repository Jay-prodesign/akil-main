import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { ProjectPlanVersion } from "./project-plan.js";
import type { PlanAdmissionResult } from "./plan-admission.js";
import type { PlanAdmissionEvent, PlanAdmissionEventId } from "./plan-admission-event.js";

export class InvalidPlanAdmissionRunStateError extends Error {
  constructor(reason: string) {
    super(`Invalid PlanAdmissionRunState transition input: ${reason}`);
    this.name = "InvalidPlanAdmissionRunStateError";
  }
}

export interface AnsweredEntityRecord {
  readonly planVersion: ProjectPlanVersion["version"];
  readonly entity: string;
}

/**
 * DEL-003 second bounded slice correction (F2): pure, deterministically
 * reconstructible projection of one plan's durable admission/wait history -
 * mirrors the ENG-ORCH-001 `EngineeringRunState` pattern (exposed
 * dedup/tracking fields, restart-safety by full-log replay) over the
 * smaller plan-admission-specific vocabulary.
 */
export interface PlanAdmissionRunState {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: Project["projectId"];
  readonly planId: ProjectPlanVersion["planId"];
  readonly latestResult?: PlanAdmissionResult;
  readonly appliedEventIds: ReadonlyArray<PlanAdmissionEventId>;
  readonly answeredEntities: ReadonlyArray<AnsweredEntityRecord>;
}

/**
 * F2/T4/T7/T8: single pure reducer. `EVALUATION_RECORDED` only ever
 * advances `latestResult` to an equal-or-newer plan version (monotonic) -
 * an event carrying an older version than the current `latestResult`,
 * however it arrived (replay, out-of-order delivery, duplicate), is durably
 * recorded as applied but never regresses the projected state (T8).
 * `ANSWER_RECORDED` durably appends to `answeredEntities`; exact-entity
 * binding and "was this actually awaited" authorization are enforced at
 * the store boundary (`recordAnswer` in `durable-plan-admission-store.ts`)
 * before the event is ever appended - the pure reducer itself only folds
 * whatever the durable log already contains, so replaying the log can never
 * throw for data that was legitimately accepted once.
 */
export function applyPlanAdmissionEvent(
  state: PlanAdmissionRunState | undefined,
  event: PlanAdmissionEvent,
): PlanAdmissionRunState {
  if (
    state !== undefined &&
    (event.tenantId !== state.tenantId ||
      event.projectId !== state.projectId ||
      event.planId !== state.planId)
  ) {
    throw new InvalidPlanAdmissionRunStateError(
      "event does not belong to this run's tenant/project/planId",
    );
  }

  if (state !== undefined && state.appliedEventIds.includes(event.eventId)) {
    // Exact duplicate delivery of an already-applied event: safe no-op
    // (T8 duplicate safety).
    return state;
  }

  const base: PlanAdmissionRunState = state ?? {
    tenantId: event.tenantId,
    projectId: event.projectId,
    planId: event.planId,
    appliedEventIds: [],
    answeredEntities: [],
  };
  const appliedEventIds = [...base.appliedEventIds, event.eventId];

  if (event.type === "EVALUATION_RECORDED") {
    const isNewerOrEqual =
      base.latestResult === undefined || event.planVersion >= base.latestResult.planVersion;
    return {
      ...base,
      appliedEventIds,
      latestResult: isNewerOrEqual ? event.result : base.latestResult,
    };
  }

  return {
    ...base,
    appliedEventIds,
    answeredEntities: [
      ...base.answeredEntities,
      { planVersion: event.planVersion, entity: event.answeredEntity },
    ],
  };
}

/**
 * Restart-safety by construction (T7): reconstructs a run's full state from
 * its durable event log, in true append order, with no separate in-memory
 * cache that could diverge from what is actually on disk.
 */
export function reconstructPlanAdmissionState(
  events: ReadonlyArray<PlanAdmissionEvent>,
): PlanAdmissionRunState | undefined {
  let state: PlanAdmissionRunState | undefined;
  for (const event of events) {
    state = applyPlanAdmissionEvent(state, event);
  }
  return state;
}
