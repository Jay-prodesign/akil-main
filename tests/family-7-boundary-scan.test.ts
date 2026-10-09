import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as CrossSurfaceEvidence from "../src/domain/cross-surface-evidence-convergence.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/cross-surface-evidence-convergence.ts";

test("Family 7: cross-surface-evidence-convergence.ts imports only type-only references to the four source surfaces - never re-derives their logic", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  for (const line of importLines) {
    assert.match(line, /^import type /, `expected a type-only import, got: ${line}`);
  }
});

test("Family 7: never calls fetch, a node: builtin, or the system clock - pure aggregation/projection only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)/);
});

test("Family 7: does not redefine CustomerEvidenceItem, ReconciledInsight, ExternalEffectAttempt, or MetricReadModel", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+CustomerEvidenceItem\b/);
  assert.doesNotMatch(content, /interface\s+ReconciledInsight\b/);
  assert.doesNotMatch(content, /interface\s+ExternalEffectAttempt\b/);
  assert.doesNotMatch(content, /interface\s+MetricReadModel\b/);
});

test("Family 7 (customer-safe projection, structural): CustomerSafeEvidenceSummary's own interface declaration has no sourceRef/originalStatus field", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const match = content.match(/export interface CustomerSafeEvidenceSummary \{[\s\S]*?\n\}/);
  assert.ok(match, "CustomerSafeEvidenceSummary interface not found");
  assert.doesNotMatch(match![0], /sourceRef/);
  assert.doesNotMatch(match![0], /originalStatus/);
});

test("Family 7: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(CrossSurfaceEvidence).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidCrossSurfaceEvidenceError",
    "buildConvergedEvidenceSnapshot",
    "convergeCustomerEvidenceItem",
    "convergeExternalEffectAttempt",
    "convergeIntelligenceInsight",
    "convergeMetricReadModel",
    "projectCustomerSafeEvidenceSummary",
  ]);
});

test("Family 7: package.json still declares no new runtime dependency", () => {
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
