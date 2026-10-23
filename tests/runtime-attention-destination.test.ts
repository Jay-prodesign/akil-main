import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import { createNodeRuntime, type NodeRuntimeOptions } from "../src/runtime/node-server-entrypoint.js";
import { fileDurableRuntimeStoreDir } from "../src/runtime/file-durable-runtime-stores.js";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import type {
  ProtectedDecisionWaitRequest,
  ProtectedDecisionResumeAuthorization,
} from "../src/domain/protected-decision-wait-gate.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import type { OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";

/**
 * C3 Attention slice (gap scan 2026-10-23): proves the deployable runtime's
 * composition root (`createNodeRuntime`) wires `/os/attention` to the real
 * `FileDurableConnectorConnectionStore` and the newly composed
 * `FileDurableProtectedDecisionWaitStore` under `DATA_DIR`. Every record is
 * written through a SEPARATELY CONSTRUCTED store instance pointed at the
 * runtime's on-disk directory, after boot, so a passing read-back proves the
 * data crossed the filesystem (same discipline as
 * `runtime-knowledge-destination.test.ts`).
 */

const STAFF_TOKEN = "dev-staff-token-c3a";
const OS_TENANT = "tenant-c3a-os";
const OS_ORG = "org-c3a-zero";
const OS_PRINCIPAL = "staff-c3a-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };
const SECRET_REF_ID = "vault://c3a-runtime-secret-MUST-NOT-RENDER";
const WAIT_REASON = "c3a-runtime-reason-MUST-NOT-RENDER";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c3a-runtime-data-"));
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
    displayName: "AKILTA Zero (C3A)",
    founderMembershipId: "membership-c3a-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "c3a-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

/**
 * `/os/attention` is nav-gated on EXECUTE or protected-actions (Rev170 F1,
 * unchanged); its items additionally need WRITE (C3 Attention).
 */
function staffOptions(
  membership: OrganizationMembership,
  permissions: ReadonlyArray<Permission> = ["READ", "WRITE", "EXECUTE"],
): NodeRuntimeOptions {
  const session: StaffSessionContext = {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "C3A Founder" }),
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

function waitStore(dataDir: string): FileDurableProtectedDecisionWaitStore {
  return new FileDurableProtectedDecisionWaitStore(fileDurableRuntimeStoreDir(dataDir, "protectedDecisionWaits"));
}

function writeConnection(dataDir: string, tenantId: string, connectionBindingId: string, state: "DEGRADED" | "VERIFIED"): void {
  const ownership = createProjectOwnershipRef({ tenantId, customerId: "customer-c3a-rt", projectId: "project-c3a-rt" });
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
    purpose: "C3A runtime purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-c3a-rt",
    integrationInstanceRef: "instance-c3a-rt",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: SECRET_REF_ID }),
  });
  const store = connectorStore(dataDir);
  const created = store.save(instance);
  const connected = store.save(transitionConnectorConnection(created.instance, "CONNECTED_UNVERIFIED"), created.version);
  const verified = store.save(verifyConnectorConnection(connected.instance, "evidence-c3a-rt"), connected.version);
  if (state === "DEGRADED") {
    store.save(transitionConnectorConnection(verified.instance, "DEGRADED"), verified.version);
  }
}

function waitRequest(tenantId: string, waitRequestId: string, raisedAt = "2026-10-23T00:00:00.000Z"): ProtectedDecisionWaitRequest {
  return {
    waitRequestId: waitRequestId as ProtectedDecisionWaitRequest["waitRequestId"],
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: "customer-c3a-rt" as ProtectedDecisionWaitRequest["customerId"],
    projectId: "project-c3a-rt" as ProtectedDecisionWaitRequest["projectId"],
    jobId: "plan-c3a-rt:v1:req-1" as ProtectedDecisionWaitRequest["jobId"],
    runId: "run-c3a-rt",
    attempt: 1,
    effectRef: `effect:${waitRequestId}`,
    decisionRef: "decision:c3a-rt-launch",
    reason: WAIT_REASON,
    activationFingerprintAtWait: "fingerprint-c3a-rt",
    raisedAt,
  };
}

