import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createCustomer } from "../../src/domain/customer.js";
import { createProject } from "../../src/domain/project.js";
import { createProjectOwnershipRef } from "../../src/domain/project-ownership.js";
import { createOrganization, activateOrganization } from "../../src/domain/organization.js";
import { createOrganizationMembership } from "../../src/domain/organization-membership.js";
import { createOrganizationResourceBinding } from "../../src/domain/organization-resource-binding.js";
import { FileDurableOrganizationResourceBindingStore } from "../../src/domain/durable-organization-resource-binding-store.js";

/**
 * KNOWLEDGE-EVIDENCE-DURABLE-001 CI correction (PR #167 batch-merge-review,
 * systemic torn-read finding): standalone worker process (not a test
 * itself), spawned by durable-organization-resource-binding-store-
 * concurrency.test.ts as a real, separate OS process - proving the
 * "append-log" persistence pattern class (a per-record `linkSync` creation
 * lock arbitrates exactly one winner per record id, then every winner
 * appends to a SHARED per-tenant `.jsonl` file) is safe under genuine
 * multi-process concurrency: each worker both `putIfAbsent`s a DIFFERENT
 * organizationId AND reads via `get` in the same racing window, proving no
 * reader ever observes a torn file and no writer's append is lost.
 *
 * `FileDurableProtectedDecisionRecordStore` shares this exact same
 * primitive (per-id `linkSync` creation lock + shared-file `appendFileSync`
 * + the new per-tenant `withTenantFileLock`), so this one witness stands
 * for both per Brain's own instruction not to duplicate a test per class
 * when several components share exactly the same primitive.
 *
 * usage: node organization-resource-binding-store-race-worker.js <storeDir>
 *   <readyFile> <goFile> <tenantId> <organizationId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, tenantId, organizationId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tenantId === undefined ||
  organizationId === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: organization-resource-binding-store-race-worker.js <storeDir> <readyFile> <goFile> <tenantId> <organizationId> <workerLabel>",
  );
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const tenantScope = createTenantScope(tenantId);
  const customer = createCustomer({ tenantScope, customerId: `customer-${workerLabel}`, displayName: "Race Customer" });
  const project = createProject({ tenantScope, customer, projectId: `project-${workerLabel}`, ownerRef: `owner-${workerLabel}`, state: "ACTIVE" });
  const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId });
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId,
      tenantScope,
      displayName: `Race Org ${workerLabel}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    activatedAt: "2026-01-01T00:05:00.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: `membership-${workerLabel}`,
    tenantScope,
    principalRef: `principal-${workerLabel}`,
    role: "STAFF",
  });
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });

  const store = new FileDurableOrganizationResourceBindingStore(storeDir);
  const result = store.putIfAbsent(tenantScope.tenantId, organizationId, binding);
  // Interleave a read in the same racing window - an unlocked/torn read
  // would throw CorruptedOrganizationResourceBindingLineError here.
  const fetched = store.get(tenantScope.tenantId, organizationId);
  if (fetched === undefined || fetched.organizationId !== organizationId) {
    throw new Error(`worker ${workerLabel}: get() did not return the just-written binding`);
  }
  process.stdout.write(JSON.stringify({ label: workerLabel, created: result.created }));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
