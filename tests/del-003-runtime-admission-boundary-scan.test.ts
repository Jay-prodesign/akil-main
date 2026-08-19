import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/del-003-runtime-admission-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RUNTIME_ADMISSION_FILES = [
  "src/domain/plan-admission.ts",
  "src/domain/outcome-job-wiring.ts",
];

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
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

// T10: no model/provider hard-coding, no generic queue/workflow-engine
// dependency, no AI Commerce internal state, no direct cross-project DB
// mutation surface in the runtime-admission/OutcomeJob-wiring source.
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
  { label: "google[_-]?drive", pattern: /google[_-]?drive/i },
  { label: "generic-agent-builder", pattern: /agent[_-]?builder/i },
];

test("T10: DEL-003 runtime-admission/OutcomeJob-wiring source contains no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of RUNTIME_ADMISSION_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("T10: DEL-003 runtime-admission/OutcomeJob-wiring source has no model/provider hard-coding or queue/workflow-engine/AI-Commerce coupling", () => {
  const violations: string[] = [];
  for (const relativePath of RUNTIME_ADMISSION_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...MODEL_PROVIDER_PATTERNS, ...WORKFLOW_ENGINE_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("T12: package.json still declares no new runtime dependency introduced by the DEL-003 runtime-admission slice", () => {
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
