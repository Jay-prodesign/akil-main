import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type {
  ExecutionMode,
  ExecutionPolicy,
  DeviceRegistration,
  DeviceCapabilitySnapshot,
  DeviceCapabilityReadiness,
  LocalWorkerRegistration,
  LocalTaskLease,
} from "./local-execution.js";
import { resolveEligibleLocalWorkers } from "./local-execution.js";
import type { AdmittedWorker } from "./worker-routing-policy.js";
import type { AuthorityContext } from "./authority.js";
import { requireSameTenant, requireProtectedActionAuthorization } from "./authority.js";
import type { ExternalEffectAttemptState } from "./external-effect-envelope.js";

export class InvalidLocalExecutionHardeningError extends Error {
  constructor(reason: string) {
    super(`Invalid Local Execution hardening operation: ${reason}`);
    this.name = "InvalidLocalExecutionHardeningError";
  }
}

export class InvalidExecutionModeTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid ExecutionMode transition: ${reason}`);
    this.name = "InvalidExecutionModeTransitionError";
  }
}

export class InvalidKillSwitchTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid LocalExecutionKillSwitch transition: ${reason}`);
    this.name = "InvalidKillSwitchTransitionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidLocalExecutionHardeningError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidLocalExecutionHardeningError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * LOCAL-EXEC-007 (Rev99/100, dedicated architecture packet Drive
 * 1vhHCHZYu15IugytGb2O2epe7jgRFQF6vRoZsozjASDU §21) Phase L6 — Hybrid /
 * UX / Hardening. §21's own named scope for this phase: "Local/CLOUD/
 * HYBRID routing UI; safe switch/migration preflight; kill switch;
 * capability/health telemetry; device updater/signing strategy; installer/
 * package paths for Windows/macOS/Linux as actually needed; optional
 * ephemeral sandbox strategy for risky code; performance/security/soak
 * tests once concrete runtime exists."
 *
 * This checkpoint implements the three dimensions that are honestly
 * buildable as domain contracts today - a tenant-level kill switch, an
 * ExecutionMode transition classification/read-model with supplied-facts
 * safety checks (Brain Rev132: not an authoritative safe-switch/migration
 * preflight - see the Rev129 correction below for why that remains
 * explicitly OPEN), and a device/worker health read-model - composing L0's
 * (`local-execution.ts`) unmodified
 * `ExecutionMode`/`ExecutionPolicy`/`DeviceRegistration`/
 * `DeviceCapabilitySnapshot`/`DeviceCapabilityReadiness`/
 * `LocalWorkerRegistration`/`resolveEligibleLocalWorkers` and mirrors
 * `local-execution-collaboration.ts`'s own `planCollaborationModeTransition`
 * preflight shape exactly for the ExecutionMode dimension. No new routing
 * engine, no new IAM primitive, no real Git/transport/crypto/network call
 * anywhere in this module.
 *
 * Explicitly deferred, not fabricated: device updater/signing strategy,
 * installer/package paths for Windows/macOS/Linux, an ephemeral sandbox
 * strategy, and performance/security/soak tests all require real binaries,
 * signing keys, packaging pipelines, or a live running bridge that do not
 * exist anywhere in this repository - inventing domain contracts for them
 * now would be guessing at infrastructure this checkpoint cannot honestly
 * describe. "Local/CLOUD/HYBRID routing UI" has no real UI framework
 * anywhere in this backend-only repository (matching every other LOCAL-EXEC
 * phase's own "no UI, no live wiring" scope discipline, and Family 10's own
 * precedent of building a read-model rather than a rendered surface); the
 * ExecutionMode transition classification/read-model and health read-model
 * below are this checkpoint's honest, wireable substitute for that UI's own
 * required data.
 *
 * Brain Rev129 correction to the "safe switch/migration preflight" claim
 * above (further renamed per Brain Rev132 below): `planExecutionModeTransition`
 * composes real `LocalTaskLease`/
 * `ExternalEffectAttemptState` facts to fail closed on a NARROWING
 * transition, but only over whatever facts the caller actually supplies -
 * this repository has no durable lease/effect store for it to query an
 * authoritative, complete active set. This is real, structurally-disclosed
 * (`ExecutionModeTransitionPlan.safetyCheckScope`), and useful when a
 * caller does supply accurate data, but it is explicitly NOT the complete
 * "safe switch/migration preflight" §21 names - closing that fully requires
 * a real durable lease/effect store this checkpoint does not build, per
 * Rev129's own authorized narrowing (rather than fabricating one to claim
 * completeness that does not exist).
 *
 * Brain Rev132 correction (docs/metadata truth-surface only, no source
 * behavior change): Rev129 corrected the disclosure text and added the
 * structural `safetyCheckScope` field, but this module's own leading,
 * current-facing capability description above still flatly named the
 * result an "ExecutionMode transition preflight" / "safe switch/migration
 * preflight," which conflicts with the Rev129 correction it precedes. That
 * leading description is now renamed to "ExecutionMode transition
 * classification/read-model with supplied-facts safety checks." Real,
 * authoritative safe-switch/migration preflight enforcement - independent
 * of what a caller chooses to supply - remains explicitly OPEN; it is not,
 * and has never been, something this module actually provides.
 */

