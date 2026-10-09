import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as LocalExecutionHardening from "../src/domain/local-execution-hardening.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/local-execution-hardening.ts";

test("LOCAL-EXEC-007: never redefines ExecutionMode, ExecutionPolicy, DeviceRegistration, DeviceCapabilitySnapshot, DeviceCapabilityReadiness, or LocalWorkerRegistration - composes local-execution.ts unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /export\s+(type|interface)\s+ExecutionMode\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+ExecutionPolicy\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+DeviceRegistration\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+DeviceCapabilitySnapshot\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+DeviceCapabilityReadiness\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+LocalWorkerRegistration\b/);
  assert.match(content, /import\s*\{\s*resolveEligibleLocalWorkers\s*\}\s*from\s*["']\.\/local-execution\.js["']/);
});

test("LOCAL-EXEC-007: resolveEligibleLocalWorkersUnderKillSwitch checks killSwitch.engaged before ever delegating to resolveEligibleLocalWorkers, never a second routing engine", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function resolveEligibleLocalWorkersUnderKillSwitch");
  assert.ok(fnStart >= 0, "resolveEligibleLocalWorkersUnderKillSwitch not found");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const engagedCheckIndex = fnBody.indexOf("input.killSwitch.engaged");
  const delegateCallIndex = fnBody.indexOf("return resolveEligibleLocalWorkers(");
  assert.ok(engagedCheckIndex >= 0 && delegateCallIndex >= 0, "expected both the engaged check and the delegation call present");
  assert.ok(engagedCheckIndex < delegateCallIndex, "the engaged check must run before delegating to resolveEligibleLocalWorkers");
  assert.doesNotMatch(content, /class\s+\w*Router\b/i);
});

test("LOCAL-EXEC-007: a kill switch is only ever constructed disengaged - no exported function can produce an already-engaged one", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function createLocalExecutionKillSwitch");
  assert.ok(fnStart >= 0, "createLocalExecutionKillSwitch not found");
  const fnBody = content.slice(fnStart, content.indexOf("\n}", fnStart));
  assert.match(fnBody, /engaged:\s*false/);
});

test("LOCAL-EXEC-007 (Brain Rev125 correction): disengageLocalExecutionKillSwitch requires requireSameTenant and requireProtectedActionAuthorization before ever mutating the switch - disengagement is no longer freely callable", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function disengageLocalExecutionKillSwitch");
  assert.ok(fnStart >= 0, "disengageLocalExecutionKillSwitch not found");
  const bodyStart = content.indexOf("): LocalExecutionKillSwitch {", fnStart);
  assert.ok(bodyStart >= 0, "disengageLocalExecutionKillSwitch's body opening not found");
  const fnBody = content.slice(bodyStart, content.indexOf("\n}", bodyStart));
  const tenantCheckIndex = fnBody.indexOf("requireSameTenant(");
  const authorityCheckIndex = fnBody.indexOf("requireProtectedActionAuthorization(");
  const returnIndex = fnBody.indexOf("return {");
  assert.ok(tenantCheckIndex >= 0, "expected an explicit requireSameTenant check");
  assert.ok(authorityCheckIndex >= 0, "expected an explicit requireProtectedActionAuthorization check");
  assert.ok(returnIndex >= 0, "expected the disengaged switch to be returned");
  assert.ok(
    tenantCheckIndex < returnIndex && authorityCheckIndex < returnIndex,
    "both the tenant and protected-action authority checks must run before the switch is ever disengaged",
  );
  assert.match(content, /import\s*\{\s*requireSameTenant,\s*requireProtectedActionAuthorization\s*\}\s*from\s*["']\.\/authority\.js["']/);
});

test("LOCAL-EXEC-007: engageLocalExecutionKillSwitch requires no AuthorityContext/protected-action authorization at all - only the narrowing direction (disengage) needs it, mirroring this codebase's own established asymmetric-authority precedent", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function engageLocalExecutionKillSwitch");
  assert.ok(fnStart >= 0, "engageLocalExecutionKillSwitch not found");
  const nextExportIndex = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextExportIndex >= 0 ? nextExportIndex : undefined);
  assert.doesNotMatch(fnBody, /requireProtectedActionAuthorization\(/);
});

