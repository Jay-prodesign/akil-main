export class InvalidOfferBlueprintError extends Error {
  constructor(reason: string) {
    super(`Invalid OfferBlueprintVersion: ${reason}`);
    this.name = "InvalidOfferBlueprintError";
  }
}

type BlueprintId = string & { readonly __brand: "BlueprintId" };
export type RequirementId = string & { readonly __brand: "RequirementId" };

export type RequirementNecessity = "REQUIRED" | "CONDITIONAL";

/**
 * A single machine-readable capability/requirement declaration within an
 * OfferBlueprintVersion (DEL-003 "Input contracts" #3). `necessity`
 * distinguishes items that must always be delivered for this offer
 * (REQUIRED) from items only delivered when the sold scope opts them in
 * (CONDITIONAL) - see `compilePlan` in `project-plan.ts` for how this
 * drives RequirementDisposition. `dependsOn` references other
 * requirementIds within the same blueprint only.
 */
export interface BlueprintRequirement {
  readonly requirementId: RequirementId;
  readonly description: string;
  readonly necessity: RequirementNecessity;
  readonly dependsOn: ReadonlyArray<RequirementId>;
}

/**
 * Provider-neutral, reusable requirement catalog (DEL-003 "Compiler
 * output contracts" lineage source #4). Not tenant-scoped: a blueprint is
 * a shared template, not tenant data - `compilePlan` binds it to a
 * tenant/project only via the SoldScope it is compiled against.
 */
export interface OfferBlueprintVersion {
  readonly blueprintId: BlueprintId;
  readonly version: string;
  readonly requirements: ReadonlyArray<BlueprintRequirement>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOfferBlueprintError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidOfferBlueprintError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidOfferBlueprintError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOfferBlueprintError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireRequirementInput(
  input: unknown,
  index: number,
): { requirementId: string; description: string; necessity: RequirementNecessity; dependsOn: string[] } {
  if (typeof input !== "object" || input === null) {
    throw new InvalidOfferBlueprintError(`requirements[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  const requirementId = requireNonEmptyString(
    record["requirementId"],
    `requirements[${index}].requirementId`,
  );
  const description = requireNonEmptyString(
    record["description"],
    `requirements[${index}].description`,
  );
  const necessity = record["necessity"];
  if (necessity !== "REQUIRED" && necessity !== "CONDITIONAL") {
    throw new InvalidOfferBlueprintError(
      `requirements[${index}].necessity must be "REQUIRED" or "CONDITIONAL"`,
    );
  }
  const dependsOnInput = record["dependsOn"] ?? [];
  if (!Array.isArray(dependsOnInput)) {
    throw new InvalidOfferBlueprintError(
      `requirements[${index}].dependsOn must be an array`,
    );
  }
  const dependsOn = dependsOnInput.map((dep, depIndex) =>
    requireNonEmptyString(dep, `requirements[${index}].dependsOn[${depIndex}]`),
  );
  return { requirementId, description, necessity, dependsOn };
}

/**
 * T5 (structural half): rejects a requirement graph with a dangling
 * `dependsOn` reference or a dependency cycle, at the earliest point the
 * graph is knowable - blueprint construction - rather than deferring the
 * check to plan compilation. Also rejects duplicate requirementIds within
 * one blueprint, since PlanNode identity is derived from requirementId.
 */
export function createOfferBlueprintVersion(input: {
  blueprintId: unknown;
  version: unknown;
  requirements: unknown;
}): OfferBlueprintVersion {
  const blueprintId = requireNonEmptyString(input.blueprintId, "blueprintId");
  const version = requireNonEmptyString(input.version, "version");
  if (!Array.isArray(input.requirements)) {
    throw new InvalidOfferBlueprintError("requirements must be an array");
  }
  if (input.requirements.length === 0) {
    throw new InvalidOfferBlueprintError("requirements must not be empty");
  }

  const parsed = input.requirements.map((req, index) => requireRequirementInput(req, index));

  const seenIds = new Set<string>();
  for (const req of parsed) {
    if (seenIds.has(req.requirementId)) {
      throw new InvalidOfferBlueprintError(
        `duplicate requirementId "${req.requirementId}"`,
      );
    }
    seenIds.add(req.requirementId);
  }

  for (const req of parsed) {
    for (const dep of req.dependsOn) {
      if (!seenIds.has(dep)) {
        throw new InvalidOfferBlueprintError(
          `requirement "${req.requirementId}" depends on unknown requirementId "${dep}"`,
        );
      }
    }
  }

  const dependencyMap = new Map<string, ReadonlyArray<string>>(
    parsed.map((req) => [req.requirementId, req.dependsOn]),
  );
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const detectCycle = (id: string, path: string[]): void => {
    const status = state.get(id);
    if (status === DONE) {
      return;
    }
    if (status === VISITING) {
      throw new InvalidOfferBlueprintError(
        `dependency cycle detected: ${[...path, id].join(" -> ")}`,
      );
    }
    state.set(id, VISITING);
    for (const dep of dependencyMap.get(id) ?? []) {
      detectCycle(dep, [...path, id]);
    }
    state.set(id, DONE);
  };
  for (const req of parsed) {
    detectCycle(req.requirementId, []);
  }

  return {
    blueprintId: blueprintId as BlueprintId,
    version,
    requirements: parsed.map((req) => ({
      requirementId: req.requirementId as RequirementId,
      description: req.description,
      necessity: req.necessity,
      dependsOn: req.dependsOn.map((dep) => dep as RequirementId),
    })),
  };
}
