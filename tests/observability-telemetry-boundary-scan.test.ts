import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ObservabilityTelemetry from "../src/domain/observability-telemetry.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBS_TEL_FILE = "src/domain/observability-telemetry.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

const PROVIDER_MODEL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "vendor-name-shopify", pattern: /shopify/i },
  { label: "vendor-name-datadog", pattern: /datadog/i },
  { label: "vendor-name-grafana", pattern: /grafana/i },
  { label: "vendor-name-newrelic", pattern: /new[_-]?relic/i },
];

test("OBS-TEL-001: observability-telemetry.ts contains no secret material or hard-coded vendor coupling", () => {
  const content = readFileSync(join(REPO_ROOT, OBS_TEL_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("OBS-TEL-001: observability-telemetry.ts imports only sibling domain modules - no filesystem, network, or vendor SDK coupling", () => {
  const content = readFileSync(join(REPO_ROOT, OBS_TEL_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, ['import type { TenantScope } from "./tenant-scope.js";']);
});

test("OBS-TEL-001: never calls Date.now() or fetch - every timestamp/observation is caller-supplied, no live ingestion", () => {
  const content = readFileSync(join(REPO_ROOT, OBS_TEL_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("OBS-TEL-001: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(ObservabilityTelemetry).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidMonitoringTransitionError",
    "InvalidTelemetryError",
    "createMetricDefinition",
    "createMetricMonitoringRegistration",
    "createMetricWindow",
    "pauseMetricMonitoring",
    "projectMetricReadModel",
    "recordMetricObservation",
    "resolveMetricFreshness",
    "resumeMetricMonitoring",
    "stopMetricMonitoring",
  ]);
});

test("OBS-TEL-001: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@types/node", "typescript"],
  );
});
