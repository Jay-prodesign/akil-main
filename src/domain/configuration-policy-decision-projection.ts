import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import {
  resolveEffectiveConfigurationPolicy,
  type EffectiveControl,
  type EffectiveConfigurationPolicyResolution,
} from "./effective-configuration-policy.js";

export class InvalidConfigurationPolicyDecisionProjectionError extends Error {
  constructor(reason: string) {
    super(`Invalid ConfigurationPolicyDecisionProjection operation: ${reason}`);
    this.name = "InvalidConfigurationPolicyDecisionProjectionError";
  }
}

/**
 * OS-V0-11 Phase A: the SAME scope identity `resolveEffectiveConfigurationPolicy`
 * already accepts (`EffectiveConfigurationPolicyRequest`, minus the `controls`
 * array) - re-declared here, not imported, because this identity is what a
 * durable decision projection is KEYED by, while the resolver's own request
 * type also carries the (non-identity) `controls` payload. Keeping these
 * structurally identical but independently named avoids a durable-store
 * module depending on the resolver's transient request shape.
 */
export interface ConfigurationPolicyDecisionIdentity {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId?: Customer["customerId"];
  readonly projectId?: Project["projectId"];
  readonly jobId?: string;
  readonly actionRef?: string;
}

export type ConfigurationPolicyDecisionEntryKind = "COMPUTED" | "ROLLBACK";

/**
 * A single durable, append-only entry in a `decisionKey`'s history. The
 * LATEST entry (by append order) is always the active decision for that
 * identity - there is no separate mutable "status" field to drift out of
 * sync with the log itself, mirroring the "latest wins over the full
 * append log" discipline already proven by `durable-protected-decision-
 * record-store.ts`/`execution-quota-admission.ts`'s own canonical-latest
 * lookups.
 */
export interface ConfigurationPolicyDecisionProjectionEntry {
  readonly decisionKey: string;
  readonly decisionId: string;
  readonly identity: ConfigurationPolicyDecisionIdentity;
  readonly resolution: EffectiveConfigurationPolicyResolution;
  readonly inputControlsSnapshot: ReadonlyArray<unknown>;
  readonly computedAt: string;
  readonly entryKind: ConfigurationPolicyDecisionEntryKind;
  readonly rolledBackToDecisionId?: string;
}

/**
 * One explained difference between a decision's prior and fresh resolution
 * for a given `kind`+`key` - "effective-value explanation" (Rev192): WHICH
 * control stopped/started winning, never just an opaque "something
 * changed" boolean. `previousControl`/`freshControl` are each `undefined`
 * when that `kind`+`key` did not exist on that side at all (a key that
 * newly appeared or disappeared is still a drift entry).
 */