// ---------------------------------------------------------------------------
// Tenant-level kill switch (§19: "Settings -> Devices & Local Workers ...
// revoke/quarantine/kill switch"). Distinct from L0's own per-device
// `DevicePolicy.killSwitchEngaged` (which only ever gates one device's own
// `isWorkspaceRootAllowed` check) - this is the broader "Local Execution OFF
// for this whole tenant" circuit breaker, reusable regardless of how many
// devices/workers exist.
// ---------------------------------------------------------------------------

export interface LocalExecutionKillSwitch {
  readonly tenantId: TenantScope["tenantId"];
  readonly engaged: boolean;
  readonly engagedAt?: string;
  readonly engagedReason?: string;
  readonly disengagedAt?: string;
  readonly disengagedByRef?: string;
  readonly disengagedReason?: string;
}

/** A kill switch is always born disengaged - no caller can construct an already-engaged one. */
export function createLocalExecutionKillSwitch(tenantScope: TenantScope): LocalExecutionKillSwitch {
  return { tenantId: tenantScope.tenantId, engaged: false };
}

/**
 * Engaging never requires elevated authority - it can only ever tighten
 * the gate (turn local execution OFF for the tenant), mirroring this
 * codebase's own established asymmetric-authority precedent (Rev117/120:
 * the direction that can only restrict never needs protected-action
 * authority; the direction that opens something back up does).
 */
export function engageLocalExecutionKillSwitch(input: {
  killSwitch: LocalExecutionKillSwitch;
  engagedAt: unknown;
  reason: unknown;
}): LocalExecutionKillSwitch {
  if (input.killSwitch.engaged) {
    throw new InvalidKillSwitchTransitionError("kill switch is already engaged");
  }
  const engagedAt = requireValidTimestamp(input.engagedAt, "engagedAt").raw;
  const engagedReason = requireNonEmptyString(input.reason, "reason");
  return { tenantId: input.killSwitch.tenantId, engaged: true, engagedAt, engagedReason };
}

/**
 * Brain Rev125 correction: disengagement was previously freely callable by
 * anyone holding a reference to the switch - the exact opposite direction
 * from engagement (it re-opens local-worker eligibility for the whole
 * tenant), so it is the one that must require elevated authority, mirroring
 * `admitManualExecutionAllowedFromServiceCatalogAdmission`/Rev117's own
 * "the direction that opens the gate needs protected-action authority"
 * precedent. Reuses the existing `AuthorityContext`/
 * `requireProtectedActionAuthorization` primitive (`authority.ts`) rather
 * than inventing a second IAM. `AuthorityContext` itself carries no
 * individual-actor identity (it is a tenant/permission-scope object, not a
 * session/identity resolver - see its own doc comment), so `disengagedByRef`
 * is a caller-supplied, non-empty auditable release-provenance string,
 * mirroring `ClosureApprovalReference.approverRef`'s own established,
 * honestly-disclosed limit: authority proves the caller *may* release the
 * switch, `disengagedByRef` records *who* they claimed to be, and a bare
 * fabricated ref is not, by itself, proof of identity - the same limit this
 * repository already accepted for every other approver-ref-shaped field.
 */
export function disengageLocalExecutionKillSwitch(input: {
  killSwitch: LocalExecutionKillSwitch;
  authority: AuthorityContext;
  disengagedAt: unknown;
  disengagedByRef: unknown;
  reason: unknown;
}): LocalExecutionKillSwitch {
  if (!input.killSwitch.engaged) {
    throw new InvalidKillSwitchTransitionError("kill switch is already disengaged");
  }
  requireSameTenant(input.authority, input.killSwitch.tenantId);
  requireProtectedActionAuthorization(input.authority, "DISENGAGE_LOCAL_EXECUTION_KILL_SWITCH");
  const disengagedAt = requireValidTimestamp(input.disengagedAt, "disengagedAt").raw;
  const disengagedByRef = requireNonEmptyString(input.disengagedByRef, "disengagedByRef");
  const disengagedReason = requireNonEmptyString(input.reason, "reason");
  return {
    tenantId: input.killSwitch.tenantId,
    engaged: false,
    disengagedAt,
    disengagedByRef,
    disengagedReason,
  };
}

