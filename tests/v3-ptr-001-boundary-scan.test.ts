import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v3-ptr-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V3_PTR_001_FILES = ["src/domain/partner-organization.ts"];

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

const HARD_NON_SCOPE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "commission", pattern: /commission/i },
  { label: "payout", pattern: /payout/i },
  { label: "oauth", pattern: /oauth/i },
  { label: "\\bsla\\b", pattern: /\bsla\b/i },
  { label: "contract", pattern: /\bcontract\b/i },
];

test("V3-PTR-001: partner-organization.ts contains no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V3_PTR_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-PTR-001: partner-organization.ts has no model/provider hard-coding and no commission/payout/OAuth/SLA/contract/sell-right scope creep", () => {
  const violations: string[] = [];
  for (const relativePath of V3_PTR_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...MODEL_PROVIDER_PATTERNS, ...HARD_NON_SCOPE_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V3-PTR-001: partner-organization.ts does not import organization-membership.ts or authority.ts - a partner employee is never conflated with AKILTA-internal membership or granted permission authority", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/partner-organization.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) =>
    /["']\.\/(organization-membership|authority)\.js["']/.test(line),
  );
  assert.equal(violatingImport, undefined);
});

test("V3-PTR-001: partner-organization.ts imports nothing from src/web/ or src/application/ (domain depends on nothing else in src/)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/partner-organization.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) => /\.\.\/(web|application)\//.test(line));
  assert.equal(violatingImport, undefined);
});

test("V3-PTR-001: PartnerClientAssignment carries only identifier/status/timestamp fields - no field capable of holding projected customer content (margins/notes/prompts/secrets)", () => {
  const forbiddenFieldNames = [
    "margin",
    "note",
    "prompt",
    "secret",
    "credential",
    "payload",
    "content",
  ];
  const content = readFileSync(join(REPO_ROOT, "src/domain/partner-organization.ts"), "utf8");
  for (const forbidden of forbiddenFieldNames) {
    assert.equal(
      new RegExp(`readonly\\s+${forbidden}\\b`, "i").test(content),
      false,
      `found forbidden field name "${forbidden}"`,
    );
  }
});

test("V3-PTR-001: package.json still declares no new runtime dependency", () => {
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
