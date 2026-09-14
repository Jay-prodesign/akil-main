import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OutcomeJobRoutingExecution from "../src/domain/outcome-job-routing-execution.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/outcome-job-routing-execution.ts";
const OUTCOME_JOB_FILE = "src/domain/outcome-job.ts";

test("outcome-job-routing-execution: never redefines OutcomeJob, OutcomeJobState, or WorkerRoutingDecision - composes the existing modules unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /export\s+(type|interface)\s+OutcomeJob\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+OutcomeJobState\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+WorkerRoutingDecision\b/);
  assert.match(content, /import\s*\{[^}]*transitionOutcomeJob[^}]*\}\s*from\s*["']\.\/outcome-job\.js["']/);
});

test("outcome-job-routing-execution: authorizeOutcomeJobExecutionFromRouting delegates the actual transition to the existing transitionOutcomeJob rather than reimplementing state assignment", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function authorizeOutcomeJobExecutionFromRouting");
  assert.ok(fnStart >= 0, "authorizeOutcomeJobExecutionFromRouting not found");
  const fnBody = content.slice(fnStart);
  assert.match(fnBody, /transitionOutcomeJob\(/);
  assert.doesNotMatch(fnBody, /state:\s*["']EXECUTING["']/);
});

test("outcome-job-routing-execution: the assignment check runs before the transition call, so an unrouted execution attempt never even reaches transitionOutcomeJob", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function authorizeOutcomeJobExecutionFromRouting");
  const fnBody = content.slice(fnStart);
  const assignmentCheckIndex = fnBody.indexOf("isRoutedExecutionAssignmentValidForJob(");
  const transitionCallIndex = fnBody.indexOf("transitionOutcomeJob(");
  assert.ok(assignmentCheckIndex >= 0 && transitionCallIndex >= 0);
  assert.ok(assignmentCheckIndex < transitionCallIndex, "the assignment must be validated before the transition is attempted");
});

test("outcome-job-routing-execution: this checkpoint leaves outcome-job.ts's own MAIN_PATH_TRANSITIONS untouched - READY -> EXECUTING still exists there exactly as AKI-BE-001 left it", () => {
  const outcomeJobContent = readFileSync(join(REPO_ROOT, OUTCOME_JOB_FILE), "utf8");
  assert.match(outcomeJobContent, /\["READY",\s*new Set<OutcomeJobState>\(\["EXECUTING"\]\)\]/);
});

test("outcome-job-routing-execution: createRoutedExecutionAssignment rejects any decision.status other than ROUTED before binding any field", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function createRoutedExecutionAssignment");
  const fnBody = content.slice(fnStart);
  assert.match(fnBody, /decision\.status\s*!==\s*["']ROUTED["']/);
});

test("outcome-job-routing-execution: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(OutcomeJobRoutingExecution).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidRoutedExecutionAssignmentError",
    "OutcomeJobExecutionNotRoutedError",
    "authorizeOutcomeJobExecutionFromRouting",
    "createRoutedExecutionAssignment",
    "isRoutedExecutionAssignmentValidForJob",
  ]);
});
