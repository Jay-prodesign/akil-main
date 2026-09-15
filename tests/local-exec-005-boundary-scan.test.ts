import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as LocalExecutionCollaboration from "../src/domain/local-execution-collaboration.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/local-execution-collaboration.ts";

test("LOCAL-EXEC-005: never redefines CollaborationMode, LocalTaskLease, LocalTaskCheckpoint, LocalWorkerRegistration, or ExternalEffectAttemptState - composes existing modules unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /export\s+(type|interface)\s+CollaborationMode\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+LocalTaskLease\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+LocalTaskCheckpoint\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+LocalWorkerRegistration\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+ExternalEffectAttemptState\b/);
});

test("LOCAL-EXEC-005: resolveLocalExecutionFailover routes only through the existing worker-routing-policy.ts, never a second router", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.match(content, /import\s*\{\s*resolveWorkerRoute\s*\}\s*from\s*["']\.\/worker-routing-policy\.js["']/);
  assert.doesNotMatch(content, /class\s+\w*Router\b/i);
});

test("LOCAL-EXEC-005: resolveLocalExecutionFailover checks the external-effect UNKNOWN gate before resolving any candidate", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function resolveLocalExecutionFailover");
  assert.ok(fnStart >= 0, "resolveLocalExecutionFailover not found");
  const fnBody = content.slice(fnStart);
  const unknownGateIndex = fnBody.indexOf('externalEffectState === "UNKNOWN"');
  const eligibleCallIndex = fnBody.indexOf("resolveEligibleLocalWorkers(");
  assert.ok(unknownGateIndex >= 0 && eligibleCallIndex >= 0, "expected both the UNKNOWN gate and the eligibility call present");
  assert.ok(unknownGateIndex < eligibleCallIndex, "the UNKNOWN external-effect gate must be checked before resolving candidates");
});

test("LOCAL-EXEC-005 (Rev108 correction): resolveLocalExecutionFailover verifies checkpoint/lease/worker/device/tenant/task lineage and represents the deterministic lease-end via transitionLocalTaskLease before resolving any candidate", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function resolveLocalExecutionFailover");
  assert.ok(fnStart >= 0, "resolveLocalExecutionFailover not found");
  const fnBody = content.slice(fnStart);
  const leaseIdCheckIndex = fnBody.indexOf("checkpoint.leaseId !== input.currentLease.leaseId");
  const statusCheckIndex = fnBody.indexOf('currentLease.status !== "CHECKPOINTED"');
  const transitionIndex = fnBody.indexOf("transitionLocalTaskLease(");
  const eligibleCallIndex = fnBody.indexOf("resolveEligibleLocalWorkers(");
  assert.ok(
    leaseIdCheckIndex >= 0 && statusCheckIndex >= 0 && transitionIndex >= 0 && eligibleCallIndex >= 0,
    "expected lineage checks, the lease-end transition, and the eligibility call all present",
  );
  assert.ok(leaseIdCheckIndex < statusCheckIndex, "leaseId lineage must be checked before the status check");
  assert.ok(statusCheckIndex < transitionIndex, "status must be checked before the deterministic lease-end transition");
  assert.ok(transitionIndex < eligibleCallIndex, "the lease must be ended before any candidate is resolved");
});

test("LOCAL-EXEC-005 (Rev108 correction): claimSharedRepoBranch verifies the worker is bound to targetOwnership before any branch claim is granted", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function claimSharedRepoBranch");
  assert.ok(fnStart >= 0, "claimSharedRepoBranch not found");
  const fnBody = content.slice(fnStart);
  assert.match(fnBody, /isBoundToTargetOwnership\(/);
});

test("LOCAL-EXEC-005 (Rev109 correction): SharedRepoBranchClaim.accessVerified is a structural false literal, never a runtime-settable true value", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.match(content, /accessVerified:\s*false/);
  assert.doesNotMatch(content, /accessVerified:\s*true/);
  assert.doesNotMatch(content, /accessVerified:\s*boolean/);
});

test("LOCAL-EXEC-005 (independent-review fix): planCollaborationModeTransition validates from/to via an equality-based Set membership check (isRecognizedCollaborationModeValue) before ever indexing the COLLABORATION_RANK object literal, so a prototype-chain key (e.g. 'constructor') cannot bypass fail-closed validation", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function planCollaborationModeTransition");
  assert.ok(fnStart >= 0, "planCollaborationModeTransition not found");
  const bodyStart = content.indexOf("): CollaborationTransitionPreflight {", fnStart);
  assert.ok(bodyStart >= 0, "planCollaborationModeTransition's body opening not found");
  const fnBody = content.slice(bodyStart, content.indexOf("\n}", bodyStart));
  const guardCheckIndex = fnBody.indexOf("isRecognizedCollaborationModeValue(input.from)");
  const rankIndexIndex = fnBody.indexOf("COLLABORATION_RANK[input.from]");
  assert.ok(guardCheckIndex >= 0, "expected an explicit isRecognizedCollaborationModeValue guard");
  assert.ok(rankIndexIndex >= 0, "expected COLLABORATION_RANK to be indexed after validation");
  assert.ok(guardCheckIndex < rankIndexIndex, "the recognized-mode guard must run before the rank table is ever indexed");
  const guardFnStart = content.indexOf("function isRecognizedCollaborationModeValue");
  assert.ok(guardFnStart >= 0, "isRecognizedCollaborationModeValue not found");
  const guardFnBody = content.slice(guardFnStart, content.indexOf("\n}", guardFnStart));
  assert.match(guardFnBody, /RECOGNIZED_COLLABORATION_MODES\.has\(/, "expected a Set.has() membership check, not an object-key existence check");
});

test("LOCAL-EXEC-005: never calls fetch, a node: builtin, or the system clock - pure domain composition only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)|new Date\(/);
});

test("LOCAL-EXEC-005: no real Git plumbing, network, or credential-shaped literal anywhere in this module", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /child_process|simple-git|isomorphic-git/i);
  assert.doesNotMatch(content, /password|api[_-]?key|secret[_-]?token/i);
});

test("LOCAL-EXEC-005: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(LocalExecutionCollaboration).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidCollaborationTransitionError",
    "InvalidLocalFailoverError",
    "InvalidSharedRepoLeaseError",
    "InvalidTaskPacketError",
    "InvalidWorkspaceSnapshotError",
    "claimSharedRepoBranch",
    "createTaskPacket",
    "createWorkspaceBinding",
    "createWorkspaceSnapshotPackage",
    "planCollaborationModeTransition",
    "rehydrateTaskPacketForHandoff",
    "resolveLocalExecutionFailover",
    "verifySharedRepoBaseBeforeContinuing",
  ]);
});

test("LOCAL-EXEC-005: package.json still declares no new runtime dependency", () => {
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
