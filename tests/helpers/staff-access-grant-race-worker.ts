import { existsSync, writeFileSync } from "node:fs";
import { createTenantScope } from "../../src/domain/tenant-scope.js";
import { createOrganizationMembership } from "../../src/domain/organization-membership.js";
import { createAuthorityContext } from "../../src/domain/authority.js";
import { FileDurableStaffAccessGrantStore } from "../../src/domain/durable-staff-access-grant-store.js";

/**
 * C2: standalone worker process (not a test itself), spawned by
 * durable-staff-access-grant-store-concurrency.test.ts as a real, separate
 * OS process. Mirrors org-membership-race-worker.ts. Two modes:
 *
 * - "create": each worker creates a grant for a DIFFERENT membership in the
 *   same tenant at the same time, proving the per-tenant lock prevents a
 *   torn whole-file read-modify-write from losing one worker's create.
 * - "update": each worker races to update the SAME grant with the SAME
 *   `expectedVersion` (1), proving exactly one update can win.
 *
 * usage: node staff-access-grant-race-worker.js <storeDir> <readyFile> <goFile>
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
    "usage: staff-access-grant-race-worker.js <storeDir> <readyFile> <goFile> <mode> <tenantId> <membershipId> <workerLabel>",
  );
}

writeFileSync(readyFile, String(process.pid), "utf8");
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(sleepBuffer, 0, 0, 1);
}

try {
  const tenantScope = createTenantScope(tenantId);
  const store = new FileDurableStaffAccessGrantStore(storeDir);
  const membership = createOrganizationMembership({ membershipId, tenantScope, principalRef: `principal-${membershipId}`, role: "STAFF" });

  if (mode === "create") {
    store.create({
      tenantId: tenantScope.tenantId,
      membershipId: membership.membershipId,
      authority: createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false }),
      assignments: [],
    });
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
    process.exitCode = 0;
  } else if (mode === "update") {
    store.update({
      tenantId: tenantScope.tenantId,
      membershipId: membership.membershipId,
      expectedVersion: 1,
      next: {
        tenantId: tenantScope.tenantId,
        membershipId: membership.membershipId,
        authority: createAuthorityContext({ tenantScope, permissions: ["READ", "WRITE"], canPerformProtectedActions: false }),
        assignments: [],
      },
    });
    process.stdout.write(JSON.stringify({ label: workerLabel, outcome: "success" }));
    process.exitCode = 0;
  } else {
    throw new Error(`unknown mode "${mode}"`);
  }
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
