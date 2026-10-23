import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import { createNodeRuntime, type NodeRuntimeOptions } from "../src/runtime/node-server-entrypoint.js";
import { fileDurableRuntimeStoreDir } from "../src/runtime/file-durable-runtime-stores.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject, type Project } from "../src/domain/project.js";
import { createOutcomeJob, transitionOutcomeJob } from "../src/domain/outcome-job.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import {
  createAssignmentReference,
  createOrganizationMembership,
  type OrganizationMembership,
} from "../src/domain/organization-membership.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { FileDurableOrganizationMembershipStore } from "../src/domain/durable-organization-membership-store.js";
import { FileDurableStaffAccessGrantStore, type StaffAccessGrantRecord } from "../src/domain/durable-staff-access-grant-store.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";

/**
 * C2: proves the deployable runtime (`createNodeRuntime`) now reads the
 * `/os` surface's `StaffAccessGrant[]` from the durable grant store joined
 * with the durable membership store, per request, when no
 * `staffAccessGrants` override is supplied. Every write goes through a
 * SEPARATELY CONSTRUCTED store instance over the same on-disk directory
 * the runtime uses, so a passing read-back proves the data crossed the
 * filesystem.
 */

const STAFF_TOKEN = "dev-staff-token-c2";
const OTHER_STAFF_TOKEN = "dev-staff-token-c2-other";
const OS_TENANT = "tenant-c2-os";
const OS_ORG = "org-c2-zero";
const OS_PRINCIPAL = "staff-c2-founder";
const OTHER_PRINCIPAL = "staff-c2-other";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };
const tenantScope = createTenantScope(OS_TENANT);

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c2-runtime-data-"));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo");
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function withRuntime(
  env: Record<string, string>,
  options: NodeRuntimeOptions,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const runtime = createNodeRuntime(resolveAppConfig(env), options);
  const port = await listen(runtime.server);
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await close(runtime.server);
  }
}

function staffSession(principalId: string): StaffSessionContext {
  return {
    principal: createAuthenticatedStaffPrincipal({ principalId, displayName: `C2 ${principalId}` }),
    issuedAt: "2026-10-23T00:00:00.000Z",
  };
}

/** Dev staff sessions only - deliberately NO `staffAccessGrants`, so the durable source is used. */
const DEV_SESSIONS_ONLY: NodeRuntimeOptions = {
  devStaffSessionFixtures: new Map([
    [STAFF_TOKEN, staffSession(OS_PRINCIPAL)],
    [OTHER_STAFF_TOKEN, staffSession(OTHER_PRINCIPAL)],
  ]),
};

const headers = (token: string) => ({ [STAFF_SESSION_TOKEN_HEADER]: token });