export interface ConfigurationPolicyDecisionDrift {
  readonly kind: EffectiveControl["kind"];
  readonly key: string;
  readonly previousControl: EffectiveControl | undefined;
  readonly freshControl: EffectiveControl | undefined;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidConfigurationPolicyDecisionProjectionError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Deterministic, collision-safe (`JSON.stringify`-of-ordered-tuple, the
 * same convention `effective-configuration-policy.ts`'s own `effectiveRef`
 * and every other cross-module identity key in this codebase already
 * uses) encoding of a decision's scope identity - the durable store's own
 * partition key for "the one current decision for this exact context".
 */
export function encodeConfigurationPolicyDecisionKey(identity: ConfigurationPolicyDecisionIdentity): string {
  requireNonEmptyString(identity.tenantId, "identity.tenantId");
  if (identity.actionRef !== undefined && identity.jobId === undefined) {
    throw new InvalidConfigurationPolicyDecisionProjectionError(
      "identity.actionRef requires identity.jobId to also be supplied",
    );
  }
  return JSON.stringify([
    identity.tenantId,
    identity.customerId ?? null,
    identity.projectId ?? null,
    identity.jobId ?? null,
    identity.actionRef ?? null,
  ]);
}

function controlKey(control: EffectiveControl): string {
  return `${control.kind}::${control.key}`;
}

/**
 * Pure comparison: two resolutions are the SAME decision iff their
 * `effectiveControls` sets are deep-equal (order-independent - the
 * resolver itself already sorts deterministically, but this comparison
 * does not rely on that for correctness). Never compares `effectiveConfigRefs`/
 * `effectivePolicyRefs` alone, since those are themselves derived
 * one-to-one from `effectiveControls` - comparing the richer provenance
 * shape is strictly equivalent and gives drift detection something to
 * explain.
 */
export function configurationPolicyResolutionsEqual(
  a: EffectiveConfigurationPolicyResolution,
  b: EffectiveConfigurationPolicyResolution,
): boolean {
  if (a.effectiveControls.length !== b.effectiveControls.length) {
    return false;
  }
  const byKeyB = new Map(b.effectiveControls.map((c) => [controlKey(c), c]));
  for (const control of a.effectiveControls) {
    const other = byKeyB.get(controlKey(control));
    if (other === undefined || JSON.stringify(control) !== JSON.stringify(other)) {
      return false;
    }
  }
  return true;
}

/**
 * The full set of per-key differences between a previous and a fresh
 * resolution - empty when `configurationPolicyResolutionsEqual` would
 * return true. `previous` may be `undefined` (no prior decision existed
 * yet), in which case every fresh control is reported as a drift entry
 * with `previousControl: undefined`.
 */
export function describeConfigurationPolicyDecisionDrift(
  previous: EffectiveConfigurationPolicyResolution | undefined,
  fresh: EffectiveConfigurationPolicyResolution,
): ReadonlyArray<ConfigurationPolicyDecisionDrift> {
  const previousByKey = new Map((previous?.effectiveControls ?? []).map((c) => [controlKey(c), c]));
  const freshByKey = new Map(fresh.effectiveControls.map((c) => [controlKey(c), c]));
  const allKeys = new Set<string>([...previousByKey.keys(), ...freshByKey.keys()]);

  const drift: ConfigurationPolicyDecisionDrift[] = [];
  for (const compositeKey of allKeys) {
    const previousControl = previousByKey.get(compositeKey);
    const freshControl = freshByKey.get(compositeKey);
    if (previousControl !== undefined && freshControl !== undefined && JSON.stringify(previousControl) === JSON.stringify(freshControl)) {
      continue;
    }
    const kind = (freshControl ?? previousControl)!.kind;
    const key = (freshControl ?? previousControl)!.key;
    drift.push({ kind, key, previousControl, freshControl });
  }
  drift.sort((x, y) => (x.kind === y.kind ? x.key.localeCompare(y.key) : x.kind.localeCompare(y.kind)));
  return drift;
}

/**
 * Pure construction of a new `COMPUTED` entry - calls the EXISTING,
 * unchanged `resolveEffectiveConfigurationPolicy` verbatim (never a second
 * resolution policy) and wraps its output with the decision-projection
 * envelope. No persistence here - `resolve-and-project-configuration-
 * policy-decision.ts` owns composing this with the durable store.
 */
export function computeConfigurationPolicyDecisionProjection(input: {
  readonly identity: ConfigurationPolicyDecisionIdentity;
  readonly controls: ReadonlyArray<unknown>;
  readonly decisionId: unknown;
  readonly now: unknown;
}): ConfigurationPolicyDecisionProjectionEntry {
  const decisionId = requireNonEmptyString(input.decisionId, "decisionId");
  const now = requireNonEmptyString(input.now, "now");
  const decisionKey = encodeConfigurationPolicyDecisionKey(input.identity);

  const resolution = resolveEffectiveConfigurationPolicy({
    tenantId: input.identity.tenantId,
    ...(input.identity.customerId !== undefined ? { customerId: input.identity.customerId } : {}),
    ...(input.identity.projectId !== undefined ? { projectId: input.identity.projectId } : {}),
    ...(input.identity.jobId !== undefined ? { jobId: input.identity.jobId } : {}),
    ...(input.identity.actionRef !== undefined ? { actionRef: input.identity.actionRef } : {}),
    controls: input.controls,
  });

  return {
    decisionKey,
    decisionId,
    identity: input.identity,
    resolution,
    inputControlsSnapshot: input.controls,
    computedAt: now,
    entryKind: "COMPUTED",
  };
}
