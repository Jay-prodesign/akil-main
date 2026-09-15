import type { TenantScope } from "./tenant-scope.js";

export class InvalidTelemetryError extends Error {
  constructor(reason: string) {
    super(`Invalid telemetry operation: ${reason}`);
    this.name = "InvalidTelemetryError";
  }
}

export class InvalidMonitoringTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid monitoring transition: ${reason}`);
    this.name = "InvalidMonitoringTransitionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidTelemetryError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidTelemetryError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * Rev98 gap-audit Family 6 (V4 Workstream prerequisite - "PROVIDER-NEUTRAL
 * OBSERVABILITY / TELEMETRY FLOOR"): *"V5-EVAL-001 explicitly deferred
 * post-adoption monitor because no telemetry/observability system exists,
 * while V4 evidence/outcome and optimization semantics require freshness/
 * comparable evidence. Implement the smallest repo-native telemetry/
 * health/evidence contract and read model needed to represent source,
 * metric definition/unit/window, freshness, quality/confidence, missing-
 * vs-zero and monitored state without fabricating provider data. No
 * vendor monitoring account or live ingestion is required for the dark
 * floor."*
 *
 * This module never calls a real monitoring vendor, never reads the
 * system clock, and never invents a value a caller did not supply - every
 * observation, quality classification, and monitoring state is caller-
 * declared. The one thing this module computes itself is freshness,
 * always relative to a caller-supplied `asOf` (matching this codebase's
 * own `resolvePartnerCapabilityClaimStatus`/`resolveEffectiveStatus`-style
 * "computed, never stored, clock-free" discipline).
 */
export type MetricUnit = "COUNT" | "CURRENCY_MINOR_UNITS" | "PERCENTAGE" | "DURATION_MS" | "RATIO" | "BYTES";

const RECOGNIZED_METRIC_UNITS: ReadonlySet<MetricUnit> = new Set([
  "COUNT",
  "CURRENCY_MINOR_UNITS",
  "PERCENTAGE",
  "DURATION_MS",
  "RATIO",
  "BYTES",
]);

/**
 * "Incomparable-metric separation" (V4 Workstream E's own phrasing for
 * this same concern): a `MetricDefinition` binds a `metricRef` to exactly
 * one `unit` for the life of that definition - two observations for the
 * same `metricRef` are only ever comparable if they share the same
 * definition, never merely the same string ref.
 */
export interface MetricDefinition {
  readonly tenantId: TenantScope["tenantId"];
  readonly metricRef: string;
  readonly unit: MetricUnit;
  readonly displayLabel: string;
}

export function createMetricDefinition(input: {
  tenantScope: TenantScope;
  metricRef: unknown;
  unit: unknown;
  displayLabel: unknown;
}): MetricDefinition {
  const metricRef = requireNonEmptyString(input.metricRef, "metricRef");
  if (!RECOGNIZED_METRIC_UNITS.has(input.unit as MetricUnit)) {
    throw new InvalidTelemetryError(`unit must be one of ${Array.from(RECOGNIZED_METRIC_UNITS).join(", ")}`);
  }
  const displayLabel = requireNonEmptyString(input.displayLabel, "displayLabel");
  return {
    tenantId: input.tenantScope.tenantId,
    metricRef,
    unit: input.unit as MetricUnit,
    displayLabel,
  };
}

/**
 * "Metric definition/unit/window": a `MetricWindow` is the reporting
 * period an observation covers - required so a caller can never compare
 * a daily figure against a monthly one without noticing.
 */
export interface MetricWindow {
  readonly windowStart: string;
  readonly windowEnd: string;
}

export function createMetricWindow(input: { windowStart: unknown; windowEnd: unknown }): MetricWindow {
  const windowStart = requireValidTimestamp(input.windowStart, "windowStart");
  const windowEnd = requireValidTimestamp(input.windowEnd, "windowEnd");
  if (windowEnd.ms <= windowStart.ms) {
    throw new InvalidTelemetryError("windowEnd must be strictly after windowStart");
  }
  return { windowStart: windowStart.raw, windowEnd: windowEnd.raw };
}

/**
 * "Quality/confidence": always caller-declared, never inferred by this
 * module - a module that could infer confidence would itself be
 * fabricating provider data, which the packet explicitly forbids.
 */
export type MetricQuality = "VERIFIED" | "ESTIMATED" | "UNVERIFIED" | "DEGRADED";

const RECOGNIZED_METRIC_QUALITIES: ReadonlySet<MetricQuality> = new Set([
  "VERIFIED",
  "ESTIMATED",
  "UNVERIFIED",
  "DEGRADED",
]);

/**
 * "Missing-vs-zero": the central invariant this floor exists to enforce
 * (repeated verbatim in the Rev98 handoff for both this family and V4
 * Workstream E). `presence` is the discriminator - a `MISSING`
 * observation can never carry a `value`, and a `REPORTED` observation
 * must carry one (`0` is a completely valid, distinct `REPORTED` value,
 * never conflated with "nothing was reported").
 */
export type MetricValuePresence = "REPORTED" | "MISSING";

export interface MetricObservation {
  readonly tenantId: TenantScope["tenantId"];
  readonly metricRef: string;
  readonly sourceRef: string;
  readonly window: MetricWindow;
  readonly presence: MetricValuePresence;
  readonly value?: number;
  readonly quality: MetricQuality;
  readonly capturedAt: string;
  readonly evidenceRef?: string;
}

/**
 * "Source": `sourceRef` is an opaque pointer to wherever this observation
 * actually came from (a connector, a manual entry, an internal
 * computation) - this module never interprets it, only carries and
 * compares it for identity, exactly matching this codebase's established
 * "opaque ref" discipline for every other external pointer.
 */
export function recordMetricObservation(input: {
  definition: MetricDefinition;
  sourceRef: unknown;
  window: MetricWindow;
  presence: unknown;
  value?: unknown;
  quality: unknown;
  capturedAt: unknown;
  evidenceRef?: unknown;
}): MetricObservation {
  const sourceRef = requireNonEmptyString(input.sourceRef, "sourceRef");
  if (input.presence !== "REPORTED" && input.presence !== "MISSING") {
    throw new InvalidTelemetryError('presence must be "REPORTED" or "MISSING"');
  }
  if (input.presence === "REPORTED") {
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      throw new InvalidTelemetryError("value must be a finite number when presence is REPORTED");
    }
  } else if (input.value !== undefined) {
    throw new InvalidTelemetryError("value must not be supplied when presence is MISSING");
  }
  if (!RECOGNIZED_METRIC_QUALITIES.has(input.quality as MetricQuality)) {
    throw new InvalidTelemetryError(`quality must be one of ${Array.from(RECOGNIZED_METRIC_QUALITIES).join(", ")}`);
  }
  const capturedAt = requireValidTimestamp(input.capturedAt, "capturedAt");
  const observation: {
    tenantId: TenantScope["tenantId"];
    metricRef: string;
    sourceRef: string;
    window: MetricWindow;
    presence: MetricValuePresence;
    value?: number;
    quality: MetricQuality;
    capturedAt: string;
    evidenceRef?: string;
  } = {
    tenantId: input.definition.tenantId,
    metricRef: input.definition.metricRef,
    sourceRef,
    window: input.window,
    presence: input.presence,
    quality: input.quality as MetricQuality,
    capturedAt: capturedAt.raw,
  };
  if (input.presence === "REPORTED") {
    observation.value = input.value as number;
  }
  if (input.evidenceRef !== undefined) {
    observation.evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  }
  return observation;
}

/**
 * "Freshness": computed, never stored, always relative to the caller-
 * supplied `asOf` - this module never reads the system clock. Fails
 * closed on an `asOf` strictly before the observation's own `capturedAt`
 * (an observation cannot be evaluated for freshness at a point in time
 * before it existed) or a non-positive `maxAgeMs`.
 */
export type MetricFreshness = "FRESH" | "STALE";

export function resolveMetricFreshness(input: {
  observation: MetricObservation;
  asOf: unknown;
  maxAgeMs: unknown;
}): MetricFreshness {
  const asOf = requireValidTimestamp(input.asOf, "asOf");
  if (typeof input.maxAgeMs !== "number" || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    throw new InvalidTelemetryError("maxAgeMs must be a positive finite number");
  }
  const capturedAtMs = Date.parse(input.observation.capturedAt);
  if (asOf.ms < capturedAtMs) {
    throw new InvalidTelemetryError("asOf must not be before the observation's own capturedAt");
  }
  return asOf.ms - capturedAtMs <= input.maxAgeMs ? "FRESH" : "STALE";
}

/**
 * "Monitored state": whether a metric/source pair is even actively being
 * watched right now is itself governed state, distinct from any
 * individual observation - a caller must never infer "monitored" merely
 * from the presence of a past observation, and a paused/stopped
 * registration gates visibility in `projectMetricReadModel` below even if
 * observations keep arriving. `NOT_MONITORED` is terminal for a given
 * registration (mirroring this codebase's own closed-transition-graph
 * discipline) - a genuinely resumed metric requires a fresh registration.
 */
export type MonitoringState = "MONITORED" | "MONITORING_PAUSED" | "NOT_MONITORED";

export interface MetricMonitoringRegistration {
  readonly tenantId: TenantScope["tenantId"];
  readonly metricRef: string;
  readonly sourceRef: string;
  readonly state: MonitoringState;
}

/**
 * A registration always starts `MONITORED` - this is the only
 * construction function in this module, mirroring this codebase's own
 * "never born in a downstream state" discipline.
 */
export function createMetricMonitoringRegistration(input: {
  definition: MetricDefinition;
  sourceRef: unknown;
}): MetricMonitoringRegistration {
  return {
    tenantId: input.definition.tenantId,
    metricRef: input.definition.metricRef,
    sourceRef: requireNonEmptyString(input.sourceRef, "sourceRef"),
    state: "MONITORED",
  };
}

export function pauseMetricMonitoring(registration: MetricMonitoringRegistration): MetricMonitoringRegistration {
  if (registration.state !== "MONITORED") {
    throw new InvalidMonitoringTransitionError(
      `only a MONITORED registration can be paused (current state: ${registration.state})`,
    );
  }
  return { ...registration, state: "MONITORING_PAUSED" };
}

export function resumeMetricMonitoring(registration: MetricMonitoringRegistration): MetricMonitoringRegistration {
  if (registration.state !== "MONITORING_PAUSED") {
    throw new InvalidMonitoringTransitionError(
      `only a MONITORING_PAUSED registration can be resumed (current state: ${registration.state})`,
    );
  }
  return { ...registration, state: "MONITORED" };
}

/** §"revoked/stopped fails closed and is terminal" - mirrors every other closed-status graph in this codebase. */
export function stopMetricMonitoring(registration: MetricMonitoringRegistration): MetricMonitoringRegistration {
  if (registration.state === "NOT_MONITORED") {
    throw new InvalidMonitoringTransitionError("registration is already NOT_MONITORED (terminal)");
  }
  return { ...registration, state: "NOT_MONITORED" };
}

/**
 * The read-model projection this floor exists to provide: combines
 * monitoring state, an optional observation, and computed freshness into
 * one customer/ops-safe view, without ever fabricating a value the
 * caller did not supply.
 *
 * - `NOT_MONITORED`: the registration is not currently `MONITORED` (paused
 *   or stopped) - no value/quality/window/capturedAt is ever surfaced,
 *   even if an observation object was supplied, since a caller must never
 *   be shown telemetry for a metric that isn't actually being watched
 *   right now.
 * - `MISSING`: the registration is `MONITORED` but no observation exists,
 *   or the supplied observation's own `presence` is `MISSING` - this is
 *   always its own explicit, first-class status, never silently rendered
 *   as (or confused with) a reported `0`.
 * - `REPORTED_FRESH` / `REPORTED_STALE`: the registration is `MONITORED`
 *   and a `REPORTED` observation exists; `resolveMetricFreshness` (never
 *   this function itself) determines which.
 *
 * Fails closed on any structural cross-reference mismatch: the
 * definition/registration/observation must all agree on `tenantId` and
 * `metricRef`, and a supplied observation's `sourceRef` must match the
 * registration's own - a forged observation for a different metric,
 * tenant, or source is never silently blended into the projection.
 */
export type MetricReadModelStatus = "REPORTED_FRESH" | "REPORTED_STALE" | "MISSING" | "NOT_MONITORED";

export interface MetricReadModel {
  readonly tenantId: TenantScope["tenantId"];
  readonly metricRef: string;
  readonly sourceRef: string;
  readonly unit: MetricUnit;
  readonly status: MetricReadModelStatus;
  readonly value?: number;
  readonly quality?: MetricQuality;
  readonly window?: MetricWindow;
  readonly capturedAt?: string;
}

export function projectMetricReadModel(input: {
  definition: MetricDefinition;
  monitoring: MetricMonitoringRegistration;
  observation?: MetricObservation;
  asOf: unknown;
  maxAgeMs: unknown;
}): MetricReadModel {
  if (input.monitoring.tenantId !== input.definition.tenantId) {
    throw new InvalidTelemetryError("monitoring registration belongs to a different tenant than the definition");
  }
  if (input.monitoring.metricRef !== input.definition.metricRef) {
    throw new InvalidTelemetryError("monitoring registration does not belong to the given metric definition");
  }
  if (input.observation !== undefined) {
    if (input.observation.tenantId !== input.definition.tenantId) {
      throw new InvalidTelemetryError("observation belongs to a different tenant than the definition");
    }
    if (input.observation.metricRef !== input.definition.metricRef) {
      throw new InvalidTelemetryError("observation does not belong to the given metric definition");
    }
    if (input.observation.sourceRef !== input.monitoring.sourceRef) {
      throw new InvalidTelemetryError("observation's sourceRef does not match the monitoring registration's own sourceRef");
    }
  }

  const base = {
    tenantId: input.definition.tenantId,
    metricRef: input.definition.metricRef,
    sourceRef: input.monitoring.sourceRef,
    unit: input.definition.unit,
  };

  if (input.monitoring.state !== "MONITORED") {
    return { ...base, status: "NOT_MONITORED" };
  }
  if (input.observation === undefined || input.observation.presence === "MISSING") {
    return { ...base, status: "MISSING" };
  }
  const freshness = resolveMetricFreshness({ observation: input.observation, asOf: input.asOf, maxAgeMs: input.maxAgeMs });
  return {
    ...base,
    status: freshness === "FRESH" ? "REPORTED_FRESH" : "REPORTED_STALE",
    value: input.observation.value as number,
    quality: input.observation.quality,
    window: input.observation.window,
    capturedAt: input.observation.capturedAt,
  };
}