function recordWait(dataDir: string, tenantId: string, waitRequestId: string, raisedAt?: string): ProtectedDecisionWaitRequest {
  const request = waitRequest(tenantId, waitRequestId, raisedAt);
  waitStore(dataDir).putIfAbsentWaitRequest(tenantId as TenantScope["tenantId"], waitRequestId, request);
  return request;
}

function resumeWait(dataDir: string, request: ProtectedDecisionWaitRequest): void {
  const authorization: ProtectedDecisionResumeAuthorization = {
    waitRequestId: request.waitRequestId as unknown as ProtectedDecisionResumeAuthorization["waitRequestId"],
    effectRef: request.effectRef,
    resolvedAt: "2026-10-23T03:00:00.000Z",
    resolvedByPrincipalRef: "membership-c3a-founder",
    decisionRef: request.decisionRef,
    decisionEvidenceRef: "evidence:c3a-rt-decision",
  };
  waitStore(dataDir).claimResume(request.tenantId, request.waitRequestId, authorization);
}

function tenantKey(tenantId: string): string {
  return Buffer.from(tenantId, "utf8").toString("base64url");
}

const headers = { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN };

test("C3A-RT1: the composed runtime renders a DEGRADED connection and a WAIT written through separate store instances after boot on /os/attention; healthy, resumed and foreign records do not appear; secrets and reasons never appear", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const before = await fetch(`${baseUrl}/os/attention`, { headers });
      assert.equal(before.status, 200);
      const beforeBody = await before.text();
      assert.match(beforeBody, /No connection has a credential or access problem, and no protected decision is waiting for approval/);
      assert.doesNotMatch(beforeBody, /NOT ACTIVE/);

      writeConnection(dataDir, OS_TENANT, "bind-c3a-rt-degraded", "DEGRADED");
      writeConnection(dataDir, OS_TENANT, "bind-c3a-rt-healthy", "VERIFIED");
      writeConnection(dataDir, "tenant-c3a-someone-else", "bind-c3a-rt-foreign", "DEGRADED");
      recordWait(dataDir, OS_TENANT, "wait-c3a-rt-newer", "2026-10-22T00:00:00.000Z");
      recordWait(dataDir, OS_TENANT, "wait-c3a-rt-older", "2026-10-01T00:00:00.000Z");
      resumeWait(dataDir, recordWait(dataDir, OS_TENANT, "wait-c3a-rt-resumed"));
      recordWait(dataDir, "tenant-c3a-someone-else", "wait-c3a-rt-foreign");

      const response = await fetch(`${baseUrl}/os/attention`, { headers });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /bind-c3a-rt-degraded/);
      assert.match(body, /<span class="status status-warning" role="status">DEGRADED<\/span>/);
      assert.match(body, /ANTHROPIC/);
      assert.match(body, /wait-c3a-rt-newer/);
      assert.match(body, /wait-c3a-rt-older/);
      assert.ok(body.indexOf("wait-c3a-rt-older") < body.indexOf("wait-c3a-rt-newer"), "longest waiting first");
      assert.match(body, /decision:c3a-rt-launch/);
      assert.match(body, /customer-c3a-rt \/ project-c3a-rt/);
      assert.match(body, /AKILTA Zero \(C3A\)/);
      assert.doesNotMatch(body, /bind-c3a-rt-healthy|bind-c3a-rt-foreign|wait-c3a-rt-resumed|wait-c3a-rt-foreign/);
      assert.doesNotMatch(body, /MUST-NOT-RENDER|vault:|fingerprint-c3a-rt/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3A-RT2: a corrupted protected-decision WAIT log renders the staff OS ERROR page (500) on /os/attention, never EMPTY, and the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      writeConnection(dataDir, OS_TENANT, "bind-c3a-rt2", "DEGRADED");
      writeFileSync(
        join(fileDurableRuntimeStoreDir(dataDir, "protectedDecisionWaits"), `${tenantKey(OS_TENANT)}.wait.jsonl`),
        "{ this is not json\n",
        "utf8",
      );
      const response = await fetch(`${baseUrl}/os/attention`, { headers });
      assert.equal(response.status, 500);
      const body = await response.text();
      // The staff surface's own ERROR page, not the transport's generic
      // last-resort 500, so this proves the view-state catch itself.
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /bind-c3a-rt2/, "the healthy source's data is not shown on a partial read");
      assert.doesNotMatch(body, /No connection has a credential/);
      assert.doesNotMatch(body, /not json|Corrupted/);
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers })).status, 200);
      assert.equal((await fetch(`${baseUrl}/os/connections`, { headers })).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3A-RT3: a corrupted connector-connection tenant file renders the staff OS ERROR page (500) on /os/attention, never EMPTY, and the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      recordWait(dataDir, OS_TENANT, "wait-c3a-rt3");
      writeFileSync(
        join(fileDurableRuntimeStoreDir(dataDir, "connectorConnections"), `${tenantKey(OS_TENANT)}.json`),
        "{ this is not json",
        "utf8",
      );
      const response = await fetch(`${baseUrl}/os/attention`, { headers });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /wait-c3a-rt3/);
      assert.doesNotMatch(body, /no protected decision is waiting/i);
      assert.doesNotMatch(body, /not json|Corrupted/);
      assert.equal((await fetch(`${baseUrl}/os/home`, { headers })).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3A-RT4: access in the composed runtime - EXECUTE without WRITE reaches the unchanged pre-C3 NOT_ACTIVE page with no items; READ-only (and WRITE without EXECUTE) is 403", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    writeConnection(dataDir, OS_TENANT, "bind-c3a-rt4", "DEGRADED");
    recordWait(dataDir, OS_TENANT, "wait-c3a-rt4");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, ["READ", "EXECUTE"]), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/attention`, { headers });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /NOT ACTIVE/);
      assert.doesNotMatch(body, /bind-c3a-rt4|wait-c3a-rt4/);
    });
    for (const permissions of [["READ"], ["READ", "WRITE"]] as const) {
      await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, permissions), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/os/attention`, { headers });
        assert.equal(response.status, 403, permissions.join("+"));
        assert.doesNotMatch(await response.text(), /bind-c3a-rt4|wait-c3a-rt4/);
      });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3A-RT5: production stays fail-closed - /os/attention is 401 even with records and a dev staff fixture supplied", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    writeConnection(dataDir, OS_TENANT, "bind-c3a-rt5", "DEGRADED");
    recordWait(dataDir, OS_TENANT, "wait-c3a-rt5");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV, DEPLOYMENT_ENV: "production" }, staffOptions(membership), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/attention`, { headers });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /bind-c3a-rt5|wait-c3a-rt5/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C3A-RT6: /health carries a critical readability probe for the newly composed protected-decision-waits store directory", async () => {
  const dataDir = freshDataDir();
  try {
    await withRuntime({ DATA_DIR: dataDir }, {}, async (baseUrl) => {
      const ok = (await (await fetch(`${baseUrl}/health`)).json()) as { status: string; probes: Array<{ name: string; healthy: boolean }> };
      assert.equal(ok.status, "HEALTHY");
      assert.ok(ok.probes.some((probe) => probe.name === "file-store:protected-decision-waits" && probe.healthy));

      rmSync(fileDurableRuntimeStoreDir(dataDir, "protectedDecisionWaits"), { recursive: true, force: true });
      const removed = await fetch(`${baseUrl}/health`);
      assert.equal(removed.status, 503);
      const body = (await removed.json()) as { probes: Array<{ name: string; healthy: boolean }> };
      assert.deepEqual(
        body.probes.filter((probe) => !probe.healthy).map((probe) => probe.name),
        ["file-store:protected-decision-waits"],
      );
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
