import type { TenantScope } from "./tenant-scope.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type {
  ExecutionMode,
  ExecutionPolicy,
  DeviceRegistration,
  DeviceCapabilitySnapshot,
  DeviceCapabilityReadiness,
  LocalWorkerRegistration,
} from "./local-execution.js";
import { resolveEligibleLocalWorkers } from "./local-execution.js";
import type { AdmittedWorker } from "./worker-routing-policy.js";

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
 * ExecutionMode transition preflight, and a device/worker health
 * read-model - composing L0's (`local-execution.ts`) unmodified
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
 * ExecutionMode preflight and health read-model below are this checkpoint's
 * honest, wireable substitute for that UI's own required data.
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
}

/** A kill switch is always born disengaged - no caller can construct an already-engaged one. */
export function createLocalExecutionKillSwitch(tenantScope: TenantScope): LocalExecutionKillSwitch {
  return { tenantId: tenantScope.tenantId, engaged: false };
}

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

export function disengageLocalExecutionKillSwitch(
  killSwitch: LocalExecutionKillSwitch,
): LocalExecutionKillSwitch {
  if (!killSwitch.engaged) {
    throw new InvalidKillSwitchTransitionError("kill switch is already disengaged");
  }
  return { tenantId: killSwitch.tenantId, engaged: false };
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
// ExecutionMode transition preflight ("safe switch/migration preflight"),
// mirroring `local-execution-collaboration.ts`'s own
// `planCollaborationModeTransition` shape for the CollaborationMode
// dimension. §3: "Local Mode must never automatically enable Team Pool or
// Shared Repo" - this preflight's own return type carries no
// `collaborationMode` field at all, so it cannot alter that dimension even
// by construction.
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

export type ExecutionModeTransitionDirection = "WIDENING" | "NARROWING" | "LATERAL" | "UNCHANGED";

export interface ExecutionModeTransitionPlan {
  readonly from: ExecutionMode;
  readonly to: ExecutionMode;
  readonly direction: ExecutionModeTransitionDirection;
  readonly disclosure: string;
}

export function planExecutionModeTransition(input: {
  from: unknown;
  to: unknown;
}): ExecutionModeTransitionPlan {
  const fromRank = EXECUTION_MODE_RANK[input.from as ExecutionMode];
  const toRank = EXECUTION_MODE_RANK[input.to as ExecutionMode];
  if (fromRank === undefined || toRank === undefined) {
    throw new InvalidExecutionModeTransitionError("from/to must both be recognized ExecutionMode values");
  }
  const from = input.from as ExecutionMode;
  const to = input.to as ExecutionMode;
  const collaborationDisclosure =
    "CollaborationMode is a fully independent dimension and is never altered by this transition.";

  if (from === to) {
    return { from, to, direction: "UNCHANGED", disclosure: `${from} to ${to} is not a mode change.` };
  }
  if (toRank > fromRank) {
    return {
      from,
      to,
      direction: "WIDENING",
      disclosure:
        `Moving from ${from} to ${to} newly admits local workers into routing eligibility ` +
        `(per resolveEligibleLocalWorkers's own pool/ownership gate). ${collaborationDisclosure}`,
    };
  }
  if (toRank < fromRank) {
    return {
      from,
      to,
      direction: "NARROWING",
      disclosure:
        `Moving from ${from} to ${to} removes local workers from routing eligibility going forward; ` +
        `any task already leased to a local worker is unaffected by this preflight alone. ${collaborationDisclosure}`,
    };
  }
  return {
    from,
    to,
    direction: "LATERAL",
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
