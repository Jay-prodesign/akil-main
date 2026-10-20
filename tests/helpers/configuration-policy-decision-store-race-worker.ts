import { existsSync, writeFileSync } from "node:fs";
import type { TenantScope } from "../../src/domain/tenant-scope.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../../src/domain/durable-configuration-policy-decision-store.js";
import { resolveAndProjectConfigurationPolicyDecision } from "../../src/domain/resolve-and-project-configuration-policy-decision.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction (PR #167 batch-merge-review,
 * systemic torn-read finding, Brain's own special-attention item - "this
 * class needs an explicit concurrency review rather than assuming the
 * Project-store fix generalizes"): standalone worker process (not a test
 * itself), spawned by durable-configuration-policy-decision-store-
 * concurrency.test.ts as a real, separate OS process. Each worker appends
 * a DIFFERENT decisionId (via a different `sourceRef`, producing a
 * genuinely different resolution so each append is a real new entry, not
 * an idempotent no-op) to the SAME shared `(tenantId, decisionKey)`
 * decision-log file - proving the per-decisionId creation lock plus the
 * new per-`(tenantId, decisionKey)` file lock together prevent both a lost
 * append and a torn read, where the pre-existing per-decisionId lock alone
 * did not coordinate access to the shared file itself.
 *
 * usage: node configuration-policy-decision-store-race-worker.js <storeDir>
 *   <readyFile> <goFile> <tenantId> <customerId> <projectId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, customerId, projectId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  customerId === undefined ||
  projectId === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: configuration-policy-decision-store-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <customerId> <projectId> <workerLabel>",
  );
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const store = new FileDurableConfigurationPolicyDecisionStore(storeDir);
  const identity = {
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as never,
    projectId: projectId as never,
  };
  const { entry } = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [
      {
        kind: "CONFIG",
        key: "feature-flags",
        scope: "PROJECT",
        sourceRef: `cfg-src-${workerLabel}`,
        version: "v1",
        identity,
      },
    ],
    decisionId: `decision-race-${workerLabel}`,
    now: "2026-01-02T00:00:00.000Z",
  });
  // Interleave a read in the same racing window - an unlocked/torn read
  // would throw CorruptedConfigurationPolicyDecisionLineError here.
  const history = store.getDecisionProjectionHistory(tenantId as TenantScope["tenantId"], entry.decisionKey);
  if (!history.some((e) => e.decisionId === entry.decisionId)) {
    throw new Error(`worker ${workerLabel}: history did not include the just-appended decision`);
  }
  process.stdout.write(JSON.stringify({ label: workerLabel, decisionId: entry.decisionId }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
