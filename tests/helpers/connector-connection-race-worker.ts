import { existsSync, writeFileSync } from "node:fs";
import { createProjectOwnershipRef } from "../../src/domain/project-ownership.js";
import { createConnectionRequirement } from "../../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
} from "../../src/domain/integration-connector-catalog.js";
import {
  FileDurableConnectorConnectionStore,
  ConnectorConnectionVersionConflictError,
} from "../../src/domain/durable-connector-connection-store.js";

/**
 * Rev94 F1: standalone worker process (not a test itself) spawned by
 * durable-connector-connection-store-concurrency.test.ts as a real,
 * separate OS process. Node's own synchronous single-threaded execution
 * cannot reproduce a true concurrent-writer race in-process, so proving
 * the `linkSync`-based lock's cross-process mutual exclusion requires
 * genuinely concurrent processes racing to update the exact same stored
 * connector connection.
 *
 * usage: node connector-connection-race-worker.js <storeDir> <readyFile>
 *   <goFile> <tenantId> <connectionBindingId> <connectionRequirementId>
 *   <workerLabel> <expectedVersion|none>
 */
const [
  ,
  ,
  storeDir,
  readyFile,
  goFile,
  tenantId,
  connectionBindingId,
  connectionRequirementId,
  workerLabel,
  expectedVersionArg,
] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  connectionBindingId === undefined ||
  connectionRequirementId === undefined ||
  workerLabel === undefined ||
  expectedVersionArg === undefined
) {
  throw new Error(
    "usage: connector-connection-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <connectionBindingId> <connectionRequirementId> <workerLabel> <expectedVersion|none>",
  );
}

const expectedVersion = expectedVersionArg === "none" ? undefined : Number(expectedVersionArg);

const ownership = createProjectOwnershipRef({
  tenantId,
  customerId: `customer-${tenantId}`,
  projectId: `project-${tenantId}`,
});
const descriptor = createConnectorDescriptor({
  connectorKind: "GITHUB",
  displayName: "GitHub",
  supportedAuthModes: ["OAUTH2"],
  capabilityRefs: ["cap:repo-access"],
  isAiModelProvider: false,
  requiresOAuthRedirect: true,
});
const requirement = createConnectionRequirement({
  connectionRequirementId,
  ownership,
  requiredCapabilityRef: "cap:repo-access",
  purpose: "race test purpose",
  accountOwner: "AKILTA_MANAGED",
  minimumProviderScope: [],
  connectionMethod: "api",
  validationRequirement: "must respond 200",
});
const instance = requestConnectorConnection({
  requirement,
  connectorDescriptor: descriptor,
  connectionBindingId,
  workspaceRef: `workspace-${workerLabel}`,
  integrationInstanceRef: `instance-${workerLabel}`,
  delegatedScope: [],
  authMode: "OAUTH2",
});

// Announce readiness, then busy-wait for the parent's synchronized "go"
// signal so every racing worker attempts save() within the same tight
// window, maximizing genuine OS-level contention on the lock.
writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableConnectorConnectionStore(storeDir);
try {
  const result = store.save(instance, expectedVersion);
  process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success", version: result.version }));
  process.exit(0);
} catch (error) {
  if (error instanceof ConnectorConnectionVersionConflictError) {
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "conflict" }));
    process.exit(0);
  }
  process.stderr.write(String(error));
  process.exit(1);
}
