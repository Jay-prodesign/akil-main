import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OperationalObservabilityView from "../src/domain/operational-observability-view.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NEW_FILE = "src/domain/operational-observability-view.ts";

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

const ALL_FILES = [NEW_FILE];

for (const file of ALL_FILES) {
  test(`OS-V0-12: ${file} contains no secret material, hard-coded provider/model coupling, or isSystem/bypass path`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    const violations: string[] = [];
    for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS, ...BYPASS_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`matched forbidden pattern "${label}"`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test(`OS-V0-12: ${file} never calls Date.now() - every timestamp is caller-supplied`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(content, /Date\.now\(\)/);
  });

  test(`OS-V0-12: ${file} never imports a fixture module - a dev/reference fixture can never appear production-current`, () => {
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

test("OS-V0-12: operational-observability-view.ts imports only its declared sibling domain modules - zero authority/store/web coupling, pure/stateless", () => {
  assert.deepEqual(importLinesOf(NEW_FILE), [
    'import {',
    'ATTEMPT_TERMINAL_STATUSES,',
    'type OutcomeJobExecutionAttemptStatus,',
    'type OutcomeJobExecutionRunState,',
    'type OutcomeJobExecutionRunStatus,',
    'type PendingControlRequest,',
    '} from "./outcome-job-execution-run-state.js";',
    'import type { ConnectionBinding, ConnectionState } from "./connection-authority.js";',
    'import type { QuotaReadModel } from "./execution-quota-admission.js";',
    'import type { ProtectedDecisionResumeAuthorization, ProtectedDecisionWaitRequest } from "./protected-decision-wait-gate.js";',
    'import type { EvidenceReference } from "./evidence.js";',
    'import type { VerificationResult, VerificationStatus } from "./verification-result.js";',
  ]);
});

test("OS-V0-12: operational-observability-view.ts module exports exactly the expected surface - purely compositional, zero new error classes needed since every input is already-validated typed domain state", () => {
  assert.deepEqual(Object.keys(OperationalObservabilityView).sort(), ["composeOperationalObservabilityView"]);
});

test("OS-V0-12: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
