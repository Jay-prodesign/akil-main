import type { ProjectPlanVersion, PlanNode, RequirementDisposition } from "./project-plan.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidProjectPlanDiffError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectPlanDiff input: ${reason}`);
    this.name = "InvalidProjectPlanDiffError";
  }
}

export interface ProjectPlanDiffChange {
  readonly requirementId: RequirementId;
  readonly fromDisposition: RequirementDisposition;
  readonly toDisposition: RequirementDisposition;
}

/**
 * DEL-003 "Compiler output contracts" #9: deterministic material-change
 * comparison between two versions of the same plan, sufficient to show
 * added/removed/changed requirements and prevent silent scope widening
 * (T8). "Added"/"removed" reflect a requirement's presence in one
 * version's node set but not the other (e.g. a blueprint version change);
 * "changed" reflects the same requirementId present in both versions with
 * a different disposition.
 */
export interface ProjectPlanDiff {
  readonly planId: ProjectPlanVersion["planId"];
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly addedRequirementIds: ReadonlyArray<RequirementId>;
  readonly removedRequirementIds: ReadonlyArray<RequirementId>;
  readonly changedRequirements: ReadonlyArray<ProjectPlanDiffChange>;
}

function byRequirementId(nodes: ReadonlyArray<PlanNode>): Map<RequirementId, PlanNode> {
  return new Map(nodes.map((node) => [node.requirementId, node]));
}

export function diffProjectPlans(
  previous: ProjectPlanVersion,
  next: ProjectPlanVersion,
): ProjectPlanDiff {
  if (previous.planId !== next.planId) {
    throw new InvalidProjectPlanDiffError(
      "previous and next plan versions do not share the same planId",
    );
  }
  if (previous.tenantId !== next.tenantId || previous.projectId !== next.projectId) {
    throw new InvalidProjectPlanDiffError(
      "previous and next plan versions do not belong to the same tenant/project",
    );
  }
  if (next.version <= previous.version) {
    throw new InvalidProjectPlanDiffError(
      "next.version must be strictly greater than previous.version",
    );
  }

  const previousNodes = byRequirementId(previous.nodes);
  const nextNodes = byRequirementId(next.nodes);

  const addedRequirementIds: RequirementId[] = [];
  const removedRequirementIds: RequirementId[] = [];
  const changedRequirements: ProjectPlanDiffChange[] = [];

  for (const [requirementId, nextNode] of nextNodes) {
    const previousNode = previousNodes.get(requirementId);
    if (previousNode === undefined) {
      addedRequirementIds.push(requirementId);
      continue;
    }
    if (previousNode.disposition !== nextNode.disposition) {
      changedRequirements.push({
        requirementId,
        fromDisposition: previousNode.disposition,
        toDisposition: nextNode.disposition,
      });
    }
  }
  for (const requirementId of previousNodes.keys()) {
    if (!nextNodes.has(requirementId)) {
      removedRequirementIds.push(requirementId);
    }
  }

  return {
    planId: next.planId,
    fromVersion: previous.version,
    toVersion: next.version,
    addedRequirementIds,
    removedRequirementIds,
    changedRequirements,
  };
}
