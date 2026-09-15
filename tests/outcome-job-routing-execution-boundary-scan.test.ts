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

test("Brain Rev121: createExecutionRoutingRequirementRegistry's admitRoutingRequiredFromAssignment requires a real, job-bound RoutedExecutionAssignment (via isRoutedExecutionAssignmentValidForJob) before ever admitting a ROUTING_REQUIRED requirement - an unrelated/unbound decision can no longer satisfy this", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function createExecutionRoutingRequirementRegistry");
  assert.ok(fnStart >= 0, "createExecutionRoutingRequirementRegistry not found");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const methodStart = fnBody.indexOf("admitRoutingRequiredFromAssignment(input) {");
  assert.ok(methodStart >= 0, "admitRoutingRequiredFromAssignment not found");
  const validityCheckIndex = fnBody.indexOf("isRoutedExecutionAssignmentValidForJob(input.assignment, input.job)", methodStart);
  const admitCallIndex = fnBody.indexOf("admit(input.job,", methodStart);
  assert.ok(validityCheckIndex >= 0, "expected an explicit isRoutedExecutionAssignmentValidForJob check");
  assert.ok(admitCallIndex >= 0, "expected the requirement to be admitted");
  assert.ok(validityCheckIndex < admitCallIndex, "the assignment-validity check must run before the requirement is ever admitted");
});

test("Brain Rev122: createExecutionRoutingRequirementRegistry's admitManualExecutionAllowedFromServiceCatalogAdmission requires spec.specId === job.jobId, admission.status === ADMITTED, and admission.blueprintId/blueprintVersion to match spec.sourceBlueprintId/sourceBlueprintVersion - not a bare worker/evidenceRef pair - before ever delegating to the shared admit helper (which performs the map write)", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function createExecutionRoutingRequirementRegistry");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const methodStart = fnBody.indexOf("admitManualExecutionAllowedFromServiceCatalogAdmission(input) {");
  assert.ok(methodStart >= 0, "admitManualExecutionAllowedFromServiceCatalogAdmission not found");
  const methodEnd = fnBody.indexOf("\n    },", methodStart);
  const methodBody = fnBody.slice(methodStart, methodEnd >= 0 ? methodEnd : undefined);
  const specIdCheckIndex = methodBody.indexOf("input.spec.specId");
  const statusCheckIndex = methodBody.indexOf('input.admission.status !== "ADMITTED"');
  const blueprintCheckIndex = methodBody.indexOf("input.admission.blueprintId !== input.spec.sourceBlueprintId");
  const admitCallIndex = methodBody.indexOf("return admit(");
  assert.ok(specIdCheckIndex >= 0, "expected an explicit spec.specId === job.jobId check");
  assert.ok(statusCheckIndex >= 0, "expected an explicit admission.status === ADMITTED check");
  assert.ok(blueprintCheckIndex >= 0, "expected an explicit blueprint match check");
  assert.ok(admitCallIndex >= 0, "expected this method to delegate to the shared admit helper");
  assert.ok(
    specIdCheckIndex < admitCallIndex && statusCheckIndex < admitCallIndex && blueprintCheckIndex < admitCallIndex,
    "every authoritative-fact check must run before delegating to admit (which writes the map)",
  );
  assert.doesNotMatch(methodBody.slice(0, admitCallIndex), /admittingWorker/, "the new method must not accept a bare worker parameter at all");
});

test("Brain Rev123/124: admitManualExecutionAllowedFromServiceCatalogAdmission requires admission.executionRoutingPolicy === MANUAL_EXECUTION_ALLOWED before ever delegating to the shared admit helper - catalog trust (status/blueprint match) alone is not sufficient", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function createExecutionRoutingRequirementRegistry");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const methodStart = fnBody.indexOf("admitManualExecutionAllowedFromServiceCatalogAdmission(input) {");
  assert.ok(methodStart >= 0, "admitManualExecutionAllowedFromServiceCatalogAdmission not found");
  const methodEnd = fnBody.indexOf("\n    },", methodStart);
  const methodBody = fnBody.slice(methodStart, methodEnd >= 0 ? methodEnd : undefined);
  const routingPolicyCheckIndex = methodBody.indexOf('input.admission.executionRoutingPolicy !== "MANUAL_EXECUTION_ALLOWED"');
  const admitCallIndex = methodBody.indexOf("return admit(");
  assert.ok(routingPolicyCheckIndex >= 0, "expected an explicit admission.executionRoutingPolicy === MANUAL_EXECUTION_ALLOWED check");
  assert.ok(admitCallIndex >= 0, "expected this method to delegate to the shared admit helper");
  assert.ok(
    routingPolicyCheckIndex < admitCallIndex,
    "the executionRoutingPolicy discriminator check must run before the requirement is ever admitted",
  );
});

test("Brain Rev120: this module no longer imports AuthorityContext/requireProtectedActionAuthorization from authority.js - the initial policy is bound to WorkerRoutingDecision/AdmittedWorker, not a generic tenant-level authority check", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /from\s*["']\.\/authority\.js["']/);
});

test("Brain Rev118/119: createExecutionRoutingRequirementRegistry has no exported free-standing constructor for ExecutionRoutingRequirement - admit (behind the registry closure) is the only way to produce one, so an execution-time caller cannot construct-and-pass a fresh classification", () => {
  const exportedKeys = Object.keys(OutcomeJobRoutingExecution);
  assert.ok(!exportedKeys.includes("createExecutionRoutingRequirement"), "a free-standing constructor must not be exported");
});

test("Brain Rev118/119: admit is immutable once set - attempting to admit a different policy for an already-admitted job throws before ever overwriting the map entry", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function createExecutionRoutingRequirementRegistry");
  const nextFnStart = content.indexOf("export function", fnStart + 1);
  const fnBody = content.slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const alreadyAdmittedThrowIndex = fnBody.indexOf("ExecutionRoutingRequirementAlreadyAdmittedError");
  const setIndex = fnBody.indexOf("admitted.set(");
  assert.ok(alreadyAdmittedThrowIndex >= 0, "expected an ExecutionRoutingRequirementAlreadyAdmittedError guard");
  assert.ok(alreadyAdmittedThrowIndex < setIndex, "the already-admitted guard must run before the map is ever written");
});

test("outcome-job-routing-execution: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(OutcomeJobRoutingExecution).sort();
  assert.deepEqual(exportedKeys, [
    "ExecutionRoutingRequirementAlreadyAdmittedError",
    "InvalidExecutionRoutingRequirementError",
    "InvalidRoutedExecutionAssignmentError",
    "OutcomeJobExecutionNotRoutedError",
    "authorizeOutcomeJobExecutionFromRouting",
    "createExecutionRoutingRequirementRegistry",
    "createRoutedExecutionAssignment",
    "isRoutedExecutionAssignmentValidForJob",
  ]);
});
