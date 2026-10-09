import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { createProjectOwnershipRef } from "../../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
} from "../../src/domain/connection-authority.js";
import {
  bootstrapExternalSaleOutcome,
  createVerifiedExternalCommerceFact,
  deriveCanonicalSaleId,
} from "../../src/domain/external-sale-bootstrap.js";
import { FileDurableExternalSaleBootstrapStore } from "../../src/domain/durable-external-sale-bootstrap-store.js";

/**
 * Rev94 F3: standalone worker process (not a test itself) spawned by
 * durable-external-sale-bootstrap-store-concurrency.test.ts to prove
 * putIfAbsent's cross-process race-honesty under a genuine OS-level
 * duplicate-delivery race (Node's single-threaded in-process execution
 * cannot reproduce this).
 *
 * usage: node sale-bootstrap-race-worker.js <storeDir> <readyFile> <goFile>
 *   <tenantId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, workerLabel] = process.argv;
if (storeDir === undefined || readyFile === undefined || goFile === undefined || tenantId === undefined || workerLabel === undefined) {
  throw new Error("usage: sale-bootstrap-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <workerLabel>");
}

const tenantScope = createTenantScope(tenantId);
const customer = createCustomer({
  tenantScope,
  customerId: `customer-${tenantId}`,
  displayName: "Race Customer",
});
const ownership = createProjectOwnershipRef({
  tenantId,
  customerId: `customer-${tenantId}`,
  projectId: `project-${tenantId}`,
});
const requirement = createConnectionRequirement({
  connectionRequirementId: `req-race-${tenantId}`,
  ownership,
  requiredCapabilityRef: "required-access-connections",
  purpose: "race test purpose",
  accountOwner: "AKILTA_MANAGED",
  minimumProviderScope: [],
  connectionMethod: "OAUTH2",
  validationRequirement: "provider-verified",
});
const requested = createConnectionBinding({
  connectionBindingId: `bind-race-${tenantId}`,
  requirement,
  ownership,
  providerRef: "SHOPIFY",
  workspaceRef: "workspace-race",
  integrationInstanceRef: "instance-race",
  delegatedScope: [],
});
const unverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
const connection = verifyConnectionBinding(unverified, "evidence:provider-handshake");

const fact = createVerifiedExternalCommerceFact({
  tenantScope,
  connection,
  externalOrderRef: "order-race-shared",
  evidenceRef: "evidence:webhook-order-race-shared",
});
const saleId = deriveCanonicalSaleId(fact);

const bootstrapped = bootstrapExternalSaleOutcome({
  tenantScope,
  customer,
  fact,
  jobFamily: "WEBSITE_BUILD",
  businessObjective: "Deliver purchased website build",
});

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

const store = new FileDurableExternalSaleBootstrapStore(storeDir);
const result = store.putIfAbsent(tenantScope.tenantId, saleId, bootstrapped);
process.stdout.write(JSON.stringify({ label: workerLabel, created: result.created, jobId: result.result.job.jobId }));
process.exit(0);