function provisionOsOrganization(dataDir: string): void {
  new FileDurableControlledOrganizationProvisioningStore(
    fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"),
  ).provision({
    tenantScope,
    organizationId: OS_ORG,
    displayName: "AKILTA Zero (C2)",
    founderMembershipId: "membership-c2-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "c2-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
}

function writeMembership(dataDir: string, membershipId: string, principalRef: string): OrganizationMembership {
  const membership = createOrganizationMembership({ membershipId, tenantScope, principalRef, role: "STAFF" });
  new FileDurableOrganizationMembershipStore(fileDurableRuntimeStoreDir(dataDir, "organizationMemberships")).create(membership);
  return membership;
}

function grantStore(dataDir: string): FileDurableStaffAccessGrantStore {
  return new FileDurableStaffAccessGrantStore(fileDurableRuntimeStoreDir(dataDir, "staffAccessGrants"));
}

function grantRecord(
  membership: OrganizationMembership,
  permissions: ReadonlyArray<Permission>,
  assignedProject?: Project,
): StaffAccessGrantRecord {
  return {
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    authority: createAuthorityContext({ tenantScope, permissions, canPerformProtectedActions: false }),
    assignments:
      assignedProject !== undefined
        ? [
            createAssignmentReference({
              assignmentId: `assignment-${membership.membershipId}`,
              membership,
              customerId: assignedProject.customerId,
              projectId: assignedProject.projectId,
            }),
          ]
        : [],
  };
}

function seedProjectWithExecutingJob(dataDir: string, customerId: string, projectId: string, jobId: string): Project {
  const customer = createCustomer({ tenantScope, customerId, displayName: "C2 Customer" });
  const project = createProject({ tenantScope, customer, projectId, ownerRef: "owner-c2", state: "ACTIVE" });
  const job = transitionOutcomeJob(
    transitionOutcomeJob(
      transitionOutcomeJob(
        createOutcomeJob({ tenantScope, customer, project, jobId, jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" }),
        "QUALIFIED",
      ),
      "READY",
    ),
    "EXECUTING",
  );
  new FileDurableProjectStore(fileDurableRuntimeStoreDir(dataDir, "projects")).create(project);
  new FileDurableOutcomeJobStore(fileDurableRuntimeStoreDir(dataDir, "outcomeJobs")).putIfAbsent(job);
  return project;
}

function grantFilePath(dataDir: string): string {
  const safeKey = Buffer.from(OS_TENANT, "utf8").toString("base64url");
  return join(fileDurableRuntimeStoreDir(dataDir, "staffAccessGrants"), `${safeKey}.json`);
}

test("C2-R1: a membership with a durable grant record reaches /os with exactly the stored permissions and assignments - no staffAccessGrants override supplied", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    const project = seedProjectWithExecutingJob(dataDir, "customer-c2", "project-c2", "job-c2-durable");
    grantStore(dataDir).create(grantRecord(membership, ["READ"], project));
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      const home = await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /AKILTA Zero \(C2\)/);

      const detail = await fetch(`${baseUrl}/os/work/customer-c2/project-c2`, { headers: headers(STAFF_TOKEN) });
      assert.equal(detail.status, 200);
      assert.match(await detail.text(), /job-c2-durable/);

      // READ only: `/os/admin` is nav-gated on WRITE, so the stored
      // permission set is what is enforced - nothing wider.
      assert.equal((await fetch(`${baseUrl}/os/admin`, { headers: headers(STAFF_TOKEN) })).status, 403);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R2: an ACTIVE membership with NO grant record is denied (403) - absent from grants, never a synthesized default", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const founder = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    writeMembership(dataDir, "membership-c2-other", OTHER_PRINCIPAL);
    // Only the founder has a grant record.
    grantStore(dataDir).create(grantRecord(founder, ["READ", "WRITE", "EXECUTE"]));
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/os/home`, { headers: headers(OTHER_STAFF_TOKEN) });
      assert.equal(denied.status, 403);
      assert.doesNotMatch(await denied.text(), /AKILTA Zero \(C2\)/);
      // Control: the granted founder is admitted by the same runtime.
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R3: with an empty grant store, every authenticated staff session is denied (403)", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 403);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R4: grants are re-read per request - a grant created and then widened after boot takes effect on the next request", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 403);

      grantStore(dataDir).create(grantRecord(membership, ["READ"]));
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 200);
      assert.equal((await fetch(`${baseUrl}/os/admin`, { headers: headers(STAFF_TOKEN) })).status, 403);

      grantStore(dataDir).update({
        tenantId: membership.tenantId,
        membershipId: membership.membershipId,
        expectedVersion: 1,
        next: grantRecord(membership, ["READ", "WRITE"]),
      });
      assert.equal((await fetch(`${baseUrl}/os/admin`, { headers: headers(STAFF_TOKEN) })).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R5: revoking the membership after boot denies access even though its grant record remains", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    grantStore(dataDir).create(grantRecord(membership, ["READ"]));
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 200);
      new FileDurableOrganizationMembershipStore(fileDurableRuntimeStoreDir(dataDir, "organizationMemberships")).revoke({
        tenantId: membership.tenantId,
        membershipId: membership.membershipId,
        expectedVersion: 1,
        revokedAt: "2026-10-23T03:00:00.000Z",
        revokedReason: "left the organization",
      });
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 403);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R6: a grant record with no matching durable membership grants nothing (403)", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    // The membership value exists only in memory - it is never written to
    // the durable membership store.
    const unwritten = createOrganizationMembership({ membershipId: "membership-c2-founder", tenantScope, principalRef: OS_PRINCIPAL, role: "STAFF" });
    grantStore(dataDir).create(grantRecord(unwritten, ["READ", "WRITE"]));
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 403);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R7: a corrupted grant file renders the OS ERROR page (500) - never 403 'no grant', never a crash", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    grantStore(dataDir).create(grantRecord(membership, ["READ"]));
    writeFileSync(grantFilePath(dataDir), "{ this is not json", "utf8");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      for (const token of [STAFF_TOKEN, OTHER_STAFF_TOKEN]) {
        const response = await fetch(`${baseUrl}/os/home`, { headers: headers(token) });
        assert.equal(response.status, 500);
        const body = await response.text();
        // The staff surface's own ERROR page, not the transport's generic
        // last-resort 500, so this proves the grant-source catch itself.
        assert.match(body, /AKILTA OS/);
        assert.match(body, /Something went wrong/);
        assert.doesNotMatch(body, /not json|staff-access-grants|AKILTA Zero/);
      }
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R8: a structurally invalid grant record (unknown permission) also renders ERROR (500), not a partial grant", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    grantStore(dataDir); // creates the store directory
    writeFileSync(
      grantFilePath(dataDir),
      JSON.stringify({
        "membership-c2-founder": {
          version: 1,
          grant: {
            tenantId: OS_TENANT,
            membershipId: "membership-c2-founder",
            authority: { permissions: ["READ", "SUPERUSER"], canPerformProtectedActions: true },
            assignments: [],
          },
        },
      }),
      "utf8",
    );
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) });
      assert.equal(response.status, 500);
      assert.match(await response.text(), /Something went wrong/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R9: a corrupted membership file renders ERROR (500) through the grant source - never 403", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    grantStore(dataDir).create(grantRecord(membership, ["READ"]));
    const safeKey = Buffer.from(OS_TENANT, "utf8").toString("base64url");
    writeFileSync(join(fileDurableRuntimeStoreDir(dataDir, "organizationMemberships"), `${safeKey}.json`), "[]", "utf8");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) });
      assert.equal(response.status, 500);
      assert.match(await response.text(), /Something went wrong/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R10: production stays fail-closed (401) with a durable grant and membership seeded - the grant source authenticates no one", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = writeMembership(dataDir, "membership-c2-founder", OS_PRINCIPAL);
    grantStore(dataDir).create(grantRecord(membership, ["READ", "WRITE", "EXECUTE"]));
    await withRuntime({ DATA_DIR: dataDir, DEPLOYMENT_ENV: "production", ...OS_ENV }, DEV_SESSIONS_ONLY, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /AKILTA Zero/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R11: an explicit staffAccessGrants override still replaces the durable source (C1's test seam) - the grant store is not read", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const membership = createOrganizationMembership({ membershipId: "membership-c2-founder", tenantScope, principalRef: OS_PRINCIPAL, role: "STAFF" });
    grantStore(dataDir); // creates the store directory
    writeFileSync(grantFilePath(dataDir), "{ corrupted", "utf8");
    await withRuntime(
      { DATA_DIR: dataDir, ...OS_ENV },
      {
        ...DEV_SESSIONS_ONLY,
        staffAccessGrants: [
          {
            membership,
            authority: createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false }),
            assignments: [],
          },
        ],
      },
      async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/os/home`, { headers: headers(STAFF_TOKEN) })).status, 200);
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C2-R12: /health carries a critical readability probe for the new staff-access-grants store directory", async () => {
  const dataDir = freshDataDir();
  try {
    await withRuntime({ DATA_DIR: dataDir }, {}, async (baseUrl) => {
      const ok = (await (await fetch(`${baseUrl}/health`)).json()) as { probes: Array<{ name: string; healthy: boolean }> };
      assert.ok(ok.probes.some((probe) => probe.name === "file-store:staff-access-grants" && probe.healthy));

      rmSync(fileDurableRuntimeStoreDir(dataDir, "staffAccessGrants"), { recursive: true, force: true });
      const removed = await fetch(`${baseUrl}/health`);
      assert.equal(removed.status, 503);
      const body = (await removed.json()) as { probes: Array<{ name: string; healthy: boolean }> };
      assert.deepEqual(
        body.probes.filter((probe) => !probe.healthy).map((probe) => probe.name),
        ["file-store:staff-access-grants"],
      );
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