test("LOCAL-EXEC-007 (independent-review fix): planExecutionModeTransition validates from/to via an equality-based Set membership check (isRecognizedExecutionMode) before ever indexing the EXECUTION_MODE_RANK object literal, so a prototype-chain key (e.g. 'constructor') cannot bypass fail-closed validation", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function planExecutionModeTransition");
  assert.ok(fnStart >= 0, "planExecutionModeTransition not found");
  const bodyStart = content.indexOf("): ExecutionModeTransitionPlan {", fnStart);
  assert.ok(bodyStart >= 0, "planExecutionModeTransition's body opening not found");
  const fnBody = content.slice(bodyStart, content.indexOf("\n}", bodyStart));
  const guardCheckIndex = fnBody.indexOf("isRecognizedExecutionMode(input.from)");
  const rankIndexIndex = fnBody.indexOf("EXECUTION_MODE_RANK[from]");
  assert.ok(guardCheckIndex >= 0, "expected an explicit isRecognizedExecutionMode guard");
  assert.ok(rankIndexIndex >= 0, "expected EXECUTION_MODE_RANK to be indexed after validation");
  assert.ok(guardCheckIndex < rankIndexIndex, "the recognized-mode guard must run before the rank table is ever indexed");
  const guardFnStart = content.indexOf("function isRecognizedExecutionMode");
  assert.ok(guardFnStart >= 0, "isRecognizedExecutionMode not found");
  const guardFnBody = content.slice(guardFnStart, content.indexOf("\n}", guardFnStart));
  assert.match(guardFnBody, /RECOGNIZED_EXECUTION_MODES\.has\(/, "expected a Set.has() membership check, not an object-key existence check");
});

test("LOCAL-EXEC-007 (Brain Rev125 correction): planExecutionModeTransition's NARROWING branch checks supplied activeLeases for non-terminal status and externalEffectStates for UNKNOWN before ever returning a NARROWING plan - it is no longer pure classification", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const bodyStart = content.indexOf("): ExecutionModeTransitionPlan {", content.indexOf("export function planExecutionModeTransition"));
  assert.ok(bodyStart >= 0, "planExecutionModeTransition's body opening not found");
  const fnBody = content.slice(bodyStart, content.indexOf("\n}", bodyStart));
  const narrowingBranchStart = fnBody.indexOf('if (toRank < fromRank) {');
  assert.ok(narrowingBranchStart >= 0, "expected the toRank < fromRank (NARROWING) branch");
  const narrowingBranch = fnBody.slice(narrowingBranchStart);
  const leaseCheckIndex = narrowingBranch.indexOf("TERMINAL_LEASE_STATUSES.has(lease.status)");
  const effectCheckIndex = narrowingBranch.indexOf('externalEffectStates.includes("UNKNOWN")');
  const narrowingReturnIndex = narrowingBranch.indexOf('direction: "NARROWING"');
  assert.ok(leaseCheckIndex >= 0, "expected an explicit non-terminal lease check");
  assert.ok(effectCheckIndex >= 0, "expected an explicit UNKNOWN external-effect-state check");
  assert.ok(narrowingReturnIndex >= 0, "expected a NARROWING plan to be returned");
  assert.ok(
    leaseCheckIndex < narrowingReturnIndex && effectCheckIndex < narrowingReturnIndex,
    "both safety checks must run before a NARROWING plan is ever returned",
  );
});

