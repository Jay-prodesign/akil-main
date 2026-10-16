import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createOrganizationMembership } from "../../src/domain/organization-membership.js";
import { FileDurableOrganizationMembershipStore } from "../../src/domain/durable-organization-membership-store.js";

/**
 * ORG-MEMBERSHIP-DURABLE-001: standalone worker process (not a test itself),
 * spawned by durable-organization-membership-store-concurrency.test.ts as a
 * real, separate OS process. Two modes:
 *
 * - "create": each worker creates a DIFFERENT membership (same tenant,
 *   different membershipId) at the same time, proving the per-tenant lock
 *   prevents a torn whole-file read-modify-write from silently losing one
 *   worker's create.
 * - "revoke": each worker races to revoke the SAME pre-existing membership
 *   with the SAME `expectedVersion`, proving the optimistic-concurrency
 *   guard closes a real concurrent-transition hazard a bare in-memory
 *   caller cannot - exactly one worker's revoke can win.
 *
 * usage: node org-membership-race-worker.js <storeDir> <readyFile> <goFile>
 *   <mode> <tenantId> <membershipId> <workerLabel>
 */
const [, , storeDir, readyFile, goFile, mode, tenantId, membershipId, workerLabel] = process.argv;

if (
  storeDir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  mode === undefined ||
  tenantId === undefined ||
  membershipId === undefined ||
  workerLabel === undefined
) {
  throw new Error(
    "usage: org-membership-race-worker.js <storeDir> <readyFile> <goFile> <mode> <tenantId> <membershipId> <workerLabel>",
  );
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const tenantScope = createTenantScope(tenantId);
  const store = new FileDurableOrganizationMembershipStore(storeDir);

  if (mode === "create") {
    const membership = createOrganizationMembership({
      membershipId,
      tenantScope,
      principalRef: `principal-${workerLabel}`,
      role: "STAFF",
    });
    store.create(membership);
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
    process.exit(0);
  }

  if (mode === "revoke") {
    store.revoke({
      tenantId: tenantScope.tenantId,
      membershipId: membershipId as never,
      expectedVersion: 1,
      revokedAt: "2026-10-16T00:00:00.000Z",
      revokedReason: `revoked by worker ${workerLabel}`,
    });
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
    process.exit(0);
  }

  throw new Error(`unknown mode "${mode}"`);
} catch (error) {
  process.stderr.write(String(error));
  process.exit(1);
}
