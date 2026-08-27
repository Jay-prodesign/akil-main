import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v2-cdo-008-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V2_CDO_008_FILES = [
  "src/domain/delivery-advisor.ts",
  "src/fixtures/website-build-v1-advisor.ts",
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
  { label: "vector-db", pattern: /\b(pinecone|weaviate|chroma|qdrant|milvus)\b/i },
];

test("V2-CDO-008: delivery-advisor/website-build-v1-advisor source contains no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V2_CDO_008_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-CDO-008: delivery-advisor/website-build-v1-advisor source has no model/provider hard-coding, RAG/vector-store or queue/workflow-engine/AI-Commerce coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V2_CDO_008_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...MODEL_PROVIDER_PATTERNS, ...WORKFLOW_ENGINE_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-CDO-008 / A7: delivery-advisor.ts has no import statement pulling in any create/transition/verify function from outcome-job.ts, project-plan.ts, approval-reference.ts, capability-admission.ts or connection-authority.ts (types only, no mutation surface)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/delivery-advisor.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const mutationModulePattern =
    /(outcome-job|project-plan|approval-reference|capability-admission|connection-authority)/;
  for (const line of importLines) {
    if (mutationModulePattern.test(line)) {
      assert.match(line, /^\s*import\s+type\b/, `expected type-only import, got: ${line}`);
    }
  }
});

test("V2-CDO-008 / A9: DeliveryAdvisorObservation/AdvisorRecommendationOption field names carry no raw payload, secret or margin field", () => {
  const forbiddenFieldNames = [
    "payload",
    "rawContent",
    "secret",
    "credential",
    "token",
    "margin",
    "cost",
    "prompt",
  ];
  const content = readFileSync(join(REPO_ROOT, "src/domain/delivery-advisor.ts"), "utf8");
  for (const forbidden of forbiddenFieldNames) {
    assert.equal(
      new RegExp(`readonly\\s+${forbidden}\\b`, "i").test(content),
      false,
      `found forbidden field name "${forbidden}"`,
    );
  }
});

test("V2-CDO-008: package.json still declares no new runtime dependency", () => {
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