/**
 * The one required composition point for the kill switch: delegates
 * entirely to the existing, unmodified `resolveEligibleLocalWorkers` -
 * when engaged, no local worker is ever offered as a routing candidate,
 * structurally the same empty result `ExecutionMode: "CLOUD_NORMAL"`
 * already produces there, without requiring the caller to mutate their own
 * stored `ExecutionPolicy` to get it. Fails closed if the kill switch and
 * the requesting tenant disagree, mirroring `resolveEligibleLocalWorkers`'s
 * own tenant-consistency checks.
 */
export function resolveEligibleLocalWorkersUnderKillSwitch(input: {
  killSwitch: LocalExecutionKillSwitch;
  executionPolicy: ExecutionPolicy;
  registrations: ReadonlyArray<LocalWorkerRegistration>;
  requestingTenantId: TenantScope["tenantId"];
  targetOwnership: ProjectOwnershipRef;
  requestingOwnerMembershipRef: string;
}): ReadonlyArray<AdmittedWorker> {
  if (input.killSwitch.tenantId !== input.requestingTenantId) {
    throw new InvalidLocalExecutionHardeningError(
      "killSwitch belongs to a different tenant than requestingTenantId",
    );
  }
  if (input.killSwitch.engaged) {
    return [];
  }
  return resolveEligibleLocalWorkers({
    executionPolicy: input.executionPolicy,
    registrations: input.registrations,
    requestingTenantId: input.requestingTenantId,
    targetOwnership: input.targetOwnership,
    requestingOwnerMembershipRef: input.requestingOwnerMembershipRef,
  });
}

// ---------------------------------------------------------------------------
// ExecutionMode transition classification/read-model with supplied-facts
// safety checks (Brain Rev132: renamed from "ExecutionMode transition
// preflight" / "safe switch/migration preflight" - real, authoritative
// safe-switch/migration preflight enforcement remains explicitly OPEN, see
// the Rev129/Rev132 correction above), mirroring
// `local-execution-collaboration.ts`'s own `planCollaborationModeTransition`
// shape for the CollaborationMode dimension. §3: "Local Mode must never
// automatically enable Team Pool or Shared Repo" - this module's own return
// type carries no `collaborationMode` field at all, so it cannot alter that
// dimension even by construction.
// ---------------------------------------------------------------------------

/**
 * Rank reflects local-worker routing-eligibility breadth only, exactly as
 * `resolveEligibleLocalWorkers` itself implements it: `CLOUD_NORMAL` admits
 * no local worker at all; `PERSONAL_LOCAL` admits the requester's own
 * `PRIVATE`-pool workers; `TEAM_LOCAL`/`HYBRID` both additionally admit
 * bound `ORG_POOL` workers - `resolveEligibleLocalWorkers`'s own filter
 * treats these two identically (its only special-cased modes are
 * `CLOUD_NORMAL` and `PERSONAL_LOCAL`), so they share one rank here too.
 * Whether normal remote/API workers are *also* concatenated into the
 * candidate pool alongside local ones (`HYBRID`'s own distinguishing
 * behavior per the architecture packet) is explicitly a caller-side
 * decision `resolveEligibleLocalWorkers` documents itself as never
 * governing - this module does not claim to observe or enforce it either,
 * rather than fabricating a coexistence guarantee neither module can prove.
 */
const EXECUTION_MODE_RANK: Readonly<Record<ExecutionMode, number>> = {
  CLOUD_NORMAL: 0,
  PERSONAL_LOCAL: 1,
  TEAM_LOCAL: 2,
  HYBRID: 2,
};

