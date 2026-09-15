import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as AuthorizedOutcomeJobOperations from "../src/application/authorized-outcome-job-operations.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/application/authorized-outcome-job-operations.ts";

test("Rev111: authorizedTransitionOutcomeJob's own source rejects CLOSED before ever calling transitionOutcomeJob", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function authorizedTransitionOutcomeJob");
  assert.ok(fnStart >= 0, "authorizedTransitionOutcomeJob not found");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const closedCheckIndex = fnBody.indexOf('to === "CLOSED"');
  const transitionCallIndex = fnBody.indexOf("transitionOutcomeJob(job, to)");
  assert.ok(closedCheckIndex >= 0, "expected an explicit CLOSED rejection check");
  assert.ok(transitionCallIndex >= 0, "expected the ordinary transition call");
  assert.ok(closedCheckIndex < transitionCallIndex, "CLOSED must be rejected before the ordinary transition is ever attempted");
});

test("Rev111: authorizedCloseOutcomeJobWithApproval requires protected-action authorization before delegating to closeOutcomeJobWithApproval", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function authorizedCloseOutcomeJobWithApproval");
  assert.ok(fnStart >= 0, "authorizedCloseOutcomeJobWithApproval not found");
  const fnBody = content.slice(fnStart);
  const protectedCheckIndex = fnBody.indexOf("requireProtectedActionAuthorization(");
  const closeCallIndex = fnBody.indexOf("closeOutcomeJobWithApproval(");
  assert.ok(protectedCheckIndex >= 0 && closeCallIndex >= 0);
  assert.ok(protectedCheckIndex < closeCallIndex, "protected-action authorization must be required before the approval-gated closure is even attempted");
});

test("Rev111: this module never assigns state: \"CLOSED\" directly - every closure is delegated to the existing outcome-job-closure-approval.ts gate", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /state:\s*["']CLOSED["']/);
});

test("Brain Rev114/115/116: authorizedTransitionOutcomeJob's own source rejects a missing/mismatched ExecutionRoutingRequirement, and rejects ROUTING_REQUIRED, both before ever calling transitionOutcomeJob", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function authorizedTransitionOutcomeJob(");
  assert.ok(fnStart >= 0, "authorizedTransitionOutcomeJob not found");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const missingCheckIndex = fnBody.indexOf("executionRoutingRequirement === undefined");
  const routingRequiredCheckIndex = fnBody.indexOf('policy === "ROUTING_REQUIRED"');
  const transitionCallIndex = fnBody.indexOf("transitionOutcomeJob(job, to)");
  assert.ok(missingCheckIndex >= 0, "expected an explicit missing/mismatched ExecutionRoutingRequirement check");
  assert.ok(routingRequiredCheckIndex >= 0, "expected an explicit ROUTING_REQUIRED rejection check");
  assert.ok(transitionCallIndex >= 0, "expected the ordinary transition call");
  assert.ok(missingCheckIndex < transitionCallIndex, "a missing/mismatched requirement must be rejected before the ordinary transition is ever attempted");
  assert.ok(routingRequiredCheckIndex < transitionCallIndex, "ROUTING_REQUIRED must be rejected before the ordinary transition is ever attempted");
});

test("Brain Rev114/115/116: authorizedTransitionOutcomeJobToExecutingViaRouting delegates entirely to the existing, unmodified authorizeOutcomeJobExecutionFromRouting - it does not re-implement the routing check", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function authorizedTransitionOutcomeJobToExecutingViaRouting");
  assert.ok(fnStart >= 0, "authorizedTransitionOutcomeJobToExecutingViaRouting not found");
  const fnBody = content.slice(fnStart);
  assert.ok(fnBody.indexOf("authorizeOutcomeJobExecutionFromRouting(") >= 0);
});

test("Rev111: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(AuthorizedOutcomeJobOperations).sort();
  assert.deepEqual(exportedKeys, [
    "ClosureRequiresApprovalGateError",
    "ExecutionRequiresRoutingGateError",
    "MissingExecutionRoutingRequirementError",
    "authorizedCloseOutcomeJobWithApproval",
    "authorizedTransitionOutcomeJob",
    "authorizedTransitionOutcomeJobToExecutingViaRouting",
    "authorizedVerifyOutcomeJob",
  ]);
});
