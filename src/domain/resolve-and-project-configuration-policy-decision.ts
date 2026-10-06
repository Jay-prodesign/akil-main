import { requireSameTenant, requirePermission, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";
import {
  computeConfigurationPolicyDecisionProjection,
  configurationPolicyResolutionsEqual,
  describeConfigurationPolicyDecisionDrift,
  encodeConfigurationPolicyDecisionKey,
  type ConfigurationPolicyDecisionIdentity,
  type ConfigurationPolicyDecisionProjectionEntry,
  type ConfigurationPolicyDecisionDrift,
} from "./configuration-policy-decision-projection.js";
import type { DurableConfigurationPolicyDecisionStore } from "./durable-configuration-policy-decision-store.js";
import type { EffectiveConfigurationPolicyResolution } from "./effective-configuration-policy.js";

export class ConfigurationPolicyDecisionNotFoundError extends Error {
  constructor(decisionKey: string, decisionId: string) {
    super(`No durable ConfigurationPolicyDecisionProjectionEntry exists for decisionKey "${decisionKey}" decisionId "${decisionId}" - cannot roll back to a decision that was never recorded`);
    this.name = "ConfigurationPolicyDecisionNotFoundError";
  }
}

export interface ResolveAndProjectConfigurationPolicyDecisionResult {
  readonly resolution: EffectiveConfigurationPolicyResolution;
  readonly entry: ConfigurationPolicyDecisionProjectionEntry;
  readonly stale: boolean;
  readonly drift: ReadonlyArray<ConfigurationPolicyDecisionDrift>;
}

/**
 * OS-V0-11 Phase A: the ONE real composition of the existing OS-V0-04
 * `resolveEffectiveConfigurationPolicy` with a durable, explainable,
 * append-only decision history for an exact scope identity. Reuses the
 * resolver verbatim - never a second resolution policy - and adds exactly
 * what Rev192 asked for on top: version/provenance (the full
 * `inputControlsSnapshot` + `computedAt` persisted alongside each
 * resolution), effective-value explanation (`drift`, naming WHICH
 * kind+key changed and between which two controls), and stale-decision
 * invalidation (`stale`) - all without weakening or duplicating the
 * resolver's own protected-floor/precedence/scope-correlation semantics,
 * which remain entirely inside `effective-configuration-policy.ts`.
 *
 * Idempotent: if the freshly-resolved decision is identical to the
 * currently active one for this `decisionKey`, no new entry is appended -
 * the existing entry is returned unchanged with `stale: false`. A
 * genuinely different resolution is always durably recorded as a new
 * `COMPUTED` entry, so the full history is a true replay log - never an
 * "in case" partial write.
 */
export function resolveAndProjectConfigurationPolicyDecision(input: {
  readonly store: DurableConfigurationPolicyDecisionStore;
  readonly identity: ConfigurationPolicyDecisionIdentity;
  readonly controls: ReadonlyArray<unknown>;
  readonly decisionId: unknown;
  readonly now: unknown;
}): ResolveAndProjectConfigurationPolicyDecisionResult {
  const decisionKey = encodeConfigurationPolicyDecisionKey(input.identity);
  const previous = input.store.getActiveDecisionProjection(input.identity.tenantId, decisionKey);

  const freshEntry = computeConfigurationPolicyDecisionProjection({
    identity: input.identity,
    controls: input.controls,
    decisionId: input.decisionId,
    now: input.now,
  });

  if (previous !== undefined && configurationPolicyResolutionsEqual(previous.resolution, freshEntry.resolution)) {
    return { resolution: previous.resolution, entry: previous, stale: false, drift: [] };
  }

  const appended = input.store.appendDecisionProjection(input.identity.tenantId, freshEntry);
  const drift = describeConfigurationPolicyDecisionDrift(previous?.resolution, freshEntry.resolution);
  return { resolution: appended.value.resolution, entry: appended.value, stale: previous !== undefined, drift };
}

/**
 * OS-V0-11 Phase A: safe rollback - never mutates or removes any existing
 * history entry; always appends a NEW `ROLLBACK` entry whose `resolution`/
 * `inputControlsSnapshot` are copied verbatim from the target entry, with
 * `rolledBackToDecisionId` recording exactly which prior decision this
 * reverts to for audit/explainability. A rollback is a materially
 * impactful configuration/policy change (it can resurrect a stale or
 * previously-superseded control selection), so it requires the SAME
 * ordinary-EXECUTE + protected-action authority pairing this codebase
 * already establishes for every other protected mutation (Rev186
 * Founder clarification) - never a bare "read-only" capability.
 */
export function rollbackConfigurationPolicyDecision(input: {
  readonly store: DurableConfigurationPolicyDecisionStore;
  readonly identity: ConfigurationPolicyDecisionIdentity;
  readonly authority: AuthorityContext;
  readonly rollbackToDecisionId: string;
  readonly decisionId: unknown;
  readonly now: unknown;
}): ConfigurationPolicyDecisionProjectionEntry {
  requireSameTenant(input.authority, input.identity.tenantId);
  requirePermission(input.authority, "EXECUTE");
  requireProtectedActionAuthorization(input.authority, "rollbackConfigurationPolicyDecision");

  const decisionKey = encodeConfigurationPolicyDecisionKey(input.identity);
  const target = input.store.getDecisionProjectionById(input.identity.tenantId, decisionKey, input.rollbackToDecisionId);
  if (target === undefined) {
    throw new ConfigurationPolicyDecisionNotFoundError(decisionKey, input.rollbackToDecisionId);
  }

  const decisionId = typeof input.decisionId === "string" ? input.decisionId : String(input.decisionId);
  const now = typeof input.now === "string" ? input.now : String(input.now);
  const entry: ConfigurationPolicyDecisionProjectionEntry = {
    decisionKey,
    decisionId,
    identity: input.identity,
    resolution: target.resolution,
    inputControlsSnapshot: target.inputControlsSnapshot,
    computedAt: now,
    entryKind: "ROLLBACK",
    rolledBackToDecisionId: input.rollbackToDecisionId,
  };

  const appended = input.store.appendDecisionProjection(input.identity.tenantId, entry);
  return appended.value;
}
