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
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import type { OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * C3 (gap scan 2026-10-23): proves the deployable runtime's composition
 * root (`createNodeRuntime`) wires `/os/connections` to the real
 * `FileDurableConnectorConnectionStore` under `DATA_DIR`. Every connection
 * is written through a SEPARATELY CONSTRUCTED store instance pointed at
 * the runtime's on-disk directory, after boot, so a passing read-back
 * proves the data crossed the filesystem (same discipline as
 * `runtime-composition-root.test.ts`).
 */

const STAFF_TOKEN = "dev-staff-token-c3";
const OS_TENANT = "tenant-c3-os";
const OS_ORG = "org-c3-zero";
const OS_PRINCIPAL = "staff-c3-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };
const SECRET_REF_ID = "secret-ref-c3-runtime-MUST-NOT-RENDER";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c3-runtime-data-"));
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
    displayName: "AKILTA Zero (C3)",
    founderMembershipId: "membership-c3-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "c3-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

/** `/os/connections` is nav-gated on WRITE (Rev170 F1). */
function staffOptions(membership: OrganizationMembership, permissions: ReadonlyArray<Permission> = ["READ", "WRITE"]): NodeRuntimeOptions {
  const session: StaffSessionContext = {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "C3 Founder" }),
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

function connectorStore(dataDir: string): FileDurableConnectorConnectionStore {
  return new FileDurableConnectorConnectionStore(fileDurableRuntimeStoreDir(dataDir, "connectorConnections"));
}

function writeVerifiedConnection(dataDir: string, tenantId: string, connectionBindingId: string): void {
  const ownership = createProjectOwnershipRef({ tenantId, customerId: "customer-c3-rt", projectId: "project-c3-rt" });
  const descriptor = createConnectorDescriptor({
    connectorKind: "ANTHROPIC",
    displayName: "Anthropic",
    supportedAuthModes: ["API_KEY"],
    capabilityRefs: ["cap:model-inference"],
    isAiModelProvider: true,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${connectionBindingId}`,
    ownership,
    requiredCapabilityRef: "cap:model-inference",
    purpose: "C3 runtime purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-c3-rt",
    integrationInstanceRef: "instance-c3-rt",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: SECRET_REF_ID }),
  });
  const store = connectorStore(dataDir);
  const created = store.save(instance);
  const connected = store.save(transitionConnectorConnection(created.instance, "CONNECTED_UNVERIFIED"), created.version);
  store.save(verifyConnectorConnection(connected.instance, "evidence-c3-rt"), connected.version);
}

test("C3-RT1: the composed runtime renders a connection written through a separate store instance after boot on /os/connections, and the secretRef never appears in the response", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const before = await fetch(`${baseUrl}/os/connections`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(before.status, 200);
      const beforeBody = await before.text();
      assert.match(beforeBody, /No connections are configured for this organization yet/);
      assert.doesNotMatch(beforeBody, /NOT ACTIVE/);

      writeVerifiedConnection(dataDir, OS_TENANT, "bind-c3-rt1");
      writeVerifiedConnection(dataDir, "tenant-c3-someone-else", "bind-c3-foreign");

      const response = await fetch(`${baseUrl}/os/connections`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /bind-c3-rt1/);
      assert.match(body, /ANTHROPIC/);
      assert.match(body, /API_KEY/);
      assert.match(body, /<span class="status status-success" role="status">VERIFIED<\/span>/);
      assert.match(body, /evidence-c3-rt/);
      assert.match(body, /AKILTA Zero \(C3\)/);
      assert.doesNotMatch(body, /bind-c3-foreign/);
      assert.doesNotMatch(body, /secret-ref-c3-runtime|MUST-NOT-RENDER/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3-RT2: a corrupted connector-connection tenant file renders the staff OS ERROR page (500) on /os/connections, never EMPTY, and the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const tenantFile = join(
        fileDurableRuntimeStoreDir(dataDir, "connectorConnections"),
        `${Buffer.from(OS_TENANT, "utf8").toString("base64url")}.json`,
      );
      writeFileSync(tenantFile, "{ this is not json", "utf8");
      const response = await fetch(`${baseUrl}/os/connections`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 500);
      const body = await response.text();
      // The staff surface's own ERROR page, not the transport's generic
      // last-resort 500, so this proves the view-state catch itself.
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No connections are configured/);
      assert.doesNotMatch(body, /not json|Corrupted/);
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3-RT3: /os/connections stays WRITE-gated in the composed runtime - a READ-only grant is 403 even with a stored connection", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    writeVerifiedConnection(dataDir, OS_TENANT, "bind-c3-rt3");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, ["READ"]), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/connections`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /bind-c3-rt3/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3-RT4: production stays fail-closed - /os/connections is 401 even with a stored connection and a dev staff fixture supplied", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    writeVerifiedConnection(dataDir, OS_TENANT, "bind-c3-rt4");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV, DEPLOYMENT_ENV: "production" }, staffOptions(membership), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/connections`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /bind-c3-rt4/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
