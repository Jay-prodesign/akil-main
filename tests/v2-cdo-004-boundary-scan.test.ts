import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v2-cdo-004-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V2_CDO_004_FILES = [
  "src/domain/connection-authority.ts",
  "src/domain/capability-admission.ts",
  "src/fixtures/website-build-v1-connection.ts",
];

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
  { label: "cookie-literal", pattern: /cookie\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "recovery-code-literal", pattern: /recovery[_-]?code\s*[:=]\s*['"][^'"]+['"]/i },
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
];

const MESSAGING_PROVIDER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "twilio", pattern: /twilio/i },
  { label: "sendgrid", pattern: /sendgrid/i },
  { label: "nodemailer", pattern: /nodemailer/i },
  { label: "ses-email", pattern: /\bses\b/i },
  { label: "whatsapp-business-api", pattern: /whatsapp/i },
  { label: "smtp", pattern: /\bsmtp\b/i },
];

const OAUTH_RUNTIME_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "oauth-client-library", pattern: /\b(passport|simple-oauth2|openid-client)\b/i },
  { label: "fetch-based-token-exchange", pattern: /\bfetch\s*\(\s*['"]https?:\/\// },
  { label: "http-client-library", pattern: /\b(axios|node-fetch|got|undici)\b/i },
];

test("V2-CDO-004: connection-authority/capability-admission/fixture source contains no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V2_CDO_004_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-CDO-004: no model/provider hard-coding, queue/workflow-engine, messaging-provider, or OAuth/HTTP-client runtime dependency (C11)", () => {
  const violations: string[] = [];
  for (const relativePath of V2_CDO_004_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [
      ...MODEL_PROVIDER_PATTERNS,
      ...WORKFLOW_ENGINE_PATTERNS,
      ...MESSAGING_PROVIDER_PATTERNS,
      ...OAUTH_RUNTIME_PATTERNS,
    ]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-CDO-004 / C11: connection-authority.ts and capability-admission.ts have no import statement pulling in a value (non-type) dependency on outcome-job.ts or project-plan.ts", () => {
  for (const relativePath of ["src/domain/connection-authority.ts", "src/domain/capability-admission.ts"]) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
    const valueImportFromRestrictedModule = importLines.find(
      (line) => /outcome-job|project-plan/.test(line) && !/^\s*import type\b/.test(line),
    );
    assert.equal(valueImportFromRestrictedModule, undefined, `${relativePath} has a value import of a restricted module`);
  }
});

test("V2-CDO-004 / C9: capability-admission.ts imports connection-authority.ts as type-only (no runtime coupling beyond the pure construction it performs)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/capability-admission.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const connectionAuthorityImport = importLines.find((line) => /connection-authority/.test(line));
  assert.ok(connectionAuthorityImport);
  assert.match(connectionAuthorityImport as string, /^\s*import type\b/);
});

test("V2-CDO-004: package.json still declares no new runtime dependency", () => {
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
