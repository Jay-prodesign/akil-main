import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { Project } from "./project.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { AuditEvent } from "./audit-event.js";
import type { ProjectPlanVersion } from "./project-plan.js";
import { type ApprovalReference, isApprovalValidForPlan } from "./approval-reference.js";
import { type DeliveryStatusView, computeDeliveryStatus } from "./delivery-status.js";
import { type DeliveryTimeline, buildDeliveryTimeline } from "./delivery-timeline.js";
import type { ProjectCommunicationHistory, ProjectCommunicationRecord } from "./project-communication.js";
import type { CapabilityAdmission } from "./capability-admission.js";
import type { ProjectActivationProfile } from "./project-activation-profile.js";

export class InvalidClientProjectSnapshotError extends Error {
  constructor(reason: string) {
    super(`Invalid ClientProjectSnapshot: ${reason}`);
    this.name = "InvalidClientProjectSnapshotError";
  }
}

/**
 * V2-CDO-005 "next action + action owner classification" (IN SCOPE).
 * `EXTERNAL_WAIT` is a valid literal per the task head's own enumeration,
 * but `buildClientProjectSnapshot` below never produces it in this
 * bounded slice: no existing repository signal distinguishes "waiting on
 * a third party" from ordinary internal AKILTA exception-state work, and
 * DEC-153's "no invented business rule" discipline (already applied to
 * `outcome-job.ts`'s unimplemented exception-state recovery graph)
 * forbids fabricating that distinction here. The literal stays reserved
 * for a future task with a real repository-sourced signal.
 */
export type NextActionOwner =
  | "NO_ACTION_NEEDED"
  | "CLIENT_ACTION_REQUIRED"
  | "AKILTA_ACTION_REQUIRED"
  | "EXTERNAL_WAIT";

export interface NextAction {
  readonly owner: NextActionOwner;
  readonly relatedCommunicationId?: ProjectCommunicationRecord["communicationId"];
}

/**
 * No canonical ETA/timeline-confidence telemetry source exists anywhere
 * in this repository today. Rather than invent one, this projection's
 * `eta` is always `{ status: "UNKNOWN" }` in this bounded slice - explicit
 * and structurally incapable of holding an invented date/percentage
 * (IN SCOPE: "UNKNOWN remains explicit and no invented precision is
 * allowed"). A later task with a real telemetry source can extend this
 * union with a `KNOWN` variant without breaking this one.
 */
export type EtaProjection = { readonly status: "UNKNOWN" };

/**
 * P4/P5: `isCurrentVersionApproved` reuses `isApprovalValidForPlan`
 * (DEL-003 T10) verbatim - it is false whenever the given approval does
 * not match the current plan's exact `planId` + `version` +
 * content-payload hash, so a materially changed "same version number"
 * plan or a newer version never silently inherits a stale approval.
 * `lastApprovedVersion`, when present, is only the version number the
 * most recent known approval was actually issued for - independently
 * readable from `currentVersion` even when they happen to be equal.
 */
export interface WorkingArtifactState {
  readonly planId: ProjectPlanVersion["planId"];
  readonly currentVersion: ProjectPlanVersion["version"];
  readonly isCurrentVersionApproved: boolean;
  readonly lastApprovedVersion?: ProjectPlanVersion["version"];
}

/**
 * P9: exactly `requiredCapabilityRef` + `status` - no `connectionBindingId`,
 * `evidenceRef`, provider/workspace reference, or delegated-scope detail
 * crosses into the customer-safe projection. Reusing `CapabilityAdmission`
 * for the value/type only; this module never constructs, verifies, or
 * widens one.
 */
export interface CustomerSafeCapabilitySummary {
  readonly requiredCapabilityRef: CapabilityAdmission["requiredCapabilityRef"];
  readonly status: CapabilityAdmission["status"];
}

/**
 * V2-CDO-005 "ClientProjectSnapshot" (IN SCOPE). A pure, read-only
 * composition over already-canonical, already-validated repository
 * projections/records - it introduces no new state machine and performs
 * no construction-time business-rule invention beyond ownership/ boundary
 * checks. `deliveryStatus` (V2-CDO-001 `computeDeliveryStatus`) and
 * `timeline` (V2-CDO-001 `buildDeliveryTimeline`, already customer-safe
 * per its own CR-1) are reused verbatim rather than re-derived.
 * `recentCommunications` passes through `ProjectCommunicationRecord`
 * values unmodified - V2-CDO-003's O9 test already proves that shape has
 * no internal/margin/prompt/credential field, so no further redaction is
 * performed here.
 */
