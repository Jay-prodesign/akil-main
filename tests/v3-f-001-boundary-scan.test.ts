import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v3-f-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V3_F_001_FILES = [
  "src/domain/team-attention-projection.ts",
  "src/web/team-attention-view-state.ts",
  "src/fixtures/website-build-v1-team-attention.ts",
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
];

/**
 * Per the Founder-authorized scope for this checkpoint: no new commercial/
 * financial policy, no persistence, no provider SDK/OAuth. These scan for
 * the actual invented-value field/identifier shapes rather than bare
 * words (this module's own text legitimately says "Commercial:
 * Unavailable" and discusses ownership/attention).
 */
const DEFERRED_FIELD_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "commission-rate/percent/pct field", pattern: /commission(Rate|Percent(age)?|Pct)\s*[:?]/i },
  { label: "discount-threshold/limit field", pattern: /discount\w*\s*[:?]/i },
  { label: "payout field", pattern: /payout\w*\s*[:?]/i },
  { label: "currency/amount field", pattern: /(amount|currency|priceCents|priceAmount)\s*[:?]/i },
];

const PERSISTENCE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "node:fs write", pattern: /writeFileSync|createWriteStream|node:fs\/promises/i },
  { label: "database/orm keyword", pattern: /\b(mongoose|prisma|sequelize|typeorm|knex|pg-promise)\b/i },
  { label: "sql keyword", pattern: /\b(SELECT|INSERT INTO|CREATE TABLE)\b/ },
];

test("V3-F-001: team-attention-projection.ts, team-attention-view-state.ts and their fixture contain no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V3_F_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-F-001: no model/provider hard-coding anywhere in this checkpoint's source", () => {
  const violations: string[] = [];
  for (const relativePath of V3_F_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of MODEL_PROVIDER_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-F-001: no invented commercial/financial field is declared anywhere in this checkpoint's source", () => {
  const violations: string[] = [];
  for (const relativePath of V3_F_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of DEFERRED_FIELD_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-F-001: team-attention-projection.ts declares zero numeric (`: number`) fields", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/team-attention-projection.ts"), "utf8");
  assert.equal(/:\s*number\b/.test(content), false);
});

test("V3-F-001: no persistence/database/provider-SDK coupling anywhere in this checkpoint's source", () => {
  const violations: string[] = [];
  for (const relativePath of V3_F_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of PERSISTENCE_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-F-001: team-attention-projection.ts (domain) imports nothing from src/web/, src/application/, or any sibling-PR-only module (commercial-authority/service-capability-routing/operations-attention)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/team-attention-projection.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) =>
    /\.\.\/(web|application)\/|commercial-authority|service-capability-routing|operations-attention/.test(line),
  );
  assert.equal(violatingImport, undefined);
});

test("V3-F-001: team-attention-projection.ts has no import of authority.ts, outcome-job.ts, capability-admission.ts, connection-authority.ts, or partner-organization.ts", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/team-attention-projection.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) =>
    /["']\.\/(authority|outcome-job|capability-admission|connection-authority|partner-organization)\.js["']/.test(
      line,
    ),
  );
  assert.equal(violatingImport, undefined);
});

test("V3-F-001: team-attention-view-state.ts introduces no new session/auth primitive - it only imports the existing SessionContext/route-guard exports", () => {
  const content = readFileSync(join(REPO_ROOT, "src/web/team-attention-view-state.ts"), "utf8");
  assert.doesNotMatch(content, /createSessionContext|createAuthenticatedPrincipal|new\s+SessionProvider/);
});

test("V3-F-001: createRequestHandler's teamAttentionSource dependency is optional - existing callers that omit it still type-check and compile (structural proof via source text)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/web/request-handler.ts"), "utf8");
  assert.match(content, /teamAttentionSource\?:\s*TeamAttentionSource/);
});

test("V3-F-001: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
