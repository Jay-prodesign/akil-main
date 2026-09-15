import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createMetricDefinition,
  createMetricWindow,
  recordMetricObservation,
  resolveMetricFreshness,
  createMetricMonitoringRegistration,
  pauseMetricMonitoring,
  resumeMetricMonitoring,
  stopMetricMonitoring,
  projectMetricReadModel,
  InvalidTelemetryError,
  InvalidMonitoringTransitionError,
} from "../src/domain/observability-telemetry.js";

const tenantScope = createTenantScope("tenant-obs-1");
const otherTenantScope = createTenantScope("tenant-obs-other");

function definition(seed = "1") {
  return createMetricDefinition({
    tenantScope,
    metricRef: `metric-${seed}`,
    unit: "COUNT",
    displayLabel: `Metric ${seed}`,
  });
}

function window() {
  return createMetricWindow({ windowStart: "2026-09-01T00:00:00.000Z", windowEnd: "2026-09-02T00:00:00.000Z" });
}

// --- MetricDefinition / MetricWindow ---

test("T1: createMetricDefinition accepts a recognized unit", () => {
  const def = createMetricDefinition({ tenantScope, metricRef: "metric-x", unit: "PERCENTAGE", displayLabel: "X" });
  assert.equal(def.unit, "PERCENTAGE");
});

test("T2: createMetricDefinition rejects an unrecognized unit", () => {
  assert.throws(
    () => createMetricDefinition({ tenantScope, metricRef: "metric-x", unit: "FURLONGS", displayLabel: "X" }),
    InvalidTelemetryError,
  );
});

test("T3: createMetricWindow rejects a windowEnd not strictly after windowStart", () => {
  assert.throws(
    () => createMetricWindow({ windowStart: "2026-09-02T00:00:00.000Z", windowEnd: "2026-09-01T00:00:00.000Z" }),
    InvalidTelemetryError,
  );
});

// --- recordMetricObservation: missing-vs-zero ---

