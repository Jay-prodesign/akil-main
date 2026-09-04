export class InvalidProjectBootstrapRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectBootstrapRequest: ${reason}`);
    this.name = "InvalidProjectBootstrapRequestError";
  }
}

/**
 * V5 Workstream C (Project/Repository Bootstrap), §7 candidate reusable
 * assets, verbatim: "compact AGENTS/CLAUDE navigation, CURRENT_STATE,
 * SYSTEM_MAP, VERSION_EVOLUTION_MAP, DEPENDENCY_MAP, execution contract,
 * task templates, evidence manifests, review/finding schema, provider/
 * capability registry pointers and protected-gate map." This is a closed
 * set by design: an asset whose `kind` is not one of these literals is not
 * a recognized reusable structural asset and is rejected by
 * `resolveProjectBootstrapPlan` rather than silently copied - the closed
 * enum is itself the enforcement mechanism for §7's "bootstrap never
 * creates production credentials/providers/release authority by default"
 * (there is structurally no "credential" or "provider secret" kind to
 * select).
 */
export type BootstrapAssetKind =
  | "AGENT_NAVIGATION"
  | "CURRENT_STATE"
  | "SYSTEM_MAP"
  | "VERSION_EVOLUTION_MAP"
  | "DEPENDENCY_MAP"
  | "EXECUTION_CONTRACT"
  | "TASK_TEMPLATE"
  | "EVIDENCE_MANIFEST"
  | "REVIEW_FINDING_SCHEMA"
  | "PROVIDER_CAPABILITY_REGISTRY_POINTER"
  | "PROTECTED_GATE_MAP";

const BOOTSTRAP_ASSET_KINDS: ReadonlySet<string> = new Set<BootstrapAssetKind>([
  "AGENT_NAVIGATION",
  "CURRENT_STATE",
  "SYSTEM_MAP",
  "VERSION_EVOLUTION_MAP",
  "DEPENDENCY_MAP",
  "EXECUTION_CONTRACT",
  "TASK_TEMPLATE",
  "EVIDENCE_MANIFEST",
  "REVIEW_FINDING_SCHEMA",
  "PROVIDER_CAPABILITY_REGISTRY_POINTER",
  "PROTECTED_GATE_MAP",
]);

/**
 * One reusable structural asset offered by a template source. `contentRef`
 * is an opaque pointer (a Drive/file/blob identifier, never the content
 * itself) - this module never reads, interprets, or executes whatever it
 * points to; it only ever compares and forwards the string, so it
 * structurally cannot become a code-execution or secret-embedding surface
 * (§7: "never creates production credentials ... by default").
 * `sourceProjectRef`/`sourceVersion` are carried so a receiving project can
 * always answer "where did this pattern come from and at what version" -
 * §7: "imported decisions identify source/version and are revalidated for
 * local applicability."
 */
export interface BootstrapTemplateAsset {
  readonly kind: BootstrapAssetKind;
  readonly sourceProjectRef: string;
  readonly sourceVersion: string;
  readonly contentRef: string;
}

export interface BootstrapTemplateSource {
  readonly templateId: string;
  readonly assets: ReadonlyArray<BootstrapTemplateAsset>;
}

export interface ProjectBootstrapRequest {
  readonly targetProjectNamespace: string;
  /**
   * §7 acceptance: "project identifiers remain unique." The caller supplies
   * every already-existing project namespace it knows of; this function
   * has no independent registry access (`src/domain/` depends on nothing
   * else in `src/`, matching every other domain module's isolation) and
   * therefore cannot silently consult one.
   */
  readonly existingProjectNamespaces: ReadonlyArray<string>;
  readonly template: BootstrapTemplateSource;
}

/**
 * A copied asset in a resolved plan. `supersedesLocalAuthority` is always
 * `false` and is not a caller-settable input anywhere in this module - a
 * literal, not a boolean field a caller could flip - so a copied template
 * asset can never be represented as authoritative over the target
 * project's own current truth (§7 acceptance: "stale template authority
 * cannot override project truth").
 */
export interface ResolvedBootstrapAsset extends BootstrapTemplateAsset {
  readonly supersedesLocalAuthority: false;
}

export interface RejectedBootstrapAsset {
  readonly asset: BootstrapTemplateAsset;
  readonly reason: string;
}

/**
 * Pure planning output only - no filesystem write, no repository creation,
 * no network call. §7: "bootstrap never creates production credentials/
 * providers/release authority by default"; this type cannot represent one
 * even if a caller wanted it to, since nothing here executes the plan.
 */
export interface ProjectBootstrapPlan {
  readonly targetProjectNamespace: string;
  readonly templateId: string;
  readonly copiedAssets: ReadonlyArray<ResolvedBootstrapAsset>;
  readonly rejectedAssets: ReadonlyArray<RejectedBootstrapAsset>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidProjectBootstrapRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Resolves a bootstrap plan for a new project reusing an existing
 * template's structural assets. Fails closed on a duplicate project
 * namespace (§7 acceptance: unique project identifiers) rather than
 * silently reusing or colliding with an existing project's state.
 * Structure/pattern reuse only - never copies "mutable project truth,
 * customer data, secrets, or authority" (§7 Rules): an asset whose `kind`
 * is outside the closed `BootstrapAssetKind` set is rejected, not copied,
 * and every accepted asset is returned as read-only reusable structure via
 * `ResolvedBootstrapAsset`, never as an executable or authoritative value.
 */
export function resolveProjectBootstrapPlan(request: ProjectBootstrapRequest): ProjectBootstrapPlan {
  const targetProjectNamespace = requireNonEmptyString(
    request.targetProjectNamespace,
    "targetProjectNamespace",
  );
  const templateId = requireNonEmptyString(request.template.templateId, "template.templateId");

  if (request.existingProjectNamespaces.includes(targetProjectNamespace)) {
    throw new InvalidProjectBootstrapRequestError(
      `targetProjectNamespace "${targetProjectNamespace}" is not unique - it already identifies an existing project`,
    );
  }

  const copiedAssets: ResolvedBootstrapAsset[] = [];
  const rejectedAssets: RejectedBootstrapAsset[] = [];

  for (const asset of request.template.assets) {
    if (!BOOTSTRAP_ASSET_KINDS.has(asset.kind)) {
      rejectedAssets.push({
        asset,
        reason: `"${asset.kind}" is not a recognized reusable structural asset kind`,
      });
      continue;
    }
    copiedAssets.push({ ...asset, supersedesLocalAuthority: false });
  }

  return {
    targetProjectNamespace,
    templateId,
    copiedAssets,
    rejectedAssets,
  };
}
