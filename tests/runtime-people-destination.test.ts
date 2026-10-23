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
import {
  createOrganizationMembership,
  type OrganizationMembership,
  type OrganizationRole,
} from "../src/domain/organization-membership.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { FileDurableOrganizationMembershipStore } from "../src/domain/durable-organization-membership-store.js";
import { FileDurableStaffAccessGrantStore } from "../src/domain/durable-staff-access-grant-store.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * C3 People slice (gap scan 2026-10-23): proves the deployable runtime's
 * composition root (`createNodeRuntime`) wires `/os/people`'s roster to the
 * real `FileDurableOrganizationMembershipStore` under `DATA_DIR` (the same
 * store C2 reads staff access grants from). Every membership is written
 * through a SEPARATELY CONSTRUCTED store instance pointed at the runtime's
 * on-disk directory, after boot, so a passing read-back proves the data
 * crossed the filesystem.
 */

const STAFF_TOKEN = "dev-staff-token-c3p";
const OS_TENANT = "tenant-c3p-os";
const OS_ORG = "org-c3p-zero";
const OS_PRINCIPAL = "staff-c3p-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };
const REVOKED_REASON = "c3p-runtime-reason-MUST-NOT-RENDER";
const tenantScope = createTenantScope(OS_TENANT);

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c3p-runtime-data-"));
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

function provisionOsOrganization(dataDir: string): void {
  new FileDurableControlledOrganizationProvisioningStore(
    fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"),
  ).provision({
    tenantScope,
    organizationId: OS_ORG,
    displayName: "AKILTA Zero (C3 People)",
    founderMembershipId: "membership-c3p-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "c3p-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
}

function membershipStore(dataDir: string): FileDurableOrganizationMembershipStore {
  return new FileDurableOrganizationMembershipStore(fileDurableRuntimeStoreDir(dataDir, "organizationMemberships"));
}

function writeMembership(
  dataDir: string,
  membershipId: string,
  principalRef: string,
  role: OrganizationRole = "STAFF",
  tenantId: string = OS_TENANT,
): OrganizationMembership {
  const membership = createOrganizationMembership({ membershipId, tenantScope: createTenantScope(tenantId), principalRef, role });
  membershipStore(dataDir).create(membership);
  return membership;
}

function writeGrant(dataDir: string, membership: OrganizationMembership, permissions: ReadonlyArray<Permission>): void {
  new FileDurableStaffAccessGrantStore(fileDurableRuntimeStoreDir(dataDir, "staffAccessGrants")).create({
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    authority: createAuthorityContext({ tenantScope, permissions, canPerformProtectedActions: false }),
    assignments: [],
  });
}

function staffSession(): StaffSessionContext {
  return {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "C3P Founder" }),
    issuedAt: "2026-10-23T00:00:00.000Z",
  };
}

/** No `staffAccessGrants` override: grants come from the durable stores (C2's deployable default). */
const DEV_SESSION_ONLY: NodeRuntimeOptions = { devStaffSessionFixtures: new Map([[STAFF_TOKEN, staffSession()]]) };

/** C1's fixed-grant test seam: grants do not read the membership store, so the roster's own error path is reachable. */
function fixedGrantOptions(
  membership: OrganizationMembership,
  permissions: ReadonlyArray<Permission> = ["READ"],
): NodeRuntimeOptions {
  const grant: StaffAccessGrant = {
    membership,
    authority: createAuthorityContext({ tenantScope, permissions, canPerformProtectedActions: false }),
    assignments: [],
  };
  return { ...DEV_SESSION_ONLY, staffAccessGrants: [grant] };
}

const staffHeaders = { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN };

const SELF_SECTION = `
  <section aria-labelledby="people-heading" class="card">
    <h2 id="people-heading">You</h2>
    <p>C3P Founder</p>
    <p>Organization role: STAFF</p>
    <p>Membership state: ACTIVE</p>
  </section>`;