/**
 * Independent code review of this checkpoint found that indexing
 * `EXECUTION_MODE_RANK` directly with an untrusted `unknown` value is
 * bypassable: a plain object literal's lookup walks the prototype chain,
 * so a caller-supplied string like `"constructor"` or `"toString"`
 * resolves to an inherited `Object.prototype` function value instead of
 * `undefined`, defeating the `=== undefined` fail-closed check entirely
 * (live-reproduced: `planExecutionModeTransition({from:"constructor",
 * to:"toString"})` returned a fabricated `WIDENING` plan instead of
 * throwing). Mirrors `worker-routing-policy.ts`'s own Rev60 F1 fix for
 * the identical class of bug (`AUTHORITY_RANK` there): a real value must
 * pass an explicit equality-based `Set` membership check - which only
 * ever matches its own declared members and cannot resolve through the
 * prototype chain - *before* the rank table is ever indexed.
 */
const RECOGNIZED_EXECUTION_MODES: ReadonlySet<string> = new Set<string>([
  "CLOUD_NORMAL",
  "PERSONAL_LOCAL",
  "TEAM_LOCAL",
  "HYBRID",
]);

function isRecognizedExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && RECOGNIZED_EXECUTION_MODES.has(value);
}

export type ExecutionModeTransitionDirection = "WIDENING" | "NARROWING" | "LATERAL" | "UNCHANGED";

/**
 * Brain Rev129 correction: names, structurally (not just in prose), exactly
 * what safety verification actually happened for this plan - `"NOT_APPLICABLE"`
 * for every direction except `NARROWING` (no safety question exists for
 * WIDENING/LATERAL/UNCHANGED), and `"CHECKED_SUPPLIED_FACTS_ONLY"` for
 * `NARROWING` - never a value implying an authoritative, complete guarantee.
 * See `planExecutionModeTransition`'s own doc comment for why no stronger
 * value is honestly available.
 */
export type ExecutionModeSafetyCheckScope = "NOT_APPLICABLE" | "CHECKED_SUPPLIED_FACTS_ONLY";

export interface ExecutionModeTransitionPlan {
  readonly from: ExecutionMode;
  readonly to: ExecutionMode;
  readonly direction: ExecutionModeTransitionDirection;
  readonly safetyCheckScope: ExecutionModeSafetyCheckScope;
  readonly disclosure: string;
}

/**
 * `LocalTaskLease` statuses with an empty transition set in
 * `local-execution.ts`'s own `LEASE_TRANSITIONS` map - a lease in any other
 * status is still active work that a narrowing transition could orphan.
 */
