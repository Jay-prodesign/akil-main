import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/del-003-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEL_003_FILES = [
  "src/domain/offer-blueprint.ts",
  "src/domain/sold-scope.ts",
  "src/domain/customer-evidence.ts",
  "src/domain/project-plan.ts",
  "src/domain/project-plan-validation.ts",
  "src/domain/project-plan-diff.ts",
  "src/domain/outcome-job-spec.ts",
  "src/domain/approval-reference.ts",
  "src/fixtures/website-build-v1.ts",
];

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

const COMMERCE_PLATFORM_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "akilta-commerce", pattern: /akilta-commerce/i },
  { label: "Shopify", pattern: /shopify/i },
  { label: "Ticimax", pattern: /ticimax/i },
  { label: "ikas", pattern: /\bikas\b/i },
  { label: "IdeaSoft", pattern: /ideasoft/i },
  { label: "T-Soft", pattern: /t-soft/i },
  { label: "WooCommerce", pattern: /woocommerce/i },
];

// T12: no model/provider hard-coding and no generic queue/workflow-engine
// dependency in DEL-003 domain/compiler source.
const MODEL_PROVIDER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "openai", pattern: /openai/i },
  { label: "anthropic", pattern: /anthropic/i },
  { label: "gpt-model-name", pattern: /\bgpt-\d/i },
  { label: "claude-model-name", pattern: /\bclaude-(3|4|5|opus|sonnet|haiku)/i },
  { label: "gemini", pattern: /\bgemini\b/i },
  { label: "mistral", pattern: /\bmistral\b/i },
  { label: "cohere", pattern: /\bcohere\b/i },
];

const WORKFLOW_ENGINE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "redis", pattern: /\bredis\b/i },
  { label: "bullmq", pattern: /bullmq/i },
  { label: "temporal", pattern: /\btemporal\b/i },
  { label: "airflow", pattern: /airflow/i },
  { label: "kafka", pattern: /kafka/i },
  { label: "rabbitmq", pattern: /rabbitmq/i },
  { label: "celery", pattern: /celery/i },
  { label: "n8n", pattern: /\bn8n\b/i },
  { label: "zapier", pattern: /zapier/i },
  { label: "sqs", pattern: /\bsqs\b/i },
];

test("T11: DEL-003 blueprint/plan fixtures and domain files contain no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of DEL_003_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("T12: DEL-003 domain/compiler source contains no model/provider hard-coding or workflow-engine dependency", () => {
  const violations: string[] = [];
  for (const relativePath of DEL_003_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...MODEL_PROVIDER_PATTERNS, ...WORKFLOW_ENGINE_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("T12: package.json still declares no new runtime dependency introduced by DEL-003", () => {
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
