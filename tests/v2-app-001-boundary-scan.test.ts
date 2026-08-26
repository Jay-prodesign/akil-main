import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v2-app-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V2_APP_001_FILES = [
  "src/web/session-context.ts",
  "src/web/session-provider.ts",
  "src/web/production-session-provider.ts",
  "src/web/dev-fixture-session-provider.ts",
  "src/web/route-guard.ts",
  "src/web/snapshot-view-state.ts",
  "src/web/shell-render.ts",
  "src/web/request-handler.ts",
  "src/web/http-server.ts",
  "src/fixtures/web-shell.ts",
];

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"](?!dev-token-website-build-v1)[^'"]+['"]/i },
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

const IDENTITY_PROVIDER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "auth0", pattern: /auth0/i },
  { label: "clerk", pattern: /\bclerk\b/i },
  { label: "supabase", pattern: /supabase/i },
  { label: "firebase-auth", pattern: /firebase/i },
  { label: "okta", pattern: /\bokta\b/i },
  { label: "cognito", pattern: /cognito/i },
  { label: "oauth", pattern: /oauth/i },
  { label: "openid", pattern: /openid|oidc/i },
];

const FRAMEWORK_AND_PERSISTENCE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "http-server-framework", pattern: /\b(express|fastify|koa|hapi|next\.?js)\b/i },
  { label: "http-client-library", pattern: /\b(axios|node-fetch|got|undici)\b/i },
  { label: "frontend-framework", pattern: /\b(react|vue|svelte|angular)\b/i },
  { label: "database-driver-or-orm", pattern: /\b(prisma|typeorm|sequelize|mongoose|pg-promise|knex)\b/i },
  { label: "sql-keyword-as-code", pattern: /\b(SELECT \* FROM|INSERT INTO|CREATE TABLE)\b/ },
  { label: "auth-session-library", pattern: /\b(passport|next-auth|jsonwebtoken|jose)\b/i },
  { label: "cloud-paas-sdk", pattern: /\b(aws-sdk|@aws-sdk|google-cloud|@azure)\b/i },
];

const MODEL_PROVIDER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "openai", pattern: /openai/i },
  { label: "anthropic", pattern: /anthropic/i },
  { label: "gemini", pattern: /\bgemini\b/i },
  { label: "mistral", pattern: /\bmistral\b/i },
  { label: "cohere", pattern: /\bcohere\b/i },
];

test("V2-APP-001: web-shell source contains no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V2_APP_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-APP-001 (Hard Non-Scope): no external identity/auth provider, OAuth/OIDC flow, HTTP/UI framework, persistence/ORM, cloud SDK, or model-provider name", () => {
  const violations: string[] = [];
  for (const relativePath of V2_APP_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [
      ...IDENTITY_PROVIDER_PATTERNS,
      ...FRAMEWORK_AND_PERSISTENCE_PATTERNS,
      ...MODEL_PROVIDER_PATTERNS,
    ]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-APP-001 A7: the dev-fixture session provider module is never imported by the production session provider", () => {
  const content = readFileSync(join(REPO_ROOT, "src/web/production-session-provider.ts"), "utf8");
  assert.doesNotMatch(content, /dev-fixture-session-provider/);
});

test("V2-APP-001: only http-server.ts imports node:http - every other web-shell module is transport-agnostic", () => {
  const nonServerFiles = V2_APP_001_FILES.filter((path) => path !== "src/web/http-server.ts");
  const violations: string[] = [];
  for (const relativePath of nonServerFiles) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    if (/from ["']node:http["']/.test(content)) {
      violations.push(relativePath);
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-APP-001 A9: request-handler.ts and snapshot-view-state.ts never import raw OutcomeJob/ProjectPlanVersion/ConnectionBinding domain modules - only ClientProjectSnapshot", () => {
  const violations: string[] = [];
  for (const relativePath of ["src/web/request-handler.ts", "src/web/snapshot-view-state.ts"]) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    if (/outcome-job|project-plan|connection-binding/i.test(content)) {
      violations.push(relativePath);
    }
  }
  assert.deepEqual(violations, []);
});

test("V2-APP-001: package.json still declares zero runtime dependencies and only the pre-existing devDependencies", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
