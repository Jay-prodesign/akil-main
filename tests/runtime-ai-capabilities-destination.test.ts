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
import { createOrganizationServicePrincipal } from "../src/domain/organization-service-principal.js";
import { FileDurableOrganizationServicePrincipalStore } from "../src/domain/durable-organization-service-principal-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import type { OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * Gap scan N2: proves the deployable runtime's composition root
 * (`createNodeRuntime`) wires `/os/ai-capabilities` to the real
 * `FileDurableOrganizationServicePrincipalStore` under `DATA_DIR`. Every
 * service principal is written through a SEPARATELY CONSTRUCTED store
 * instance pointed at the runtime's on-disk directory, after boot, so a
 * passing read-back proves the data crossed the filesystem (same
 * discipline as `runtime-connections-destination.test.ts`).
 *
 * Also proves the one genuinely sensitive property of this slice: the
 * rendered page never leaks a capability/trust/maturity/admission concept
 * - no `ADMITTED`/`ELEVATED` or other `AdmittedWorker`-shaped status string
 * appears anywhere in the response, wired or unwired.
 */

const STAFF_TOKEN = "dev-staff-token-n2";
const OS_TENANT = "tenant-n2-os";
const OS_ORG = "org-n2-zero";
const OS_PRINCIPAL = "staff-n2-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "n2-runtime-data-"));
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
    displayName: "AKILTA Zero (N2)",
    founderMembershipId: "membership-n2-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "n2-provision-1",
    occurredAt: "2026-10-27T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

/** `/os/ai-capabilities` is nav-gated on WRITE (Rev170 F1), same as `/os/connections`. */
function staffOptions(membership: OrganizationMembership, permissions: ReadonlyArray<Permission> = ["READ", "WRITE"]): NodeRuntimeOptions {
  const session: StaffSessionContext = {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "N2 Founder" }),
    issuedAt: "2026-10-27T00:00:00.000Z",
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

function servicePrincipalStore(dataDir: string): FileDurableOrganizationServicePrincipalStore {
  return new FileDurableOrganizationServicePrincipalStore(
    fileDurableRuntimeStoreDir(dataDir, "organizationServicePrincipals"),
  );
}

function writeServicePrincipal(dataDir: string, tenantId: string, servicePrincipalId: string, workerRef: string): void {
  const store = servicePrincipalStore(dataDir);
  store.create(
    createOrganizationServicePrincipal({
      servicePrincipalId,
      tenantScope: createTenantScope(tenantId),
      workerRef,
    }),
  );
}

test("N2-RT1: the composed runtime renders a real roster written through a separate store instance after boot on /os/ai-capabilities, with the mandatory disclosure and no capability/trust leakage", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const before = await fetch(`${baseUrl}/os/ai-capabilities`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(before.status, 200);
      const beforeBody = await before.text();
      assert.match(beforeBody, /No AI\/automation service principals are registered for this organization yet/);
      assert.doesNotMatch(beforeBody, /NOT ACTIVE/);

      writeServicePrincipal(dataDir, OS_TENANT, "sp-n2-rt1", "worker-n2-rt1");
      writeServicePrincipal(dataDir, "tenant-n2-someone-else", "sp-n2-foreign", "worker-n2-foreign");

      const response = await fetch(`${baseUrl}/os/ai-capabilities`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /sp-n2-rt1/);
      assert.match(body, /worker-n2-rt1/);
      assert.match(body, /<span class="status status-success" role="status">ACTIVE<\/span>/);
      assert.match(body, /AKILTA Zero \(N2\)/);
      assert.doesNotMatch(body, /sp-n2-foreign|worker-n2-foreign/);

      // Mandatory disclosure, verbatim.
      assert.match(
        body,
        /This roster shows identity and lifecycle state only\. Capability, maturity, trust, and AI-worker routing authority are not shown here and remain NOT_ACTIVE/,
      );
      // The disclosure, and the page as a whole, must never leak an
      // AdmittedWorker-shaped trust/admission concept.
      assert.doesNotMatch(body, /ADMITTED/);
      assert.doesNotMatch(body, /ELEVATED/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("N2-RT2: a corrupted service-principal tenant file renders the staff OS ERROR page (500) on /os/ai-capabilities, never EMPTY, and the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const tenantFile = join(
        fileDurableRuntimeStoreDir(dataDir, "organizationServicePrincipals"),
        `${Buffer.from(OS_TENANT, "utf8").toString("base64url")}.json`,
      );
      writeFileSync(tenantFile, "{ this is not json", "utf8");
      const response = await fetch(`${baseUrl}/os/ai-capabilities`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No AI\/automation service principals/);
      assert.doesNotMatch(body, /not json|Corrupted/);
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("N2-RT3: /os/ai-capabilities stays WRITE-gated in the composed runtime - a READ-only grant is 403 even with a stored service principal", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    writeServicePrincipal(dataDir, OS_TENANT, "sp-n2-rt3", "worker-n2-rt3");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, ["READ"]), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/ai-capabilities`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /sp-n2-rt3/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