const TERMINAL_LEASE_STATUSES: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * Brain Rev125 correction: this preflight was previously pure
 * classification - its own NARROWING disclosure admitted outright that
 * "any task already leased to a local worker is unaffected by this
 * preflight alone," i.e. it computed a label but enforced nothing. Required
 * correction: either compose existing lease/checkpoint/effect/readiness
 * facts to fail closed on unsafe transitions, or honestly narrow the claim.
 * Added a real, composed check: a NARROWING transition fails closed if any
 * supplied `LocalTaskLease` is still non-terminal, or any supplied
 * `ExternalEffectAttemptState` is `UNKNOWN`, mirroring
 * `resolveLocalExecutionFailover`'s own precedent of refusing to act while
 * an effect's real-world outcome is unverified.
 *
 * Brain Rev129 correction (independent exact-head review of the Rev125 fix):
 * that check is still not an authoritative safe-switch preflight, because
 * `activeLeases`/`externalEffectStates` are optional caller inputs - a
 * caller that omits real active work evades the check entirely, and the
 * function's own prior disclosure text obscured this by describing the
 * omission case as passing "vacuously" rather than naming the gap plainly.
 * Rev129 authorized two fixes: compose a *complete*, authoritative
 * lease/effect snapshot (closing the gap for real), or honestly narrow the
 * claim and leave real safe-switch preflight explicitly OPEN. A repo-wide
 * check found no durable `LocalTaskLease`/effect-state store exists
 * anywhere in this repository - only in-memory construction/transition
 * functions (`local-execution.ts`) - so "compose a complete snapshot" would
 * mean inventing a new persistence/store dependency this module has never
 * had (violating its own "pure domain composition, no store/transport
 * dependency anywhere" boundary, verified by its own boundary-scan test).
 * Building that store now would be exactly the kind of fabricated
 * infrastructure this corridor's own discipline forbids, not "the
 * narrowest honest adapter."
 *
 * Taking Rev129's second, pre-authorized path instead: the claim is now
 * honestly narrowed, structurally as well as in prose.
 * `ExecutionModeTransitionPlan.safetyCheckScope` is
 * `"CHECKED_SUPPLIED_FACTS_ONLY"` for every `NARROWING` plan - never a value
 * implying completeness or an authoritative guarantee - and the disclosure
 * text states plainly that a caller omitting real active leases/effects
 * bypasses the check, rather than describing that omission as a benign
 * "vacuous pass." Real, authoritative safe-switch/migration preflight
 * enforcement (independent of what a caller chooses to supply) remains an
 * explicitly named OPEN gap, not fabricated as closed - it requires a real
 * durable lease/effect store this repository does not have.
 */
export function planExecutionModeTransition(input: {
  from: unknown;
  to: unknown;
  activeLeases?: ReadonlyArray<LocalTaskLease>;
  externalEffectStates?: ReadonlyArray<ExternalEffectAttemptState>;
}): ExecutionModeTransitionPlan {
  if (!isRecognizedExecutionMode(input.from) || !isRecognizedExecutionMode(input.to)) {
    throw new InvalidExecutionModeTransitionError("from/to must both be recognized ExecutionMode values");
  }
  const from = input.from;
  const to = input.to;
  const fromRank = EXECUTION_MODE_RANK[from];
  const toRank = EXECUTION_MODE_RANK[to];
  const collaborationDisclosure =
    "CollaborationMode is a fully independent dimension and is never altered by this transition.";

  if (from === to) {
    return {
      from,
      to,
      direction: "UNCHANGED",
      safetyCheckScope: "NOT_APPLICABLE",
      disclosure: `${from} to ${to} is not a mode change.`,
    };
  }
  if (toRank > fromRank) {
    return {
      from,
      to,
      direction: "WIDENING",
      safetyCheckScope: "NOT_APPLICABLE",
      disclosure:
        `Moving from ${from} to ${to} newly admits local workers into routing eligibility ` +
        `(per resolveEligibleLocalWorkers's own pool/ownership gate). ${collaborationDisclosure}`,
    };
  }
  if (toRank < fromRank) {
    const activeLeases = input.activeLeases ?? [];
    const orphanedLease = activeLeases.find((lease) => !TERMINAL_LEASE_STATUSES.has(lease.status));
    if (orphanedLease !== undefined) {
      throw new InvalidExecutionModeTransitionError(
        `cannot narrow from ${from} to ${to} while lease "${orphanedLease.leaseId}" is still active ` +
          `(status ${orphanedLease.status}) - narrowing would orphan work already leased to a local worker`,
      );
    }
    const externalEffectStates = input.externalEffectStates ?? [];
    if (externalEffectStates.includes("UNKNOWN")) {
      throw new InvalidExecutionModeTransitionError(
        `cannot narrow from ${from} to ${to} while an external effect's real-world outcome is UNKNOWN - ` +
          `narrowing away local-worker eligibility while an in-flight effect cannot yet be verified is unsafe`,
      );
    }
    return {
      from,
      to,
      direction: "NARROWING",
      safetyCheckScope: "CHECKED_SUPPLIED_FACTS_ONLY",
      disclosure:
        `Moving from ${from} to ${to} removes local workers from routing eligibility going forward. ` +
        `This is NOT an authoritative safe-switch preflight: it only checked the ${activeLeases.length} lease(s) ` +
        `and ${externalEffectStates.length} external-effect state(s) actually supplied to this call (none were ` +
        `active/unterminated and none were UNKNOWN), because this repository has no durable lease/effect store ` +
        `this module can query for the complete active set. A caller that omits real active leases or effect ` +
        `states bypasses this check entirely - real, authoritative safe-switch preflight enforcement remains an ` +
        `explicitly open gap, not a guarantee this plan makes. ${collaborationDisclosure}`,
    };
  }
  return {
    from,
    to,
    direction: "LATERAL",
    safetyCheckScope: "NOT_APPLICABLE",
    disclosure:
      `Moving from ${from} to ${to} does not change which local workers are eligible ` +
      `(resolveEligibleLocalWorkers treats both identically); whether normal remote/API workers are also ` +
      `concatenated into the candidate pool is a caller-side decision this module does not observe or govern. ${collaborationDisclosure}`,
  };
}

// ---------------------------------------------------------------------------
// Device/worker health read-model ("capability/health telemetry"), §18's own
// named fields: "Device ONLINE/OFFLINE/REVOKED/QUARANTINED", "Worker
// AVAILABLE/AUTH_REQUIRED/DEGRADED/USAGE_LIMITED/POLICY_BLOCKED", "last
// heartbeat/capability refresh". Deliberately does not collapse these into
// one fabricated composite status - each dimension is surfaced as its own
// real, caller-supplied value, exactly like `observability-telemetry.ts`'s
// own read-model never invents a value the caller did not supply.
// ---------------------------------------------------------------------------

export type LocalDeviceHeartbeatFreshness = "FRESH" | "STALE";

/**
 * Computed, never stored, always relative to a caller-supplied `asOf` -
 * this module never reads the system clock, mirroring
 * `observability-telemetry.ts`'s own `resolveMetricFreshness` discipline
 * exactly (this repository has no `lastSeenAt`/heartbeat field on
 * `DeviceRegistration` itself - L0 is read-only/unmodified - so a heartbeat
 * timestamp is always caller-supplied here, never read off the device).
 */
export function resolveLocalDeviceHeartbeatFreshness(input: {
  lastHeartbeatAt: unknown;
  asOf: unknown;
  maxAgeMs: unknown;
}): LocalDeviceHeartbeatFreshness {
  const lastHeartbeatAt = requireValidTimestamp(input.lastHeartbeatAt, "lastHeartbeatAt");
  const asOf = requireValidTimestamp(input.asOf, "asOf");
  if (typeof input.maxAgeMs !== "number" || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    throw new InvalidLocalExecutionHardeningError("maxAgeMs must be a positive finite number");
  }
  if (asOf.ms < lastHeartbeatAt.ms) {
    throw new InvalidLocalExecutionHardeningError("asOf must not be before lastHeartbeatAt");
  }
  return asOf.ms - lastHeartbeatAt.ms <= input.maxAgeMs ? "FRESH" : "STALE";
}

export interface LocalWorkerHealthProjection {
  readonly deviceId: DeviceRegistration["deviceId"];
  readonly workerId: LocalWorkerRegistration["workerId"];
  readonly deviceStatus: DeviceRegistration["status"];
  readonly workerAvailability: LocalWorkerRegistration["availability"];
  readonly capabilityReadiness?: DeviceCapabilityReadiness;
  readonly latestSnapshotCapturedAt?: string;
  readonly heartbeatFreshness?: LocalDeviceHeartbeatFreshness;
  readonly lastHeartbeatAt?: string;
}

/**
 * Fails closed on any structural cross-reference mismatch (the worker/
 * snapshot must actually belong to the given device/tenant), exactly like
 * `observability-telemetry.ts`'s own `projectMetricReadModel`. A caller
 * that supplies no `latestSnapshot` or no `lastHeartbeatAt` gets a
 * projection that honestly omits those fields rather than fabricating
 * `AVAILABLE`/`FRESH` - the absence of data is never silently rendered as a
 * positive result.
 */
export function projectLocalWorkerHealth(input: {
  device: DeviceRegistration;
  worker: LocalWorkerRegistration;
  latestSnapshot?: DeviceCapabilitySnapshot;
  lastHeartbeatAt?: unknown;
  asOf?: unknown;
  maxAgeMs?: unknown;
}): LocalWorkerHealthProjection {
  if (input.worker.deviceId !== input.device.deviceId) {
    throw new InvalidLocalExecutionHardeningError("worker.deviceId does not match the given device's own deviceId");
  }
  if (input.worker.tenantId !== input.device.tenantId) {
    throw new InvalidLocalExecutionHardeningError("worker.tenantId does not match the given device's own tenantId");
  }
  if (input.latestSnapshot !== undefined && input.latestSnapshot.deviceId !== input.device.deviceId) {
    throw new InvalidLocalExecutionHardeningError(
      "latestSnapshot.deviceId does not match the given device's own deviceId",
    );
  }

  const base: LocalWorkerHealthProjection = {
    deviceId: input.device.deviceId,
    workerId: input.worker.workerId,
    deviceStatus: input.device.status,
    workerAvailability: input.worker.availability,
  };
  const withSnapshot: Partial<LocalWorkerHealthProjection> =
    input.latestSnapshot !== undefined
      ? { capabilityReadiness: input.latestSnapshot.readiness, latestSnapshotCapturedAt: input.latestSnapshot.capturedAt }
      : {};

  if (input.lastHeartbeatAt === undefined) {
    return { ...base, ...withSnapshot };
  }
  const heartbeatFreshness = resolveLocalDeviceHeartbeatFreshness({
    lastHeartbeatAt: input.lastHeartbeatAt,
    asOf: input.asOf,
    maxAgeMs: input.maxAgeMs,
  });
  return {
    ...base,
    ...withSnapshot,
    heartbeatFreshness,
    lastHeartbeatAt: requireValidTimestamp(input.lastHeartbeatAt, "lastHeartbeatAt").raw,
  };
}
