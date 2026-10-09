import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ExecutionEconomicsAttribution from "../src/domain/execution-economics-attribution.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MET_001A_FILE = "src/domain/execution-economics-attribution.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

const PROVIDER_MODEL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "vendor-name-openai", pattern: /openai/i },
  { label: "vendor-name-anthropic-model", pattern: /claude-\d/i },
  { label: "vendor-name-stripe", pattern: /stripe/i },
  { label: "vendor-name-aws", pattern: /\baws\b/i },
];

test("MET-001A: execution-economics-attribution.ts contains no secret material or hard-coded provider/model coupling", () => {
  const content = readFileSync(join(REPO_ROOT, MET_001A_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("MET-001A: execution-economics-attribution.ts imports only sibling domain modules - no filesystem/network/provider coupling", () => {
  const content = readFileSync(join(REPO_ROOT, MET_001A_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, ['import type { TenantScope } from "./tenant-scope.js";']);
});

test("MET-001A: never calls Date.now() or fetch - every timestamp/event is caller-supplied, no live provider ingestion", () => {
  const content = readFileSync(join(REPO_ROOT, MET_001A_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("MET-001A: no billing/payment/invoice/charge mutation surface anywhere in the module", () => {
  const content = readFileSync(join(REPO_ROOT, MET_001A_FILE), "utf8");
  assert.doesNotMatch(content, /\b(charge|invoice|payment|refund)[A-Za-z]*\s*\(/i);
});

test("MET-001A: resolveTotalDeliveryCost never sums an UNKNOWN-presence amount into a number", () => {
  const content = readFileSync(join(REPO_ROOT, MET_001A_FILE), "utf8");
  const fnStart = content.indexOf("function rollUpCostAmounts");
  assert.notEqual(fnStart, -1);
  const fnBody = content.slice(fnStart, fnStart + 800);
  assert.match(fnBody, /presence === "UNKNOWN"/);
  assert.match(fnBody, /INCOMPLETE/);
});

test("MET-001A: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(ExecutionEconomicsAttribution).sort();
  assert.deepEqual(exportedKeys, [
    "DuplicateIdempotencyKeyConflictError",
    "EMPTY_EXECUTION_ECONOMICS_LEDGER",
    "InvalidExecutionEconomicsError",
    "appendExecutionEconomicsEvent",
    "createCostAmount",
    "createExecutionEconomicsLineage",
    "isRecognizedUsageSource",
    "recordExecutionEconomicsEvent",
    "resolveCohortComparability",
    "resolveCostBucketTotal",
    "resolveTotalDeliveryCost",
    "selectExecutionEconomicsEvents",
  ]);
});

test("MET-001A: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
