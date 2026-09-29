import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/os-v0-07-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const OS_V0_07_FILES = [
  "src/domain/execution-quota-admission.ts",
  "src/domain/durable-quota-reservation-store.ts",
  "src/domain/postgres-quota-reservation-store.ts",
  "src/ports/async-quota-reservation-store.ts",
];

/**
 * Mirrors `conn-001-boundary-scan.test.ts`'s own discipline exactly: real
 * secret material, commerce-platform coupling (Invariant 6), and any actual
 * OAuth/HTTP-client runtime dependency remain forbidden in every OS-V0-07
 * file - this package is pure internal execution governance/economics, it
 * never charges a customer, never talks to a real provider, and never
 * resolves a canonical numeric policy default on its own (Rev174's own
 * POLICY VALUES constraint).
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
  { label: "cookie-literal", pattern: /cookie\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "recovery-code-literal", pattern: /recovery[_-]?code\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "bearer-literal", pattern: /bearer\s+[a-z0-9._-]{16,}/i },
];

const COMMERCE_PLATFORM_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "akilta-commerce", pattern: /akilta-commerce/i },
  { label: "Shopify", pattern: /shopify/i },
  { label: "Ticimax", pattern: /ticimax/i },
  { label: "ikas", pattern: /\bikas\b/i },
  { label: "IdeaSoft", pattern: /ideasoft/i },
  { label: "T-Soft", pattern: /t-soft/i },
  { label: "WooCommerce", pattern: /woocommerce/i },
  { label: "invoice/payment/pricing", pattern: /\b(invoice|refund|payment|credit[_-]?pack|public pricing)\b/i },
];

const OAUTH_HTTP_RUNTIME_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "oauth-client-library", pattern: /\b(passport|simple-oauth2|openid-client)\b/i },
  { label: "fetch-based-token-exchange", pattern: /\bfetch\s*\(\s*['"]https?:\/\// },
  {
    label: "http-client-library",
    pattern: /(?:from\s+['"]|require\(\s*['"])(axios|node-fetch|got|undici)['"]/i,
  },
];

test("OS-V0-07: execution-quota-admission.ts and its stores contain no secret material or commerce-platform/billing coupling", () => {
  const violations: string[] = [];
  for (const relativePath of OS_V0_07_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("OS-V0-07: execution-quota-admission.ts and its stores make no real OAuth/HTTP-client runtime call - the Postgres store is a pure SqlClient-injected adapter, never a live driver", () => {
  const violations: string[] = [];
  for (const relativePath of OS_V0_07_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of OAUTH_HTTP_RUNTIME_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("OS-V0-07: durable-quota-reservation-store.ts imports the pure admission/commit/release/projection surface from execution-quota-admission.ts as a real (non-type-only) value import", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/durable-quota-reservation-store.ts"), "utf8");
  const match = content.match(/import\s*(type)?\s*\{[^}]*\}\s*from\s*"\.\/execution-quota-admission\.js";/s);
  assert.ok(match, "expected an import from execution-quota-admission.js");
  assert.equal(match?.[1], undefined, "the import must be a real value import, not `import type`, since this store calls admitQuotaReservation/commitQuotaUsage/releaseQuotaReservation at runtime");
});

test("OS-V0-07: postgres-quota-reservation-store.ts never imports a concrete SQL driver package - only the provider-neutral SqlClient port", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/postgres-quota-reservation-store.ts"), "utf8");
  const forbiddenDrivers = /(?:from\s+['"]|require\(\s*['"])(pg|postgres|mysql2?|mssql|sqlite3|better-sqlite3|knex|typeorm|prisma)['"]/i;
  assert.doesNotMatch(content, forbiddenDrivers);
  assert.match(content, /from ["']\.\.\/ports\/sql-client\.js["']/);
});

test("OS-V0-07: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});

test("OS-V0-07: execution-quota-admission.ts never invents a canonical global numeric limit - createQuotaEnvelope only ever accepts a caller-supplied REPORTED limit, with no fallback/default value", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/execution-quota-admission.ts"), "utf8");
  const start = content.indexOf("export function createQuotaEnvelope(");
  const end = content.indexOf("\n}", content.indexOf("): QuotaEnvelope {", start));
  const body = content.slice(start, end);
  assert.match(body, /createCostAmount\(input\.limit\)/, "the envelope limit must be constructed directly from the caller's own input, never a default");
  assert.doesNotMatch(body, /\?\?/, "createQuotaEnvelope must not supply a fallback/default for any caller-controlled policy value");
});

test("OS-V0-07: outcome-job-execution-runtime.ts's quota admission gate runs strictly after authority/activation currentness, never before", () => {
  const content = readFileSync(join(REPO_ROOT, "src/application/outcome-job-execution-runtime.ts"), "utf8");
  const dispatchStart = content.indexOf("export async function dispatchOutcomeJobExecutionRun");
  const dispatchEnd = content.indexOf("export async function retryOutcomeJobExecutionAttempt");
  const dispatchBody = content.slice(dispatchStart, dispatchEnd);
  const authorityIndex = dispatchBody.indexOf("requirePermission(input.authority");
  const activationIndex = dispatchBody.indexOf("assertCurrentActivation(");
  const quotaEnvelopeIndex = dispatchBody.indexOf("assertCurrentQuotaEnvelope(");
  const quotaAdmitIndex = dispatchBody.indexOf("admitQuotaForAttempt(");
  assert.ok(authorityIndex > -1 && activationIndex > -1 && quotaEnvelopeIndex > -1 && quotaAdmitIndex > -1);
  assert.ok(authorityIndex < activationIndex, "authority must be checked before activation currentness");
  assert.ok(activationIndex < quotaEnvelopeIndex, "activation currentness must be checked before quota envelope currentness");
  assert.ok(quotaEnvelopeIndex < quotaAdmitIndex, "quota envelope currentness must be asserted before the admission call itself");
});