export interface ClientProjectSnapshot {
  readonly ownership: ProjectOwnershipRef;
  readonly deliveryStatus: DeliveryStatusView;
  readonly timeline: DeliveryTimeline;
  readonly verifiedCompletedJobIds: ReadonlyArray<OutcomeJob["jobId"]>;
  readonly nextAction: NextAction;
  readonly eta: EtaProjection;
  readonly workingArtifact?: WorkingArtifactState;
  readonly capabilities: ReadonlyArray<CustomerSafeCapabilitySummary>;
  readonly recentCommunications: ReadonlyArray<ProjectCommunicationRecord>;
}

function ownershipEquals(a: ProjectOwnershipRef, b: ProjectOwnershipRef): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.serviceRef === b.serviceRef
  );
}

const VERIFIED_COMPLETE_STATES: ReadonlySet<OutcomeJob["state"]> = new Set(["VERIFIED", "CLOSED"]);

/**
 * P2: ownership must match the given `project`'s own tenant/customer/
 * project identity before anything else is computed - a caller passing a
 * mismatched ownership tuple is contamination, not silently accepted or
 * dropped (same fail-closed discipline as V2-CDO-001's
 * `computeDeliveryStatus`/`buildDeliveryTimeline`, which this function
 * also calls and whose own cross-tenant/cross-project checks on `jobs`/
 * `auditEvents` are left to do their own fail-closed work rather than
 * being duplicated here).
 *
 * P6/P7: `nextAction` is derived only from the most recent
 * `ProjectCommunicationRecord` (by `timestamp`) whose `classification` is
 * `ACTION_REQUIRED` - `requiredActor: "CUSTOMER"` yields
 * `CLIENT_ACTION_REQUIRED`, `"AKILTA"` yields `AKILTA_ACTION_REQUIRED`.
 * With no such record, `nextAction` is explicitly `NO_ACTION_NEEDED` -
 * routine internal engineering work (an `OutcomeJob` in progress or even
 * in an exception state) can never manufacture a client action on its
 * own, because only an actual `ACTION_REQUIRED`/`CUSTOMER` communication
 * record can produce that value.
 *
 * CXP-ACT-001: when an `activationProfile` (ADM-PROJ-001's
 * `ProjectActivationProfile`) is supplied, its readiness is the
 * authoritative pre-execution `nextAction` source and takes precedence
 * over any communication-derived value - `ACTION_REQUIRED` overrides
 * `nextAction` entirely (`CUSTOMER` -> `CLIENT_ACTION_REQUIRED`; `AKILTA`/
 * `HUMAN_REVIEW` -> `AKILTA_ACTION_REQUIRED`, both being AKILTA-internal
 * from the customer's point of view); `READY` leaves the communication-
 * derived `nextAction` untouched. This function never reuses ADM-PROJ-001's
 * own compiler or authority semantics - it only reads the two already-
 * computed fields (`state`, `nextRequiredActor`) needed to select an
 * owner, and independently re-validates that those two fields are
 * internally consistent (fail-closed) so a hand-built or tampered plain
 * `ProjectActivationProfile`-shaped object can never manufacture a client
 * action. No other field of `ProjectActivationProfile` (`nextRequiredAction`
 * reason/code, `unresolvedGates`, `platformDecision`, `verifiedConnections`,
 * `consumedRoutes`, `sourceFingerprint`, or any routing/provider/workspace
 * identifier) is ever read, copied, or exposed here.
 */