test("LOCAL-EXEC-007 (Brain Rev129 correction): ExecutionModeTransitionPlan.safetyCheckScope is NOT_APPLICABLE for every direction except NARROWING, and CHECKED_SUPPLIED_FACTS_ONLY (never a stronger/authoritative-sounding value) for NARROWING - the honest limit is structural, not only prose", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const ifaceStart = content.indexOf("export interface ExecutionModeTransitionPlan");
  assert.ok(ifaceStart >= 0, "ExecutionModeTransitionPlan not found");
  const ifaceBody = content.slice(ifaceStart, content.indexOf("}", ifaceStart));
  assert.match(ifaceBody, /safetyCheckScope:\s*ExecutionModeSafetyCheckScope/, "expected a safetyCheckScope field typed as ExecutionModeSafetyCheckScope");
  const typeStart = content.indexOf("export type ExecutionModeSafetyCheckScope");
  assert.ok(typeStart >= 0, "ExecutionModeSafetyCheckScope not found");
  const typeLine = content.slice(typeStart, content.indexOf(";", typeStart));
  assert.match(typeLine, /"NOT_APPLICABLE"/);
  assert.match(typeLine, /"CHECKED_SUPPLIED_FACTS_ONLY"/);
  const bodyStart = content.indexOf("): ExecutionModeTransitionPlan {", content.indexOf("export function planExecutionModeTransition"));
  const fnBody = content.slice(bodyStart, content.indexOf("\n}", bodyStart));
  const unchangedReturn = fnBody.slice(fnBody.indexOf('direction: "UNCHANGED"'), fnBody.indexOf('direction: "UNCHANGED"') + 200);
  const wideningReturn = fnBody.slice(fnBody.indexOf('direction: "WIDENING"'), fnBody.indexOf('direction: "WIDENING"') + 200);
  const lateralReturn = fnBody.slice(fnBody.indexOf('direction: "LATERAL"'), fnBody.indexOf('direction: "LATERAL"') + 200);
  const narrowingReturn = fnBody.slice(fnBody.indexOf('direction: "NARROWING"'), fnBody.indexOf('direction: "NARROWING"') + 200);
  assert.match(unchangedReturn, /safetyCheckScope:\s*"NOT_APPLICABLE"/);
  assert.match(wideningReturn, /safetyCheckScope:\s*"NOT_APPLICABLE"/);
  assert.match(lateralReturn, /safetyCheckScope:\s*"NOT_APPLICABLE"/);
  assert.match(narrowingReturn, /safetyCheckScope:\s*"CHECKED_SUPPLIED_FACTS_ONLY"/);
});

test("LOCAL-EXEC-007: planExecutionModeTransition's return type carries no collaborationMode field - it cannot alter CollaborationMode even by construction", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const ifaceStart = content.indexOf("export interface ExecutionModeTransitionPlan");
  assert.ok(ifaceStart >= 0, "ExecutionModeTransitionPlan not found");
  const ifaceBody = content.slice(ifaceStart, content.indexOf("}", ifaceStart));
  assert.doesNotMatch(ifaceBody, /collaborationMode/i);
});

test("LOCAL-EXEC-007: projectLocalWorkerHealth validates worker/device/snapshot cross-references before ever building the projection", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function projectLocalWorkerHealth");
  assert.ok(fnStart >= 0, "projectLocalWorkerHealth not found");
  const fnBody = content.slice(fnStart);
  const deviceIdCheckIndex = fnBody.indexOf("input.worker.deviceId !== input.device.deviceId");
  const tenantIdCheckIndex = fnBody.indexOf("input.worker.tenantId !== input.device.tenantId");
  const snapshotCheckIndex = fnBody.indexOf("input.latestSnapshot.deviceId !== input.device.deviceId");
  const baseBuildIndex = fnBody.indexOf("const base:");
  assert.ok(
    deviceIdCheckIndex >= 0 && tenantIdCheckIndex >= 0 && snapshotCheckIndex >= 0 && baseBuildIndex >= 0,
    "expected all three cross-reference checks and the base-projection construction present",
  );
  assert.ok(
    deviceIdCheckIndex < baseBuildIndex && tenantIdCheckIndex < baseBuildIndex && snapshotCheckIndex < baseBuildIndex,
    "every cross-reference check must run before the projection is ever built",
  );
});

test("LOCAL-EXEC-007: resolveLocalDeviceHeartbeatFreshness never reads the system clock - asOf is always caller-supplied", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function resolveLocalDeviceHeartbeatFreshness");
  const fnBody = content.slice(fnStart, content.indexOf("\n}", fnStart));
  assert.doesNotMatch(fnBody, /Date\.now\(\)|new Date\(\)/);
});

test("LOCAL-EXEC-007: never calls fetch, a node: builtin, or the system clock - pure domain composition only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)|new Date\(/);
});

test("LOCAL-EXEC-007: no credential/secret-shaped literal anywhere in this module", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /password|api[_-]?key|secret[_-]?token/i);
});

test("LOCAL-EXEC-007: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(LocalExecutionHardening).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidExecutionModeTransitionError",
    "InvalidKillSwitchTransitionError",
    "InvalidLocalExecutionHardeningError",
    "createLocalExecutionKillSwitch",
    "disengageLocalExecutionKillSwitch",
    "engageLocalExecutionKillSwitch",
    "planExecutionModeTransition",
    "projectLocalWorkerHealth",
    "resolveEligibleLocalWorkersUnderKillSwitch",
    "resolveLocalDeviceHeartbeatFreshness",
  ]);
});

test("LOCAL-EXEC-007: package.json still declares no new runtime dependency", () => {
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