test("T4 (missing-vs-zero core invariant): recordMetricObservation accepts a REPORTED value of exactly 0, distinct from MISSING", () => {
  const obs = recordMetricObservation({
    definition: definition(),
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 0,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.equal(obs.presence, "REPORTED");
  assert.equal(obs.value, 0);
});

test("T5: recordMetricObservation rejects REPORTED with no value supplied", () => {
  assert.throws(
    () =>
      recordMetricObservation({
        definition: definition(),
        sourceRef: "source:manual",
        window: window(),
        presence: "REPORTED",
        quality: "VERIFIED",
        capturedAt: "2026-09-01T12:00:00.000Z",
      }),
    InvalidTelemetryError,
  );
});

test("T6 (adversarial contradictory input): recordMetricObservation rejects MISSING with a value also supplied", () => {
  assert.throws(
    () =>
      recordMetricObservation({
        definition: definition(),
        sourceRef: "source:manual",
        window: window(),
        presence: "MISSING",
        value: 5,
        quality: "UNVERIFIED",
        capturedAt: "2026-09-01T12:00:00.000Z",
      }),
    InvalidTelemetryError,
  );
});

test("T7: recordMetricObservation accepts a MISSING observation with no value", () => {
  const obs = recordMetricObservation({
    definition: definition(),
    sourceRef: "source:manual",
    window: window(),
    presence: "MISSING",
    quality: "UNVERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.equal(obs.presence, "MISSING");
  assert.equal(obs.value, undefined);
});

test("T8: recordMetricObservation rejects an unrecognized quality", () => {
  assert.throws(
    () =>
      recordMetricObservation({
        definition: definition(),
        sourceRef: "source:manual",
        window: window(),
        presence: "REPORTED",
        value: 1,
        quality: "SUPER_TRUSTED",
        capturedAt: "2026-09-01T12:00:00.000Z",
      }),
    InvalidTelemetryError,
  );
});

test("T9: recordMetricObservation rejects a non-finite value even when presence is REPORTED", () => {
  assert.throws(
    () =>
      recordMetricObservation({
        definition: definition(),
        sourceRef: "source:manual",
        window: window(),
        presence: "REPORTED",
        value: Number.NaN,
        quality: "VERIFIED",
        capturedAt: "2026-09-01T12:00:00.000Z",
      }),
    InvalidTelemetryError,
  );
});

// --- resolveMetricFreshness ---

test("T10: resolveMetricFreshness returns FRESH when asOf - capturedAt <= maxAgeMs", () => {
  const obs = recordMetricObservation({
    definition: definition(),
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 10,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  const freshness = resolveMetricFreshness({ observation: obs, asOf: "2026-09-01T12:30:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(freshness, "FRESH");
});

test("T11: resolveMetricFreshness returns STALE once the gap exceeds maxAgeMs", () => {
  const obs = recordMetricObservation({
    definition: definition(),
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 10,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  const freshness = resolveMetricFreshness({ observation: obs, asOf: "2026-09-01T14:00:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(freshness, "STALE");
});

test("T12 (adversarial time-travel): resolveMetricFreshness fails closed when asOf is before the observation's own capturedAt", () => {
  const obs = recordMetricObservation({
    definition: definition(),
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 10,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.throws(
    () => resolveMetricFreshness({ observation: obs, asOf: "2026-09-01T11:00:00.000Z", maxAgeMs: 60 * 60 * 1000 }),
    InvalidTelemetryError,
  );
});

test("T13: resolveMetricFreshness rejects a non-positive maxAgeMs", () => {
  const obs = recordMetricObservation({
    definition: definition(),
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 10,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.throws(
    () => resolveMetricFreshness({ observation: obs, asOf: "2026-09-01T12:30:00.000Z", maxAgeMs: 0 }),
    InvalidTelemetryError,
  );
});

// --- Monitoring state transitions ---

test("T14: createMetricMonitoringRegistration always starts MONITORED", () => {
  const reg = createMetricMonitoringRegistration({ definition: definition(), sourceRef: "source:manual" });
  assert.equal(reg.state, "MONITORED");
});

test("T15: pauseMetricMonitoring then resumeMetricMonitoring returns to MONITORED", () => {
  const reg = createMetricMonitoringRegistration({ definition: definition(), sourceRef: "source:manual" });
  const paused = pauseMetricMonitoring(reg);
  assert.equal(paused.state, "MONITORING_PAUSED");
  const resumed = resumeMetricMonitoring(paused);
  assert.equal(resumed.state, "MONITORED");
});

test("T16: stopMetricMonitoring is terminal - a second stop fails closed", () => {
  const reg = createMetricMonitoringRegistration({ definition: definition(), sourceRef: "source:manual" });
  const stopped = stopMetricMonitoring(reg);
  assert.equal(stopped.state, "NOT_MONITORED");
  assert.throws(() => stopMetricMonitoring(stopped), InvalidMonitoringTransitionError);
});

test("T17: resumeMetricMonitoring fails closed on a MONITORED (not paused) registration", () => {
  const reg = createMetricMonitoringRegistration({ definition: definition(), sourceRef: "source:manual" });
  assert.throws(() => resumeMetricMonitoring(reg), InvalidMonitoringTransitionError);
});

test("T18: pauseMetricMonitoring fails closed on an already-stopped registration", () => {
  const reg = createMetricMonitoringRegistration({ definition: definition(), sourceRef: "source:manual" });
  const stopped = stopMetricMonitoring(reg);
  assert.throws(() => pauseMetricMonitoring(stopped), InvalidMonitoringTransitionError);
});

// --- projectMetricReadModel: the core read-model contract ---

test("T19: projectMetricReadModel returns REPORTED_FRESH for a monitored metric with a recent REPORTED observation", () => {
  const def = definition("19");
  const reg = createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" });
  const obs = recordMetricObservation({
    definition: def,
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 42,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  const model = projectMetricReadModel({ definition: def, monitoring: reg, observation: obs, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(model.status, "REPORTED_FRESH");
  assert.equal(model.value, 42);
});

test("T20: projectMetricReadModel returns REPORTED_STALE once the observation ages past maxAgeMs", () => {
  const def = definition("20");
  const reg = createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" });
  const obs = recordMetricObservation({
    definition: def,
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 7,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T00:00:00.000Z",
  });
  const model = projectMetricReadModel({ definition: def, monitoring: reg, observation: obs, asOf: "2026-09-05T00:00:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(model.status, "REPORTED_STALE");
  assert.equal(model.value, 7);
});

test("T21 (missing-vs-zero at the read-model layer): projectMetricReadModel returns MISSING (never a fabricated 0) when no observation exists at all", () => {
  const def = definition("21");
  const reg = createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" });
  const model = projectMetricReadModel({ definition: def, monitoring: reg, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(model.status, "MISSING");
  assert.equal(model.value, undefined);
});

test("T22: projectMetricReadModel returns MISSING when the supplied observation's own presence is MISSING", () => {
  const def = definition("22");
  const reg = createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" });
  const obs = recordMetricObservation({
    definition: def,
    sourceRef: "source:manual",
    window: window(),
    presence: "MISSING",
    quality: "UNVERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  const model = projectMetricReadModel({ definition: def, monitoring: reg, observation: obs, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(model.status, "MISSING");
});

test("T23 (monitored state as a real visibility gate): projectMetricReadModel returns NOT_MONITORED and surfaces no value even when a REPORTED observation exists, once monitoring is paused", () => {
  const def = definition("23");
  const reg = pauseMetricMonitoring(createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" }));
  const obs = recordMetricObservation({
    definition: def,
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 99,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  const model = projectMetricReadModel({ definition: def, monitoring: reg, observation: obs, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(model.status, "NOT_MONITORED");
  assert.equal(model.value, undefined);
});

test("T24: projectMetricReadModel returns NOT_MONITORED once monitoring is stopped", () => {
  const def = definition("24");
  const reg = stopMetricMonitoring(createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" }));
  const model = projectMetricReadModel({ definition: def, monitoring: reg, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 });
  assert.equal(model.status, "NOT_MONITORED");
});

test("T25 (adversarial cross-tenant registration): projectMetricReadModel fails closed when the monitoring registration belongs to a different tenant than the definition", () => {
  const def = definition("25");
  const foreignDef = createMetricDefinition({ tenantScope: otherTenantScope, metricRef: "metric-25", unit: "COUNT", displayLabel: "Foreign" });
  const foreignReg = createMetricMonitoringRegistration({ definition: foreignDef, sourceRef: "source:manual" });
  assert.throws(
    () => projectMetricReadModel({ definition: def, monitoring: foreignReg, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 }),
    InvalidTelemetryError,
  );
});

test("T26 (adversarial cross-metric registration): projectMetricReadModel fails closed when the monitoring registration is for a different metricRef", () => {
  const def = definition("26a");
  const otherDef = definition("26b");
  const otherReg = createMetricMonitoringRegistration({ definition: otherDef, sourceRef: "source:manual" });
  assert.throws(
    () => projectMetricReadModel({ definition: def, monitoring: otherReg, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 }),
    InvalidTelemetryError,
  );
});

test("T27 (adversarial forged observation reference): projectMetricReadModel fails closed when the observation belongs to a different metricRef than the definition", () => {
  const def = definition("27a");
  const otherDef = definition("27b");
  const reg = createMetricMonitoringRegistration({ definition: def, sourceRef: "source:manual" });
  const foreignObs = recordMetricObservation({
    definition: otherDef,
    sourceRef: "source:manual",
    window: window(),
    presence: "REPORTED",
    value: 1,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.throws(
    () => projectMetricReadModel({ definition: def, monitoring: reg, observation: foreignObs, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 }),
    InvalidTelemetryError,
  );
});

test("T28 (adversarial source substitution): projectMetricReadModel fails closed when the observation's sourceRef does not match the monitoring registration's own sourceRef", () => {
  const def = definition("28");
  const reg = createMetricMonitoringRegistration({ definition: def, sourceRef: "source:trusted" });
  const obs = recordMetricObservation({
    definition: def,
    sourceRef: "source:untrusted",
    window: window(),
    presence: "REPORTED",
    value: 1,
    quality: "VERIFIED",
    capturedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.throws(
    () => projectMetricReadModel({ definition: def, monitoring: reg, observation: obs, asOf: "2026-09-01T12:10:00.000Z", maxAgeMs: 60 * 60 * 1000 }),
    InvalidTelemetryError,
  );
});
