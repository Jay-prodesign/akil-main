import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OperationalOptimizationLoop from "../src/domain/operational-optimization-loop.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/operational-optimization-loop.ts";

test("Family 8: only worker-routing-policy.ts and observability-telemetry.ts are imported, and only as types", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.equal(importLines.length, 2, `expected exactly 2 import lines, got: ${importLines.join(" | ")}`);
  for (const line of importLines) {
    assert.match(line, /^import type /, `expected a type-only import, got: ${line}`);
  }
  assert.match(importLines[0]!, /worker-routing-policy\.js/);
  assert.match(importLines[1]!, /observability-telemetry\.js/);
});

test("Family 8: never calls fetch, a node: builtin, or the system clock - pure decision function only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)|new Date\(/);
});

test("Family 8: does not redefine WorkerRiskLevel or MetricReadModel", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /export type WorkerRiskLevel\b/);
  assert.doesNotMatch(content, /interface\s+MetricReadModel\b/);
});

test("Family 8: no free-text reason field on OptimizationEvaluation - escalation/stop reasons are closed enums only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const match = content.match(/export interface OptimizationEvaluation \{[\s\S]*?\n\}/);
  assert.ok(match, "OptimizationEvaluation interface not found");
  assert.doesNotMatch(match![0], /reason\??:\s*string/i);
});

test("Family 8: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(OperationalOptimizationLoop).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidOptimizationCandidateActionError",
    "InvalidOptimizationPolicyError",
    "createOptimizationCandidateAction",
    "createOptimizationPolicy",
    "evaluateOptimizationCandidate",
  ]);
});

test("Family 8: package.json still declares no new runtime dependency", () => {
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
