import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OutcomeJobClosureApproval from "../src/domain/outcome-job-closure-approval.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/outcome-job-closure-approval.ts";
const OUTCOME_JOB_FILE = "src/domain/outcome-job.ts";

test("outcome-job-closure-approval: never redefines OutcomeJob or its state type - composes the existing module unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /export\s+(type|interface)\s+OutcomeJob\b/);
  assert.doesNotMatch(content, /export\s+(type|interface)\s+OutcomeJobState\b/);
  assert.match(content, /import\s*\{[^}]*transitionOutcomeJob[^}]*\}\s*from\s*["']\.\/outcome-job\.js["']/);
});

test("outcome-job-closure-approval: closeOutcomeJobWithApproval delegates the actual transition to the existing transitionOutcomeJob rather than reimplementing state assignment", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function closeOutcomeJobWithApproval");
  assert.ok(fnStart >= 0, "closeOutcomeJobWithApproval not found");
  const fnBody = content.slice(fnStart);
  assert.match(fnBody, /transitionOutcomeJob\(/);
  assert.doesNotMatch(fnBody, /state:\s*["']CLOSED["']/);
});

test("outcome-job-closure-approval: the approval check runs before the transition call, so an unapproved closure never even reaches transitionOutcomeJob", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function closeOutcomeJobWithApproval");
  const fnBody = content.slice(fnStart);
  const approvalCheckIndex = fnBody.indexOf("isClosureApprovalValidForJob(");
  const transitionCallIndex = fnBody.indexOf("transitionOutcomeJob(");
  assert.ok(approvalCheckIndex >= 0 && transitionCallIndex >= 0);
  assert.ok(approvalCheckIndex < transitionCallIndex, "approval must be validated before the transition is attempted");
});

test("outcome-job-closure-approval: this checkpoint leaves outcome-job.ts's own MAIN_PATH_TRANSITIONS untouched - VERIFIED -> CLOSED still exists there exactly as AKI-BE-001 left it", () => {
  const outcomeJobContent = readFileSync(join(REPO_ROOT, OUTCOME_JOB_FILE), "utf8");
  assert.match(outcomeJobContent, /\["VERIFIED",\s*new Set<OutcomeJobState>\(\["CLOSED"\]\)\]/);
});

test("outcome-job-closure-approval: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(OutcomeJobClosureApproval).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidClosureApprovalReferenceError",
    "OutcomeJobClosureNotApprovedError",
    "closeOutcomeJobWithApproval",
    "createClosureApprovalReference",
    "isClosureApprovalValidForJob",
  ]);
});
