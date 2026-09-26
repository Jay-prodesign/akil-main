import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function importedSpecifiers(content: string): string[] {
  return [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "raw secret/credential field", pattern: /\b(apiKey|api_key|clientSecret|client_secret|privateKey|private_key|accessToken|access_token)\b/ },
  { label: "network/HTTP client", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest|axios)\b/ },
  { label: "generic agent/workflow framework coupling", pattern: /\b(LangChain|AutoGPT|CrewAI|Temporal|BullMQ)\b/ },
  { label: "AI Commerce coupling", pattern: /\b(AICommerce|AiCommerce|ai-commerce)\b/ },
];

const OS_V0_05_SOURCE_FILES = [
  "src/domain/outcome-job-execution-event.ts",
  "src/domain/outcome-job-execution-run-state.ts",
  "src/domain/durable-outcome-job-execution-store.ts",
  "src/ports/async-outcome-job-execution-store.ts",
  "src/domain/postgres-outcome-job-execution-store.ts",
  "src/application/outcome-job-execution-runtime.ts",
];

test("boundary: no OS-V0-05 source file introduces a secret-shaped field, network client, or generic agent/workflow/AI-Commerce coupling", () => {
  for (const relativePath of OS_V0_05_SOURCE_FILES) {
    const content = readRepoFile(relativePath);
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${relativePath}`);
    }
  }
});

test("boundary: package.json declares no new runtime dependency and no new devDependency", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});

test("boundary: outcome-job-execution-event.ts and outcome-job-execution-run-state.ts import only their own declared domain dependencies", () => {
  const eventContent = readRepoFile("src/domain/outcome-job-execution-event.ts");
  const eventAllowed = ["./tenant-scope.js", "./customer.js", "./project.js", "./outcome-job.js"];
  for (const specifier of importedSpecifiers(eventContent)) {
    assert.ok(eventAllowed.includes(specifier), `unexpected import in outcome-job-execution-event.ts: ${specifier}`);
  }

  const runStateContent = readRepoFile("src/domain/outcome-job-execution-run-state.ts");
  const runStateAllowed = ["./tenant-scope.js", "./customer.js", "./project.js", "./outcome-job.js", "./outcome-job-execution-event.js"];
  for (const specifier of importedSpecifiers(runStateContent)) {
    assert.ok(runStateAllowed.includes(specifier), `unexpected import in outcome-job-execution-run-state.ts: ${specifier}`);
  }
});

test("boundary: neither outcome-job-execution-event.ts nor outcome-job-execution-run-state.ts reads the clock, randomness, or performs I/O - both are pure", () => {
  for (const relativePath of [
    "src/domain/outcome-job-execution-event.ts",
    "src/domain/outcome-job-execution-run-state.ts",
  ]) {
    const content = readRepoFile(relativePath);
    const impureMarkers = [/Date\.now\(\)/, /new Date\(\)/, /Math\.random\(\)/, /node:fs/, /node:http/];
    for (const marker of impureMarkers) {
      assert.equal(marker.test(content), false, `${relativePath} must be pure - found ${marker}`);
    }
  }
});

test("boundary: the runtime composition layer never calls verifyOutcomeJob directly - SUCCEEDED can only ever reach VERIFYING", () => {
  const content = readRepoFile("src/application/outcome-job-execution-runtime.ts");
  assert.equal(content.includes("verifyOutcomeJob("), false, "the runtime must never itself call verifyOutcomeJob(...)");
  assert.ok(content.includes('transitionOutcomeJob(job, "VERIFYING")'), "the only OutcomeJob transition this runtime may perform is EXECUTING -> VERIFYING");
  assert.equal(/transitionOutcomeJob\([^)]*"VERIFIED"/.test(content), false, "the runtime must never call transitionOutcomeJob(..., \"VERIFIED\")");
});

test("boundary: worker-invoker.ts's extension is purely additive - taskId/branch/checkpointSha are untouched, outcomeJobExecution is optional", () => {
  const content = readRepoFile("src/domain/worker-invoker.ts");
  assert.ok(/readonly taskId: string;/.test(content));
  assert.ok(/readonly branch: string;/.test(content));
  assert.ok(/readonly checkpointSha: string;/.test(content));
  assert.ok(/readonly outcomeJobExecution\?: OutcomeJobExecutionInvocationContext;/.test(content));
});

test("boundary: migration 0002 is additive only and does not reference DROP/ALTER against outcome_jobs (0001's own table)", () => {
  const migration = readRepoFile("migrations/0002_outcome_job_execution_events.sql");
  assert.ok(migration.includes("CREATE TABLE IF NOT EXISTS outcome_job_execution_events"));
  assert.equal(/DROP\s+TABLE/i.test(migration), false);
  assert.equal(/ALTER\s+TABLE\s+outcome_jobs\b/i.test(migration), false, "0002 must not alter 0001's own outcome_jobs table");

  const priorMigration = readRepoFile("migrations/0001_outcome_jobs.sql");
  assert.ok(priorMigration.includes("CREATE TABLE IF NOT EXISTS outcome_jobs"), "0001 must remain unmodified");
});

test("boundary: postgres-outcome-job-execution-store.ts imports only the sql-client port and its own domain dependencies, never a concrete driver package", () => {
  const content = readRepoFile("src/domain/postgres-outcome-job-execution-store.ts");
  const allowed = [
    "./tenant-scope.js",
    "./customer.js",
    "./project.js",
    "./outcome-job.js",
    "./outcome-job-execution-event.js",
    "./outcome-job-execution-run-state.js",
    "../ports/async-outcome-job-execution-store.js",
    "../ports/sql-client.js",
  ];
  for (const specifier of importedSpecifiers(content)) {
    assert.ok(allowed.includes(specifier), `unexpected import in postgres-outcome-job-execution-store.ts: ${specifier}`);
  }
  for (const driverName of ["\"pg\"", "'pg'", "postgres\"", "node-postgres"]) {
    assert.equal(content.includes(driverName), false, `must not import a concrete driver (${driverName})`);
  }
});
