import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth } from "../src/runtime/health-check.js";

test("H1: zero probes is trivially HEALTHY, not vacuously unhealthy", () => {
  const result = evaluateHealth([]);
  assert.equal(result.status, "HEALTHY");
  assert.deepEqual(result.probes, []);
});

test("H2: all probes healthy yields HEALTHY", () => {
  const result = evaluateHealth([
    { name: "a", healthy: true, critical: true },
    { name: "b", healthy: true, critical: false },
  ]);
  assert.equal(result.status, "HEALTHY");
});

test("H3: a failed critical probe yields UNHEALTHY even if others pass", () => {
  const result = evaluateHealth([
    { name: "a", healthy: true, critical: false },
    { name: "b", healthy: false, critical: true },
  ]);
  assert.equal(result.status, "UNHEALTHY");
});

test("H4: a failed non-critical probe alone yields DEGRADED, not UNHEALTHY", () => {
  const result = evaluateHealth([
    { name: "a", healthy: true, critical: true },
    { name: "b", healthy: false, critical: false },
  ]);
  assert.equal(result.status, "DEGRADED");
});

test("H5: a failed critical probe outranks a simultaneously failed non-critical one", () => {
  const result = evaluateHealth([
    { name: "a", healthy: false, critical: true },
    { name: "b", healthy: false, critical: false },
  ]);
  assert.equal(result.status, "UNHEALTHY");
});

test("H6: probes are preserved verbatim on the result for caller inspection", () => {
  const probes = [{ name: "a", healthy: false, critical: false, detail: "timed out" }];
  const result = evaluateHealth(probes);
  assert.deepEqual(result.probes, probes);
});
