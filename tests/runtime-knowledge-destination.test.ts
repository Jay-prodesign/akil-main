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
import type { EvidenceReference } from "../src/domain/evidence.js";
import { FileDurableEvidenceReferenceStore } from "../src/domain/durable-evidence-reference-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import type { OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * C3 Knowledge slice (gap scan 2026-10-23): proves the deployable runtime's
 * composition root (`createNodeRuntime`) wires `/os/knowledge` to the real
 * `FileDurableEvidenceReferenceStore` under `DATA_DIR`. Every evidence
 * reference is recorded through a SEPARATELY CONSTRUCTED store instance
 * pointed at the runtime's on-disk directory, after boot, so a passing
 * read-back proves the data crossed the filesystem (same discipline as
 * `runtime-connections-destination.test.ts`).
 */

const STAFF_TOKEN = "dev-staff-token-c3k";
const OS_TENANT = "tenant-c3k-os";
const OS_ORG = "org-c3k-zero";
const OS_PRINCIPAL = "staff-c3k-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };
const SOURCE_LOCATOR = "internal://c3k-runtime/locator-MUST-NOT-RENDER";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c3k-runtime-data-"));
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
  run: (baseUrl: string, dataDir: string) => Promise<void>,
): Promise<void> {
  const runtime = createNodeRuntime(resolveAppConfig(env), options);
  const port = await listen(runtime.server);
  try {
    await run(`http://127.0.0.1:${port}`, runtime.dataDir);
  } finally {
    await close(runtime.server);
  }
}

function provisionOsOrganization(dataDir: string): OrganizationMembership {
  const store = new FileDurableControlledOrganizationProvisioningStore(
    fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"),
  );
  const outcome = store.provision({
    tenantScope: createTenantScope(OS_TENANT),
    organizationId: OS_ORG,
    displayName: "AKILTA Zero (C3K)",
    founderMembershipId: "membership-c3k-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "c3k-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

/** `/os/knowledge` is nav-gated on WRITE (Rev170 F1), unchanged by C3. */
function staffOptions(membership: OrganizationMembership, permissions: ReadonlyArray<Permission> = ["READ", "WRITE"]): NodeRuntimeOptions {
  const session: StaffSessionContext = {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "C3K Founder" }),
    issuedAt: "2026-10-23T00:00:00.000Z",
  };
  const grant: StaffAccessGrant = {
    membership,
    authority: createAuthorityContext({
      tenantScope: createTenantScope(OS_TENANT),
      permissions,
      canPerformProtectedActions: false,
    }),
    assignments: [],
  };
  return { devStaffSessionFixtures: new Map([[STAFF_TOKEN, session]]), staffAccessGrants: [grant] };
}

function evidenceStore(dataDir: string): FileDurableEvidenceReferenceStore {
  return new FileDurableEvidenceReferenceStore(fileDurableRuntimeStoreDir(dataDir, "evidenceReferences"));
}

function recordEvidence(dataDir: string, tenantId: string, evidenceId: string, capturedAt: string): void {
  evidenceStore(dataDir).record({
    evidenceId: evidenceId as EvidenceReference["evidenceId"],
    tenantId: tenantId as EvidenceReference["tenantId"],
    customerId: "customer-c3k-rt" as EvidenceReference["customerId"],
    projectId: "project-c3k-rt" as EvidenceReference["projectId"],
    jobId: "plan-c3k-rt:v1:req-1" as EvidenceReference["jobId"],
    evidenceType: "DISCOVERY_NOTE",
    sourceLocator: SOURCE_LOCATOR,
    capturedAt,
  });
}

const headers = { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN };

test("C3K-RT1: the composed runtime renders evidence recorded through a separate store instance after boot on /os/knowledge, newest first, and the sourceLocator never appears in the response", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const before = await fetch(`${baseUrl}/os/knowledge`, { headers });
      assert.equal(before.status, 200);
      const beforeBody = await before.text();
      assert.match(beforeBody, /No evidence references have been recorded for this organization yet/);
      assert.doesNotMatch(beforeBody, /NOT ACTIVE/);

      recordEvidence(dataDir, OS_TENANT, "ev-c3k-rt-older", "2026-10-01T00:00:00.000Z");
      recordEvidence(dataDir, OS_TENANT, "ev-c3k-rt-newer", "2026-10-22T00:00:00.000Z");
      recordEvidence(dataDir, "tenant-c3k-someone-else", "ev-c3k-foreign", "2026-10-23T00:00:00.000Z");

      const response = await fetch(`${baseUrl}/os/knowledge`, { headers });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /ev-c3k-rt-older/);
      assert.match(body, /ev-c3k-rt-newer/);
      assert.ok(body.indexOf("ev-c3k-rt-newer") < body.indexOf("ev-c3k-rt-older"), "newest first");
      assert.match(body, /DISCOVERY_NOTE/);
      assert.match(body, /customer-c3k-rt \/ project-c3k-rt/);
      assert.match(body, /AKILTA Zero \(C3K\)/);
      assert.doesNotMatch(body, /ev-c3k-foreign/);
      assert.doesNotMatch(body, /MUST-NOT-RENDER|internal:\/\/c3k-runtime/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3K-RT2: a corrupted evidence-reference tenant file renders the staff OS ERROR page (500) on /os/knowledge, never EMPTY, and the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const tenantFile = join(
        fileDurableRuntimeStoreDir(dataDir, "evidenceReferences"),
        `${Buffer.from(OS_TENANT, "utf8").toString("base64url")}.json`,
      );
      writeFileSync(tenantFile, "{ this is not json", "utf8");
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers });
      assert.equal(response.status, 500);
      const body = await response.text();
      // The staff surface's own ERROR page, not the transport's generic
      // last-resort 500, so this proves the view-state catch itself.
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No evidence references have been recorded/);
      assert.doesNotMatch(body, /not json|Corrupted/);
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers })).status, 200);
      assert.equal((await fetch(`${baseUrl}/os/connections`, { headers })).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3K-RT3: /os/knowledge stays WRITE-gated in the composed runtime - a READ-only grant is 403 even with recorded evidence", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    recordEvidence(dataDir, OS_TENANT, "ev-c3k-rt3", "2026-10-23T00:00:00.000Z");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, ["READ"]), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers });
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /ev-c3k-rt3/);
    });
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, ["READ", "EXECUTE"]), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers });
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /ev-c3k-rt3/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3K-RT4: production stays fail-closed - /os/knowledge is 401 even with recorded evidence and a dev staff fixture supplied", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    recordEvidence(dataDir, OS_TENANT, "ev-c3k-rt4", "2026-10-23T00:00:00.000Z");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV, DEPLOYMENT_ENV: "production" }, staffOptions(membership), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /ev-c3k-rt4/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
