import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { OfferBlueprintVersion, RequirementId } from "./offer-blueprint.js";
import type { SoldScope } from "./sold-scope.js";
import type { CustomerEvidenceItem } from "./customer-evidence.js";

export class InvalidProjectPlanError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectPlanVersion: ${reason}`);
    this.name = "InvalidProjectPlanError";
  }
}

type PlanId = string & { readonly __brand: "PlanId" };

export type RequirementDisposition =
  | "REQUIRED"
  | "NOT_APPLICABLE"
  | "UNKNOWN"
  | "BLOCKED";

/**
 * One compiled node of the plan/dependency DAG (DEL-003 "Compiler output
 * contracts" #5/#6). `dependsOn` is copied verbatim from the source
 * blueprint requirement - blueprint construction already guarantees no
 * dangling reference and no cycle (T5), so the DAG carried here is
 * structurally valid by construction. `dispositionReason` is always a
 * non-empty string (T3: NOT_APPLICABLE - and every other disposition -
 * must carry an explicit reason/source, never a silent omission).
 */
export interface PlanNode {
  readonly requirementId: RequirementId;
  readonly description: string;
  readonly dependsOn: ReadonlyArray<RequirementId>;
  readonly disposition: RequirementDisposition;
  readonly dispositionReason: string;
  readonly evidenceRefs: ReadonlyArray<CustomerEvidenceItem["evidenceRef"]>;
}

/**
 * Versioned, tenant/project-scoped compiler output (DEL-003 "Compiler
 * output contracts" #4). `status` intentionally has a single literal
 * value in this bounded slice: this packet does not specify further
 * plan-version lifecycle states (e.g. an approval-bound execution-ready
 * status), so none are invented here.
 */
export interface ProjectPlanVersion {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: Project["projectId"];
  readonly planId: PlanId;
  readonly version: number;
  readonly status: "DRAFT";
  readonly sourceBlueprintId: OfferBlueprintVersion["blueprintId"];
  readonly sourceBlueprintVersion: OfferBlueprintVersion["version"];
  readonly sourceSoldScopeId: SoldScope["soldScopeId"];
  readonly nodes: ReadonlyArray<PlanNode>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidProjectPlanError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidProjectPlanError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidProjectPlanError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidProjectPlanError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function resolveDisposition(
  necessity: "REQUIRED" | "CONDITIONAL",
  requirementId: RequirementId,
  soldScope: SoldScope,
): { disposition: RequirementDisposition; reason: string } {
  if (necessity === "REQUIRED") {
    return {
      disposition: "REQUIRED",
      reason: "blueprint declares this requirement REQUIRED for every offer of this type",
    };
  }
  if (soldScope.includedRequirementIds.includes(requirementId)) {
    return {
      disposition: "REQUIRED",
      reason: "conditional requirement explicitly included in sold scope",
    };
  }
  if (soldScope.excludedRequirementIds.includes(requirementId)) {
    return {
      disposition: "NOT_APPLICABLE",
      reason: "conditional requirement explicitly excluded from sold scope",
    };
  }
  return {
    disposition: "UNKNOWN",
    reason:
      "conditional requirement is neither included nor excluded by the sold scope; an explicit scope decision is required",
  };
}

/**
 * T1/T7/T9: compiles SoldScope + CustomerEvidence + OfferBlueprintVersion
 * into one versioned, deterministic ProjectPlanVersion. Tenant/project
 * identity is taken only from `tenantScope`/`project`; `soldScope` and
 * every evidence item must belong to that exact tenant/project or
 * compilation fails closed (T7). Purely deterministic: no model/LLM call,
 * no randomness, no wall-clock-dependent branching beyond the supplied
 * `now` timestamp.
 *
 * A REQUIRED-necessity requirement whose dependencies did not all resolve
 * to REQUIRED becomes BLOCKED (dependency unmet) rather than REQUIRED -
 * this is the only place BLOCKED is produced; a dangling/cyclic
 * dependency reference is impossible here because `blueprint` was already
 * validated at construction (T5).
 */
export function compilePlan(input: {
  tenantScope: TenantScope;
  project: Project;
  planId: unknown;
  version?: unknown;
  blueprint: OfferBlueprintVersion;
  soldScope: SoldScope;
  evidence?: ReadonlyArray<CustomerEvidenceItem>;
  now: unknown;
}): ProjectPlanVersion {
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProjectPlanError(
      "project does not belong to the given tenantScope",
    );
  }
  if (input.soldScope.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProjectPlanError(
      "soldScope does not belong to the given tenantScope",
    );
  }
  if (input.soldScope.projectId !== input.project.projectId) {
    throw new InvalidProjectPlanError(
      "soldScope does not belong to the given project",
    );
  }
  const evidence = input.evidence ?? [];
  for (const [index, item] of evidence.entries()) {
    if (item.tenantId !== input.tenantScope.tenantId) {
      throw new InvalidProjectPlanError(
        `evidence[${index}] does not belong to the given tenantScope`,
      );
    }
    if (item.projectId !== input.project.projectId) {
      throw new InvalidProjectPlanError(
        `evidence[${index}] does not belong to the given project`,
      );
    }
  }

  const planId = requireNonEmptyString(input.planId, "planId");
  let version = 1;
  if (input.version !== undefined) {
    if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
      throw new InvalidProjectPlanError("version must be a positive integer");
    }
    version = input.version;
  }
  const now = requireNonEmptyString(input.now, "now");

  const knownRequirementIds = new Set(
    input.blueprint.requirements.map((req) => req.requirementId),
  );
  for (const id of input.soldScope.includedRequirementIds) {
    if (!knownRequirementIds.has(id)) {
      throw new InvalidProjectPlanError(
        `soldScope.includedRequirementIds references unknown requirementId "${id}"`,
      );
    }
  }
  for (const id of input.soldScope.excludedRequirementIds) {
    if (!knownRequirementIds.has(id)) {
      throw new InvalidProjectPlanError(
        `soldScope.excludedRequirementIds references unknown requirementId "${id}"`,
      );
    }
  }

  const evidenceByRequirement = new Map<RequirementId, CustomerEvidenceItem["evidenceRef"][]>();
  for (const item of evidence) {
    if (item.relatedRequirementId === undefined) {
      continue;
    }
    const existing = evidenceByRequirement.get(item.relatedRequirementId) ?? [];
    existing.push(item.evidenceRef);
    evidenceByRequirement.set(item.relatedRequirementId, existing);
  }

  const requirementsById = new Map(
    input.blueprint.requirements.map((req) => [req.requirementId, req]),
  );

  // Recursive, memoized resolution in dependency order (not blueprint
  // declaration order): a REQUIRED-necessity requirement is downgraded to
  // BLOCKED if ANY of its dependencies - however deep - did not resolve to
  // REQUIRED. Recursion terminates because the blueprint's dependency graph
  // is already proven acyclic at construction time (T5).
  const resolutions = new Map<RequirementId, { disposition: RequirementDisposition; reason: string }>();
  const resolve = (id: RequirementId): { disposition: RequirementDisposition; reason: string } => {
    const cached = resolutions.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const req = requirementsById.get(id);
    if (req === undefined) {
      throw new InvalidProjectPlanError(
        `internal error: no blueprint requirement found for requirementId "${id}"`,
      );
    }
    let result = resolveDisposition(req.necessity, id, input.soldScope);
    if (result.disposition === "REQUIRED" && req.dependsOn.length > 0) {
      const unmetDependency = req.dependsOn.find((dep) => resolve(dep).disposition !== "REQUIRED");
      if (unmetDependency !== undefined) {
        result = {
          disposition: "BLOCKED",
          reason: `dependency "${unmetDependency}" is not REQUIRED in this plan, so this requirement cannot proceed`,
        };
      }
    }
    resolutions.set(id, result);
    return result;
  };

  const nodes: PlanNode[] = input.blueprint.requirements.map((req) => {
    const resolved = resolve(req.requirementId);
    return {
      requirementId: req.requirementId,
      description: req.description,
      dependsOn: req.dependsOn,
      disposition: resolved.disposition,
      dispositionReason: resolved.reason,
      evidenceRefs: evidenceByRequirement.get(req.requirementId) ?? [],
    };
  });

  return {
    tenantId: input.tenantScope.tenantId,
    projectId: input.project.projectId,
    planId: planId as PlanId,
    version,
    status: "DRAFT",
    sourceBlueprintId: input.blueprint.blueprintId,
    sourceBlueprintVersion: input.blueprint.version,
    sourceSoldScopeId: input.soldScope.soldScopeId,
    nodes,
    createdAt: now,
    updatedAt: now,
  };
}
