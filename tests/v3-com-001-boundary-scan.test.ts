import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v3-com-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V3_COM_001_FILES = [
  "src/domain/commercial-authority.ts",
  "src/fixtures/website-build-v1-commercial-authority.ts",
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
 * Unlike other slices' HARD_NON_SCOPE_PATTERNS, this scan cannot search
 * for the bare words "commission"/"discount"/"payout" - this module's
 * own legitimate JSDoc explains exactly why those concepts are NOT
 * implemented, and the type names themselves (`CommercialAuthoritySnapshot`,
 * `DiscountAuthorityLevel`) are the authorized surface. Instead this
 * scans for the actual *invented-value* field/identifier shapes the V3
 * Full Blueprint §8 explicitly defers (commission percentage/basis/
 * attribution/reversal/tax/payout, discount limits, reseller/wholesale
 * economics, binding SLA terms) - precise field-declaration-shaped
 * patterns, not prose mentions.
 */
const DEFERRED_FIELD_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "commission-rate/percent/pct field", pattern: /commission(Rate|Percent(age)?|Pct)\s*[:?]/i },
  { label: "commission-basis/attribution/reversal/tax field", pattern: /commission(Basis|Attribution|Reversal|Tax)\s*[:?]/i },
  { label: "payout field", pattern: /payout\w*\s*[:?]/i },
  { label: "discount-threshold/limit field", pattern: /discount(Threshold|Limit)\w*\s*[:?]/i },
  { label: "reseller/wholesale economics field", pattern: /(reseller|wholesale)(Margin|Floor|Rate|Terms?)\s*[:?]/i },
  { label: "binding SLA term field", pattern: /bindingSla\w*\s*[:?]/i },
  { label: "currency/amount field", pattern: /(amount|currency|priceCents|priceAmount)\s*[:?]/i },
];

test("V3-COM-001: commercial-authority.ts + fixture contain no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V3_COM_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-COM-001: commercial-authority.ts + fixture have no model/provider hard-coding", () => {
  const violations: string[] = [];
  for (const relativePath of V3_COM_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of MODEL_PROVIDER_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-COM-001: no deferred/invented financial field (commission rate/basis/payout, discount threshold, reseller/wholesale economics, binding SLA term, currency/amount) is declared anywhere", () => {
  const violations: string[] = [];
  for (const relativePath of V3_COM_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of DEFERRED_FIELD_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-COM-001: commercial-authority.ts declares zero numeric (`: number`) fields - no amount/rate/percentage can exist on this type", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/commercial-authority.ts"), "utf8");
  assert.equal(/:\s*number\b/.test(content), false);
});

test("V3-COM-001: commercial-authority.ts has no import of authority.ts, outcome-job.ts, or partner-organization.ts", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/commercial-authority.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) =>
    /["']\.\/(authority|outcome-job|partner-organization)\.js["']/.test(line),
  );
  assert.equal(violatingImport, undefined);
});

test("V3-COM-001: commercial-authority.ts imports nothing from src/web/ or src/application/ (domain depends on nothing else in src/)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/commercial-authority.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) => /\.\.\/(web|application)\//.test(line));
  assert.equal(violatingImport, undefined);
});

test("V3-COM-001: package.json still declares no new runtime dependency", () => {
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
