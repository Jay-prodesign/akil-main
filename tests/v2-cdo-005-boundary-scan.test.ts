import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v2-cdo-005-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V2_CDO_005_FILES = [
  "src/domain/client-project-snapshot.ts",
  "src/fixtures/website-build-v1-snapshot.ts",
];

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
  { label: "cookie-literal", pattern: /cookie\s*[:=]\s*['"][^'"]+['"]/i },
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

const HTTP_UI_PERSISTENCE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "http-server-framework", pattern: /\b(express|fastify|koa|hapi)\b/i },
  { label: "http-client-library", pattern: /\b(axios|node-fetch|got|undici)\b/i },
  { label: "react-or-frontend-framework", pattern: /\b(react|vue|svelte|angular)\b/i },
  { label: "database-driver-or-orm", pattern: /\b(prisma|typeorm|sequelize|mongoose|pg-promise|knex)\b/i },
  { label: "sql-keyword-as-code", pattern: /\b(SELECT \* FROM|INSERT INTO|CREATE TABLE)\b/ },
  { label: "auth-session-library", pattern: /\b(passport|next-auth|jsonwebtoken|jose)\b/i },
];

const WORKFLOW_ENGINE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "redis", pattern: /\bredis\b/i },
  { label: "bullmq", pattern: /bullmq/i },
  { label: "kafka", pattern: /kafka/i },
  { label: "rabbitmq", pattern: /rabbitmq/i },
  { label: "google[_-]?drive", pattern: /google[_-]?drive/i },
];

test("V2-CDO-005: client-project-snapshot/fixture source contains no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V2_CDO_005_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-CDO-005: no model/provider hard-coding, HTTP/UI/persistence/auth framework, or workflow-engine dependency", () => {
  const violations: string[] = [];
  for (const relativePath of V2_CDO_005_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [
      ...MODEL_PROVIDER_PATTERNS,
      ...HTTP_UI_PERSISTENCE_PATTERNS,
      ...WORKFLOW_ENGINE_PATTERNS,
    ]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-CDO-005 / P10: client-project-snapshot.ts has no import statement pulling in a value (non-type) dependency capable of mutating OutcomeJob/ProjectPlan/approval/connection state", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/client-project-snapshot.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const mutatingValueImports = importLines.filter((line) => {
    const isTypeOnly = /^\s*import type\b/.test(line);
    if (isTypeOnly) {
      return false;
    }
    return /verifyOutcomeJob|transitionOutcomeJob|createOutcomeJob|compilePlan|admitPlan|admitJobs|createConnectionBinding|verifyConnectionBinding|createCapabilityAdmission/.test(
      line,
    );
  });
  assert.deepEqual(mutatingValueImports, []);
});

test("V2-CDO-005: package.json still declares no new runtime dependency", () => {
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
