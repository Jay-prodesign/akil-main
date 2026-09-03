import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v4-ops-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V4_OPS_001_FILES = [
  "src/domain/operations-attention.ts",
  "src/fixtures/website-build-v1-operations-attention.ts",
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

test("V4-OPS-001: operations-attention.ts + fixture contain no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V4_OPS_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V4-OPS-001: operations-attention.ts + fixture have no model/provider hard-coding", () => {
  const violations: string[] = [];
  for (const relativePath of V4_OPS_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of MODEL_PROVIDER_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V4-OPS-001: operations-attention.ts declares only one AttentionSourceDomain literal (DELIVERY_OUTCOME_JOB) - no fabricated second source domain", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/operations-attention.ts"), "utf8");
  const typeMatch = content.match(/export type AttentionSourceDomain =\s*("[^"]+")/);
  assert.ok(typeMatch, "expected an AttentionSourceDomain type declaration");
  assert.equal(typeMatch![1], '"DELIVERY_OUTCOME_JOB"');
});

test("V4-OPS-001: operations-attention.ts has no import of authority.ts, capability-admission.ts, connection-authority.ts, service-capability-routing.ts, or partner-organization.ts", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/operations-attention.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) =>
    /["']\.\/(authority|capability-admission|connection-authority|service-capability-routing|partner-organization)\.js["']/.test(
      line,
    ),
  );
  assert.equal(violatingImport, undefined);
});

test("V4-OPS-001 (Rev28 bounded correction): operations-attention.ts imports outcome-job.ts as types only - no create/transition/verify mutation function is pulled in - and nothing from src/web/ or src/application/", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/operations-attention.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const outcomeJobImport = importLines.find((line) => /["']\.\/outcome-job\.js["']/.test(line));
  assert.ok(outcomeJobImport, "expected a type-only import of outcome-job.ts (for OutcomeJob['customerId'])");
  assert.match(outcomeJobImport!, /^\s*import\s+type\b/);
  const violatingValueImport = importLines.find(
    (line) =>
      /["']\.\/outcome-job\.js["']/.test(line) &&
      /\b(createOutcomeJob|transitionOutcomeJob|verifyOutcomeJob|enterExceptionState)\b/.test(line),
  );
  assert.equal(violatingValueImport, undefined);
  const violatingWebAppImport = importLines.find((line) => /\.\.\/(web|application)\//.test(line));
  assert.equal(violatingWebAppImport, undefined);
});

test("V4-OPS-001: package.json still declares no new runtime dependency", () => {
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