export function buildClientProjectSnapshot(input: {
  ownership: ProjectOwnershipRef;
  project: Project;
  jobs: ReadonlyArray<OutcomeJob>;
  auditEvents?: ReadonlyArray<AuditEvent>;
  plan?: ProjectPlanVersion;
  latestApproval?: ApprovalReference;
  communicationHistory?: ProjectCommunicationHistory;
  capabilityAdmissions?: ReadonlyArray<CapabilityAdmission>;
  activationProfile?: ProjectActivationProfile;
}): ClientProjectSnapshot {
  if (
    input.ownership.tenantId !== input.project.tenantId ||
    input.ownership.customerId !== input.project.customerId ||
    input.ownership.projectId !== input.project.projectId
  ) {
    throw new InvalidClientProjectSnapshotError(
      "ownership does not match the given project's tenant/customer/project identity",
    );
  }

  const deliveryStatus = computeDeliveryStatus({ project: input.project, jobs: input.jobs });
  const timeline = buildDeliveryTimeline({
    project: input.project,
    auditEvents: input.auditEvents ?? [],
  });
  const verifiedCompletedJobIds = input.jobs
    .filter((job) => VERIFIED_COMPLETE_STATES.has(job.state))
    .map((job) => job.jobId);

  let workingArtifact: WorkingArtifactState | undefined;
  if (input.plan !== undefined) {
    if (input.plan.tenantId !== input.project.tenantId || input.plan.projectId !== input.project.projectId) {
      throw new InvalidClientProjectSnapshotError(
        "plan does not belong to the given project's tenant/project identity",
      );
    }
    const isCurrentVersionApproved =
      input.latestApproval !== undefined && isApprovalValidForPlan(input.latestApproval, input.plan);
    workingArtifact = {
      planId: input.plan.planId,
      currentVersion: input.plan.version,
      isCurrentVersionApproved,
      ...(input.latestApproval !== undefined
        ? { lastApprovedVersion: input.latestApproval.planVersion }
        : {}),
    };
  }

  let recentCommunications: ReadonlyArray<ProjectCommunicationRecord> = [];
  let nextAction: NextAction = { owner: "NO_ACTION_NEEDED" };
  if (input.communicationHistory !== undefined) {
    if (!ownershipEquals(input.communicationHistory.ownership, input.ownership)) {
      throw new InvalidClientProjectSnapshotError(
        "communicationHistory does not belong to the given ownership tuple",
      );
    }
    recentCommunications = input.communicationHistory.records;
    const mostRecentActionRequired = [...recentCommunications]
      .filter((record) => record.classification === "ACTION_REQUIRED")
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
      .at(-1);
    if (mostRecentActionRequired !== undefined) {
      nextAction = {
        owner: mostRecentActionRequired.requiredActor === "CUSTOMER" ? "CLIENT_ACTION_REQUIRED" : "AKILTA_ACTION_REQUIRED",
        relatedCommunicationId: mostRecentActionRequired.communicationId,
      };
    }
  }

  if (input.activationProfile !== undefined) {
    if (!ownershipEquals(input.activationProfile.ownership, input.ownership)) {
      throw new InvalidClientProjectSnapshotError(
        "activationProfile does not belong to the given ownership tuple",
      );
    }
    if (input.activationProfile.state === "READY") {
      if (
        input.activationProfile.nextRequiredActor !== "NONE" ||
        input.activationProfile.nextRequiredAction !== undefined
      ) {
        throw new InvalidClientProjectSnapshotError(
          "activationProfile is READY but carries a non-NONE nextRequiredActor or a nextRequiredAction",
        );
      }
      // READY: leave the communication-derived nextAction untouched.
    } else if (input.activationProfile.state === "ACTION_REQUIRED") {
      if (
        input.activationProfile.nextRequiredActor === "NONE" ||
        input.activationProfile.nextRequiredAction === undefined
      ) {
        throw new InvalidClientProjectSnapshotError(
          "activationProfile is ACTION_REQUIRED but carries nextRequiredActor NONE or no nextRequiredAction",
        );
      }
      const actor = input.activationProfile.nextRequiredActor;
      let owner: NextActionOwner;
      if (actor === "CUSTOMER") {
        owner = "CLIENT_ACTION_REQUIRED";
      } else if (actor === "AKILTA" || actor === "HUMAN_REVIEW") {
        owner = "AKILTA_ACTION_REQUIRED";
      } else {
        throw new InvalidClientProjectSnapshotError(
          `activationProfile.nextRequiredActor "${String(actor)}" is not a recognized actor for ACTION_REQUIRED`,
        );
      }
      // Activation readiness is the authoritative pre-execution
      // next-action source - it overrides any communication-derived
      // nextAction entirely, and never carries a relatedCommunicationId.
      nextAction = { owner };
    } else {
      throw new InvalidClientProjectSnapshotError(
        `activationProfile has an unrecognized state "${String(input.activationProfile.state)}"`,
      );
    }
  }

  const capabilities: CustomerSafeCapabilitySummary[] = (input.capabilityAdmissions ?? []).map(
    (admission) => {
      if (!ownershipEquals(admission.ownership, input.ownership)) {
        throw new InvalidClientProjectSnapshotError(
          "capabilityAdmissions entry does not belong to the given ownership tuple",
        );
      }
      return { requiredCapabilityRef: admission.requiredCapabilityRef, status: admission.status };
    },
  );

  return {
    ownership: input.ownership,
    deliveryStatus,
    timeline,
    verifiedCompletedJobIds,
    nextAction,
    eta: { status: "UNKNOWN" },
    ...(workingArtifact !== undefined ? { workingArtifact } : {}),
    capabilities,
    recentCommunications,
  };
}
