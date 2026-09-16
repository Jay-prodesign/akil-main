import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as DeliveryRecipePlanBinding from "../src/domain/delivery-recipe-plan-binding.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AI_004A_FILE = "src/domain/delivery-recipe-plan-binding.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

test("AI-004A: delivery-recipe-plan-binding.ts contains no secret material", () => {
  const content = readFileSync(join(REPO_ROOT, AI_004A_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("AI-004A: delivery-recipe-plan-binding.ts imports only sibling domain type declarations - no filesystem/network/execution coupling", () => {
  const content = readFileSync(join(REPO_ROOT, AI_004A_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { ProjectPlanVersion } from "./project-plan.js";',
    'import type { ServiceCatalogAdmission } from "./service-catalog-admission.js";',
    'import type { DeliveryRecipe } from "./delivery-recipe.js";',
    'import { deriveOutcomeJobSpecs, type OutcomeJobSpec } from "./outcome-job-spec.js";',
  ]);
});

test("AI-004A: never calls Date.now() or fetch - every field is caller-supplied, no live ingestion", () => {
  const content = readFileSync(join(REPO_ROOT, AI_004A_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("AI-004A: never invokes plan compilation, catalog admission, job wiring, or job execution - it only composes their already-produced outputs (the sole exception is deriveOutcomeJobSpecs, imported to authenticate caller-supplied specs against the canonical derived set, never to widen execution authority)", () => {
  const content = readFileSync(join(REPO_ROOT, AI_004A_FILE), "utf8");
  const forbiddenCalls = [
    "compilePlan(",
    "admitServiceCatalogEntry(",
    "revokeServiceCatalogAdmission(",
    "wireAdmittedOutcomeJobs(",
    "createOutcomeJob(",
    "verifyOutcomeJob(",
  ];
  const violations = forbiddenCalls.filter((call) => content.includes(call));
  assert.deepEqual(violations, []);
  assert.match(content, /deriveOutcomeJobSpecs\(plan\)/);
});

test("AI-004A: no execution/dispatch/approval mutation surface anywhere in the module - a binding is provenance only", () => {
  const content = readFileSync(join(REPO_ROOT, AI_004A_FILE), "utf8");
  assert.doesNotMatch(content, /\b(execute|dispatch|approve|resume)[A-Za-z]*\s*\(/i);
});

test("AI-004A: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(DeliveryRecipePlanBinding).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidDeliveryRecipePlanBindingError",
    "bindAdmittedRecipeToPlan",
  ]);
});

test("AI-004A: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
