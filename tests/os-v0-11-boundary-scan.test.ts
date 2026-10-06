import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ConfigurationPolicyDecisionProjection from "../src/domain/configuration-policy-decision-projection.js";
import * as DurableConfigurationPolicyDecisionStore from "../src/domain/durable-configuration-policy-decision-store.js";
import * as ResolveAndProjectConfigurationPolicyDecision from "../src/domain/resolve-and-project-configuration-policy-decision.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECTION_FILE = "src/domain/configuration-policy-decision-projection.ts";
const STORE_FILE = "src/domain/durable-configuration-policy-decision-store.ts";
const ORCHESTRATION_FILE = "src/domain/resolve-and-project-configuration-policy-decision.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

const PROVIDER_MODEL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "openai", pattern: /openai/i },
  { label: "anthropic", pattern: /anthropic/i },
  { label: "shopify", pattern: /shopify/i },
  { label: "oauth", pattern: /oauth/i },
];

const BYPASS_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "isSystem-field-or-access", pattern: /\bisSystem\s*[:?.=]/ },
  { label: "bypass-function-or-field", pattern: /\bbypass\w*\s*[:(]/i },
  { label: "privileged-constructor-function", pattern: /function\s+\w*[Pp]rivileged\w*\s*\(/ },
  { label: "superuser-field-or-function", pattern: /\bsuperuser\w*\s*[:(]/i },
  { label: "raw-credential-field", pattern: /\b(rawCredential|credentialPayload|sessionCookie)\w*\s*[:?.]/i },
];

const ALL_FILES = [PROJECTION_FILE, STORE_FILE, ORCHESTRATION_FILE];

for (const file of ALL_FILES) {
  test(`OS-V0-11: ${file} contains no secret material, hard-coded provider/model coupling, or isSystem/bypass path`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    const violations: string[] = [];
    for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS, ...BYPASS_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`matched forbidden pattern "${label}"`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test(`OS-V0-11: ${file} never calls Date.now() - every timestamp is caller-supplied`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(content, /Date\.now\(\)/);
  });

  test(`OS-V0-11: ${file} never imports a fixture module - a dev/reference fixture can never appear production-current`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(content, /from ["']\.\.\/fixtures\//);
    assert.doesNotMatch(content, /website-build-v1/i);
  });
}

function importLinesOf(file: string): string[] {
  const content = readFileSync(join(REPO_ROOT, file), "utf8");
  const blocks = content.match(/^import[\s\S]*?;$/gm) ?? [];
  return blocks.flatMap((block) =>
    block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

test("OS-V0-11: configuration-policy-decision-projection.ts imports only its declared sibling domain modules - zero authority/store/web coupling, pure/stateless", () => {
  assert.deepEqual(importLinesOf(PROJECTION_FILE), [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { Customer } from "./customer.js";',
    'import type { Project } from "./project.js";',
    'import {',
    'resolveEffectiveConfigurationPolicy,',
    'type EffectiveControl,',
    'type EffectiveConfigurationPolicyResolution,',
    '} from "./effective-configuration-policy.js";',
  ]);
});

test("OS-V0-11: durable-configuration-policy-decision-store.ts imports only node:fs, node:crypto, node:path, and configuration-policy-decision-projection.ts - no new runtime dependency, no authority coupling", () => {
  assert.deepEqual(importLinesOf(STORE_FILE), [
    'import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";',
    'import { randomUUID } from "node:crypto";',
    'import { join } from "node:path";',
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { ConfigurationPolicyDecisionProjectionEntry } from "./configuration-policy-decision-projection.js";',
  ]);
});

test("OS-V0-11: resolve-and-project-configuration-policy-decision.ts imports only its declared sibling domain modules", () => {
  assert.deepEqual(importLinesOf(ORCHESTRATION_FILE), [
    'import { requireSameTenant, requirePermission, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";',
    'import {',
    'computeConfigurationPolicyDecisionProjection,',
    'configurationPolicyResolutionsEqual,',
    'describeConfigurationPolicyDecisionDrift,',
    'encodeConfigurationPolicyDecisionKey,',
    'type ConfigurationPolicyDecisionIdentity,',
    'type ConfigurationPolicyDecisionProjectionEntry,',
    'type ConfigurationPolicyDecisionDrift,',
    '} from "./configuration-policy-decision-projection.js";',
    'import type { DurableConfigurationPolicyDecisionStore } from "./durable-configuration-policy-decision-store.js";',
    'import type { EffectiveConfigurationPolicyResolution } from "./effective-configuration-policy.js";',
  ]);
});

test("OS-V0-11: configuration-policy-decision-projection.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(ConfigurationPolicyDecisionProjection).sort(), [
    "InvalidConfigurationPolicyDecisionProjectionError",
    "computeConfigurationPolicyDecisionProjection",
    "configurationPolicyResolutionsEqual",
    "describeConfigurationPolicyDecisionDrift",
    "encodeConfigurationPolicyDecisionKey",
  ]);
});

test("OS-V0-11: durable-configuration-policy-decision-store.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(DurableConfigurationPolicyDecisionStore).sort(), [
    "CorruptedConfigurationPolicyDecisionLineError",
    "FileDurableConfigurationPolicyDecisionStore",
    "InvalidDurableConfigurationPolicyDecisionStoreError",
  ]);
});

test("OS-V0-11: resolve-and-project-configuration-policy-decision.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(ResolveAndProjectConfigurationPolicyDecision).sort(), [
    "ConfigurationPolicyDecisionNotFoundError",
    "resolveAndProjectConfigurationPolicyDecision",
    "rollbackConfigurationPolicyDecision",
  ]);
});

test("OS-V0-11: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
