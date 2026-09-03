import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/v4-svc-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const V4_SVC_001_FILES = [
  "src/domain/service-capability-routing.ts",
  "src/fixtures/website-build-v1-service-route.ts",
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

test("V4-SVC-001: service-capability-routing.ts + fixture contain no secret material or commerce-provider coupling", () => {
  const violations: string[] = [];
  for (const relativePath of V4_SVC_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V4-SVC-001: service-capability-routing.ts + fixture have no model/provider hard-coding", () => {
  const violations: string[] = [];
  for (const relativePath of V4_SVC_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of MODEL_PROVIDER_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("V4-SVC-001: the only executionMaturity values ever assigned in source are UNAVAILABLE or READ_ONLY - no higher rung (MANUAL/PROVIDER_NATIVE/ENGINEER_ASSISTED/DIAGNOSE/RECOMMEND/DRAFT_PREVIEW/APPROVAL_REQUIRED/CONTROLLED_APPLY) is ever produced by this slice", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/service-capability-routing.ts"), "utf8");
  const assignments = [...content.matchAll(/executionMaturity:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(assignments.length > 0, "expected at least one executionMaturity assignment in source");
  for (const value of assignments) {
    assert.ok(
      value === "UNAVAILABLE" || value === "READ_ONLY",
      `executionMaturity assigned an undeliverable-this-slice value: ${value}`,
    );
  }
});

test("V4-SVC-001: service-capability-routing.ts has no import of authority.ts or outcome-job.ts", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/service-capability-routing.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) =>
    /["']\.\/(authority|outcome-job)\.js["']/.test(line),
  );
  assert.equal(violatingImport, undefined);
});

test("V4-SVC-001 (Rev28 bounded correction): service-capability-routing.ts imports connection-authority.ts as types only - no create/transition/verify mutation function is pulled in", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/service-capability-routing.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const connectionAuthorityImport = importLines.find((line) =>
    /["']\.\/connection-authority\.js["']/.test(line),
  );
  assert.ok(connectionAuthorityImport, "expected a type-only import of connection-authority.ts");
  assert.match(connectionAuthorityImport!, /^\s*import\s+type\b/);
  const violatingValueImport = importLines.find((line) =>
    /["']\.\/connection-authority\.js["']/.test(line) &&
    /\b(createConnectionRequirement|createConnectionBinding|transitionConnectionBinding|verifyConnectionBinding|createSecretRef)\b/.test(line),
  );
  assert.equal(violatingValueImport, undefined);
});

test("V4-SVC-001: service-capability-routing.ts imports nothing from src/web/ or src/application/ (domain depends on nothing else in src/)", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/service-capability-routing.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const violatingImport = importLines.find((line) => /\.\.\/(web|application)\//.test(line));
  assert.equal(violatingImport, undefined);
});

test("V4-SVC-001: package.json still declares no new runtime dependency", () => {
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
