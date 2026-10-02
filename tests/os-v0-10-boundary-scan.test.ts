import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OutcomeJobGoldenPathComposition from "../src/domain/outcome-job-golden-path-composition.js";
import * as ProtectedDecisionWaitGate from "../src/domain/protected-decision-wait-gate.js";
import * as DurableProtectedDecisionWaitStore from "../src/domain/durable-protected-decision-wait-store.js";
import * as ConnectorCapabilityVerifiedEffect from "../src/domain/connector-capability-verified-effect.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSITION_FILE = "src/domain/outcome-job-golden-path-composition.ts";
const WAIT_GATE_FILE = "src/domain/protected-decision-wait-gate.ts";
const WAIT_STORE_FILE = "src/domain/durable-protected-decision-wait-store.ts";
const VERIFIED_EFFECT_FILE = "src/domain/connector-capability-verified-effect.ts";

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

const ALL_FILES = [COMPOSITION_FILE, WAIT_GATE_FILE, WAIT_STORE_FILE, VERIFIED_EFFECT_FILE];

for (const file of ALL_FILES) {
  test(`OS-V0-10: ${file} contains no secret material, hard-coded provider/model coupling, or isSystem/bypass path`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    const violations: string[] = [];
    for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS, ...BYPASS_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`matched forbidden pattern "${label}"`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test(`OS-V0-10: ${file} never calls Date.now() - every timestamp is caller-supplied`, () => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(content, /Date\.now\(\)/);
  });

  test(`OS-V0-10: ${file} never imports a fixture module - a dev/reference fixture can never appear production-current`, () => {
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

test("OS-V0-10: outcome-job-golden-path-composition.ts imports only its declared sibling domain modules - no filesystem, network, or child_process coupling", () => {
  assert.deepEqual(importLinesOf(COMPOSITION_FILE), [
    'import type { ProjectOwnershipRef } from "./project-ownership.js";',
    'import type { OutcomeJob } from "./outcome-job.js";',
    'import type { OutcomeJobSpec } from "./outcome-job-spec.js";',
    'import type { ProjectActivationProfile, ActivationActor } from "./project-activation-profile.js";',
    'import {',
    'ATTEMPT_TERMINAL_STATUSES,',
    'type OutcomeJobExecutionRunState,',
    '} from "./outcome-job-execution-run-state.js";',
    'import type { VerificationResult } from "./verification-result.js";',
    'import {',
    'isRoutedExecutionAssignmentValidForJob,',
    'type RoutedExecutionAssignment,',
    '} from "./outcome-job-routing-execution.js";',
    'import { createTaskPacket, type TaskPacket } from "./local-execution-collaboration.js";',
  ]);
});

test("OS-V0-10: protected-decision-wait-gate.ts imports only its declared sibling domain modules", () => {
  assert.deepEqual(importLinesOf(WAIT_GATE_FILE), [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { Customer } from "./customer.js";',
    'import type { Project } from "./project.js";',
    'import type { OutcomeJob } from "./outcome-job.js";',
    'import { requireSameTenant, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";',
  ]);
});

test("OS-V0-10: durable-protected-decision-wait-store.ts imports only node:fs, node:crypto, node:path, and protected-decision-wait-gate.ts - no new runtime dependency", () => {
  assert.deepEqual(importLinesOf(WAIT_STORE_FILE), [
    'import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";',
    'import { randomUUID } from "node:crypto";',
    'import { join } from "node:path";',
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type {',
    'ProtectedDecisionWaitRequest,',
    'ProtectedDecisionResumeAuthorization,',
    '} from "./protected-decision-wait-gate.js";',
  ]);
});

test("OS-V0-10: connector-capability-verified-effect.ts imports only its declared sibling domain modules - no raw HTTP/OAuth/provider transport", () => {
  assert.deepEqual(importLinesOf(VERIFIED_EFFECT_FILE), [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import {',
    'executeConnectorCapability,',
    'ConnectorExecutionAuthorizationError,',
    'ConnectorExecutionTransportError,',
    'type ConnectorExecutionResult,',
    'type ConnectorTransport,',
    'type SecretResolver,',
    'type CurrentConnectorConnectionReader,',
    '} from "./connector-execution.js";',
    'import type { ProjectOwnershipRef } from "./project-ownership.js";',
    'import {',
    'createExternalEffectIntent,',
    'startExternalEffectAttempt,',
    'reportExternalEffectOutcome,',
    'verifyExternalEffectReadback,',
    'type ExternalEffectIntent,',
    'type ExternalEffectAttempt,',
    'type ExternalEffectRetryClassification,',
    '} from "./external-effect-envelope.js";',
    'import { requireSameTenant, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";',
  ]);
});

test("OS-V0-10: outcome-job-golden-path-composition.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(OutcomeJobGoldenPathComposition).sort(), [
    "InvalidGoldenPathCompositionError",
    "composeTaskPacketForOutcomeJob",
    "resolveNextRunnableGoldenPathAction",
  ]);
});

test("OS-V0-10: protected-decision-wait-gate.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(ProtectedDecisionWaitGate).sort(), [
    "InvalidProtectedDecisionWaitRequestError",
    "ProtectedDecisionWaitStaleError",
    "authorizeProtectedDecisionResume",
    "createProtectedDecisionWaitRequest",
  ]);
});

test("OS-V0-10: durable-protected-decision-wait-store.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(DurableProtectedDecisionWaitStore).sort(), [
    "CorruptedProtectedDecisionWaitLineError",
    "FileDurableProtectedDecisionWaitStore",
    "InvalidDurableProtectedDecisionWaitStoreError",
  ]);
});

test("OS-V0-10: connector-capability-verified-effect.ts module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(ConnectorCapabilityVerifiedEffect).sort(), [
    "InvalidVerifiedConnectorEffectError",
    "executeConnectorCapabilityAsVerifiedEffect",
  ]);
});

test("OS-V0-10: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
