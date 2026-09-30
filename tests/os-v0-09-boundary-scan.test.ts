import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OrganizationResourceBinding from "../src/domain/organization-resource-binding.js";
import * as DurableOrganizationResourceBindingStore from "../src/domain/durable-organization-resource-binding-store.js";

// This file lives at <repo-root>/tests/os-v0-09-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOMAIN_FILE = "src/domain/organization-resource-binding.ts";
const STORE_FILE = "src/domain/durable-organization-resource-binding-store.ts";

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

/**
 * OS-V0-09 mandatory witness 6/9: no `isSystem`/bypass flag or privileged
 * constructor may appear anywhere in the new module, and no raw
 * credential/session field name may appear either - "Organization Zero" is
 * bootstrapped through exactly the same ordinary contract as any other
 * Organization, and a resource binding stores only opaque ids, never a
 * SecretRef/raw credential payload.
 */
const BYPASS_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "isSystem-field-or-access", pattern: /\bisSystem\s*[:?.=]/ },
  { label: "bypass-function-or-field", pattern: /\bbypass\w*\s*[:(]/i },
  { label: "privileged-constructor-function", pattern: /function\s+\w*[Pp]rivileged\w*\s*\(/ },
  { label: "superuser-field-or-function", pattern: /\bsuperuser\w*\s*[:(]/i },
  { label: "raw-credential-field", pattern: /\b(rawCredential|credentialPayload|sessionCookie)\w*\s*[:?.]/i },
];

for (const file of [DOMAIN_FILE, STORE_FILE]) {
  test(`OS-V0-09: ${file} contains no secret material, hard-coded provider/model coupling, or isSystem/bypass path`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    const violations: string[] = [];
    for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS, ...BYPASS_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`matched forbidden pattern "${label}"`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test(`OS-V0-09: ${file} never calls Date.now() - every timestamp is caller-supplied`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(content, /Date\.now\(\)/);
  });

  test(`OS-V0-09: ${file} never imports a fixture module - a dev/reference fixture can never appear production-current`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(content, /from ["']\.\.\/fixtures\//);
    assert.doesNotMatch(content, /website-build-v1/i);
  });
}

test("OS-V0-09: organization-resource-binding.ts imports only its declared sibling domain modules (type-only where applicable) - no filesystem, network, or child_process coupling", () => {
  const content = readFileSync(join(REPO_ROOT, DOMAIN_FILE), "utf8");
  const importLines = content
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .map((line) => line.trim());
  assert.deepEqual(importLines, [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { Organization } from "./organization.js";',
    'import { isOrganizationMembershipActive, type OrganizationMembership } from "./organization-membership.js";',
    'import { isOrganizationServicePrincipalActive, type OrganizationServicePrincipal } from "./organization-service-principal.js";',
    'import type { Project } from "./project.js";',
    'import type { ProjectOwnershipRef } from "./project-ownership.js";',
    'import type { ConnectionBinding } from "./connection-authority.js";',
    'import type { WorkerRoutingDecision } from "./worker-routing-policy.js";',
  ]);
});

test("OS-V0-09: durable-organization-resource-binding-store.ts imports only node:fs, node:crypto, node:path, and organization-resource-binding.ts - no new runtime dependency", () => {
  const content = readFileSync(join(REPO_ROOT, STORE_FILE), "utf8");
  const importLines = content
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .map((line) => line.trim());
  assert.deepEqual(importLines, [
    'import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";',
    'import { randomUUID } from "node:crypto";',
    'import { join } from "node:path";',
    'import type { TenantScope } from "./tenant-scope.js";',
    'import { createOrganizationResourceBinding, type OrganizationResourceBinding } from "./organization-resource-binding.js";',
  ]);
});

test("OS-V0-09: organization-resource-binding.ts module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(OrganizationResourceBinding).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidOrganizationResourceBindingError",
    "createOrganizationResourceBinding",
    "resolveOrganizationResourceBindingStatus",
  ]);
});

test("OS-V0-09: durable-organization-resource-binding-store.ts module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(DurableOrganizationResourceBindingStore).sort();
  assert.deepEqual(exportedKeys, [
    "CorruptedOrganizationResourceBindingLineError",
    "FileDurableOrganizationResourceBindingStore",
    "InvalidDurableOrganizationResourceBindingStoreError",
    "bootstrapOrganizationResourceBinding",
  ]);
});

test("OS-V0-09: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