test("C3P-RT1: the composed runtime lists every membership in the tenant on /os/people, including ones written after boot, next to an unchanged self-section", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const founder = writeMembership(dataDir, "membership-c3p-founder", OS_PRINCIPAL);
    writeGrant(dataDir, founder, ["READ", "WRITE"]);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSION_ONLY, async (baseUrl) => {
      const before = await fetch(`${baseUrl}/os/people`, { headers: staffHeaders });
      assert.equal(before.status, 200);
      const beforeBody = await before.text();
      assert.ok(beforeBody.includes(SELF_SECTION));
      assert.match(beforeBody, /<td>staff-c3p-founder<\/td><td>STAFF<\/td>/);
      assert.doesNotMatch(beforeBody, /staff-c3p-junior/);

      writeMembership(dataDir, "membership-c3p-junior", "staff-c3p-junior", "JUNIOR");
      const leaver = membershipStore(dataDir).create(
        createOrganizationMembership({ membershipId: "membership-c3p-leaver", tenantScope, principalRef: "staff-c3p-leaver", role: "STUDENT" }),
      );
      membershipStore(dataDir).revoke({
        tenantId: tenantScope.tenantId,
        membershipId: leaver.membership.membershipId,
        expectedVersion: leaver.version,
        revokedAt: "2026-10-22T09:00:00.000Z",
        revokedReason: REVOKED_REASON,
      });
      writeMembership(dataDir, "membership-c3p-foreign", "staff-c3p-foreign", "STAFF", "tenant-c3p-someone-else");

      const response = await fetch(`${baseUrl}/os/people`, { headers: staffHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.includes(SELF_SECTION));
      assert.match(body, /AKILTA Zero \(C3 People\)/);
      assert.match(body, /<td>staff-c3p-founder<\/td><td>STAFF<\/td>/);
      assert.match(body, /<td>staff-c3p-junior<\/td><td>JUNIOR<\/td>/);
      assert.match(body, /<td>staff-c3p-leaver<\/td><td>STUDENT<\/td><td><span class="status status-danger" role="status">REVOKED<\/span>/);
      assert.doesNotMatch(body, /staff-c3p-foreign/);
      assert.doesNotMatch(body, /MUST-NOT-RENDER|2026-10-22T09/);
      assert.doesNotMatch(body, /directory is not yet available/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3P-RT2: a corrupted membership tenant file renders the staff OS ERROR page (500) on /os/people, never an empty roster, and the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const founder = createOrganizationMembership({ membershipId: "membership-c3p-founder", tenantScope, principalRef: OS_PRINCIPAL, role: "STAFF" });
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, fixedGrantOptions(founder, ["READ", "WRITE"]), async (baseUrl) => {
      const tenantFile = join(
        fileDurableRuntimeStoreDir(dataDir, "organizationMemberships"),
        `${Buffer.from(OS_TENANT, "utf8").toString("base64url")}.json`,
      );
      writeFileSync(tenantFile, "{ this is not json", "utf8");
      const response = await fetch(`${baseUrl}/os/people`, { headers: staffHeaders });
      assert.equal(response.status, 500);
      const body = await response.text();
      // The staff surface's own ERROR page, not the transport's generic
      // last-resort 500, so this proves the view-state catch itself.
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No memberships are recorded|C3P Founder/);
      assert.doesNotMatch(body, /not json|Corrupted/);
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: staffHeaders })).status, 200);
      assert.equal((await fetch(`${baseUrl}/os/products`, { headers: staffHeaders })).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3P-RT3: /os/people's DESTINATION stays on the READ floor in the composed runtime (a READ-only durable grant reaches it, unlike WRITE-gated /os/connections), but the ROSTER additionally requires WRITE - a READ-only grant gets the self-only page, a WRITE grant gets the roster", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const founder = writeMembership(dataDir, "membership-c3p-founder", OS_PRINCIPAL);
    writeGrant(dataDir, founder, ["READ"]);
    writeMembership(dataDir, "membership-c3p-rt3", "staff-c3p-rt3");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, DEV_SESSION_ONLY, async (baseUrl) => {
      // READ-only: the destination is reached (unlike connections, which
      // needs WRITE just to render at all), but the roster is withheld.
      const peopleReadOnly = await fetch(`${baseUrl}/os/people`, { headers: staffHeaders });
      assert.equal(peopleReadOnly.status, 200);
      assert.doesNotMatch(await peopleReadOnly.text(), /staff-c3p-rt3/);
      assert.equal((await fetch(`${baseUrl}/os/connections`, { headers: staffHeaders })).status, 403);
    });

    // WRITE: the same destination now also includes the roster.
    const writeDataDir = freshDataDir();
    try {
      provisionOsOrganization(writeDataDir);
      const writeFounder = writeMembership(writeDataDir, "membership-c3p-founder", OS_PRINCIPAL);
      writeGrant(writeDataDir, writeFounder, ["READ", "WRITE"]);
      writeMembership(writeDataDir, "membership-c3p-rt3", "staff-c3p-rt3");
      await withRuntime({ DATA_DIR: writeDataDir, ...OS_ENV }, DEV_SESSION_ONLY, async (baseUrl) => {
        const peopleWrite = await fetch(`${baseUrl}/os/people`, { headers: staffHeaders });
        assert.equal(peopleWrite.status, 200);
        assert.match(await peopleWrite.text(), /staff-c3p-rt3/);
      });
    } finally {
      rmSync(writeDataDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3P-RT4: production stays fail-closed - /os/people is 401 even with stored memberships, a durable grant and a dev staff fixture supplied", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const founder = writeMembership(dataDir, "membership-c3p-founder", OS_PRINCIPAL);
    writeGrant(dataDir, founder, ["READ", "WRITE"]);
    writeMembership(dataDir, "membership-c3p-rt4", "staff-c3p-rt4");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV, DEPLOYMENT_ENV: "production" }, DEV_SESSION_ONLY, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/people`, { headers: staffHeaders });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /staff-c3p-rt4|staff-c3p-founder/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
