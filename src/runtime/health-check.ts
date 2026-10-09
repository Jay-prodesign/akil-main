export type HealthCheckStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";

/**
 * A single probe's raw result. `critical: false` marks a probe whose
 * failure should degrade, not fail, overall health - e.g. an optional
 * downstream integration a Worker can still serve read traffic without.
 */
export interface HealthProbeResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly critical: boolean;
  readonly detail?: string;
}

export interface HealthCheckResult {
  readonly status: HealthCheckStatus;
  readonly probes: ReadonlyArray<HealthProbeResult>;
}

/**
 * Pure aggregation, no I/O of its own - every probe's result must already
 * be known before calling this. UNHEALTHY if any critical probe failed;
 * DEGRADED if only non-critical probes failed; HEALTHY only if every
 * probe passed, including the zero-probe case (a runtime with nothing to
 * check is trivially healthy, not vacuously unhealthy).
 */
export function evaluateHealth(probes: ReadonlyArray<HealthProbeResult>): HealthCheckResult {
  const failedCritical = probes.some((probe) => !probe.healthy && probe.critical);
  const failedNonCritical = probes.some((probe) => !probe.healthy && !probe.critical);

  const status: HealthCheckStatus = failedCritical ? "UNHEALTHY" : failedNonCritical ? "DEGRADED" : "HEALTHY";

  return { status, probes };
}
