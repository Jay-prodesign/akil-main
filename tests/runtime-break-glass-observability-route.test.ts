import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import type { Server } from "node:http";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import { createNodeRuntime, type NodeRuntimeOptions } from "../src/runtime/node-server-entrypoint.js";
import { createFileDurableRuntimeStores, fileDurableRuntimeStoreDir } from "../src/runtime/file-durable-runtime-stores.js";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import {
  createBreakGlassAccessGrant,
  revokeBreakGlassAccessGrant,
  type BreakGlassAccessGrant,
  type BreakGlassSupportAccessAudit,
  type BreakGlassSupportViewKind,
} from "../src/domain/break-glass-support-access.js";
import { FileDurableBreakGlassAccessGrantStore } from "../src/domain/durable-break-glass-access-grant-store.js";
import { FileDurableBreakGlassSupportAccessAuditStore } from "../src/domain/durable-break-glass-support-access-audit-store.js";
import { composeOperationalObservabilityView } from "../src/domain/operational-observability-view.js";
import type { OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import {
  STAFF_SESSION_TOKEN_HEADER,
  BREAK_GLASS_GRANT_ID_HEADER,
  BREAK_GLASS_CONSENT_REF_HEADER,
  createInternalOsRequestHandler,
  type BreakGlassSupportAccessDeps,
  type InternalOsRequestHandlerDeps,
} from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { createCurrentStaffAccessGrantsInternalOsRequestHandler } from "../src/web/internal-os-staff-access-grant-durable-source.js";
import { createDurableInternalOsOrganizationSource } from "../src/web/internal-os-organization-durable-source.js";
import { createDurableOrganizationResourceBindingSource } from "../src/web/organization-resource-binding-durable-source.js";
import { createDurableOperationalObservabilitySource } from "../src/web/operational-observability-admin-source.js";
import { createDurableCustomerOffboardingAdminSource } from "../src/web/customer-offboarding-admin-source.js";
import type { IncomingRequestLike } from "../src/web/request-handler.js";
import { resolveBreakGlassObservabilityView, type OperationalObservabilitySource } from "../src/web/internal-os-view-state.js";

/**
 * C7 (gap scan 2026-10-23): the read-only break-glass branch of
 * `GET /os/admin`, exercised through the deployable runtime's real
 * composition root (`createNodeRuntime`) over a real TCP socket - mirrors
 * `runtime-attention-decision-route.test.ts`'s own structure. Requests are
 * written byte-for-byte with `node:net`, so every header is exactly what
 * the test says. A few witnesses that need a fault the runtime cannot
 * produce (a compromised grant store, an unwired observability source)
 * run in-process against `createInternalOsRequestHandler` directly.
 */

const OS_TENANT = "tenant-c7-os";
const OS_ORG = "org-c7-zero";
const OS_SCOPE = createTenantScope(OS_TENANT);
const SUPPORT_SCOPE = createTenantScope("tenant-c7-support");
const FOREIGN_SCOPE = createTenantScope("tenant-c7-foreign");
const FOUNDER_PRINCIPAL = "staff-c7-founder";
const FOUNDER_MEMBERSHIP = "membership-c7-founder";
const SUPPORT_PRINCIPAL = "staff-c7-support";
const OTHER_SUPPORT_PRINCIPAL = "staff-c7-other-support";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };

const FOUNDER_TOKEN = "dev-staff-token-c7-founder";
const SUPPORT_TOKEN = "dev-staff-token-c7-support";
const OTHER_SUPPORT_TOKEN = "dev-staff-token-c7-other-support";

const ALL_KINDS: ReadonlyArray<BreakGlassSupportViewKind> = ["TASK", "CONNECTION", "QUOTA", "APPROVALS", "AUDIT_EVIDENCE"];
const SEEDED_CONNECTION = "binding-c7-visible-connection";

/** Every section heading the break-glass page can render, by kind. */
const SECTION_HEADING: Readonly<Record<BreakGlassSupportViewKind, string>> = {
  TASK: "<h3>Task / worker health</h3>",
  CONNECTION: "<h3>Connections</h3>",
  QUOTA: "<h3>Cost / quota</h3>",
  APPROVALS: "<h3>Pending approvals</h3>",
  AUDIT_EVIDENCE: "<h3>Audit / evidence</h3>",
};

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c7-runtime-data-"));
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

interface RuntimeHandle {
  readonly port: number;
  readonly dataDir: string;
}

function provisionOsOrganization(dataDir: string): OrganizationMembership {
  const store = new FileDurableControlledOrganizationProvisioningStore(fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"));
  const outcome = store.provision({
    tenantScope: OS_SCOPE,
    organizationId: OS_ORG,
    displayName: "AKILTA Zero (C7)",
    founderMembershipId: FOUNDER_MEMBERSHIP,
    founderPrincipalRef: FOUNDER_PRINCIPAL,
    idempotencyKey: "c7-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

/** The founder membership exactly as `provisionOsOrganization` mints it (deterministic for the same input). */
function founderMembershipFor(): OrganizationMembership {
  const dir = freshDataDir();
  try {
    return provisionOsOrganization(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FOUNDER = founderMembershipFor();

function session(principalId: string): StaffSessionContext {
  return { principal: createAuthenticatedStaffPrincipal({ principalId, displayName: principalId }), issuedAt: "2026-10-23T00:00:00.000Z" };
}

const SESSION_FIXTURES: ReadonlyMap<string, StaffSessionContext> = new Map([
  [FOUNDER_TOKEN, session(FOUNDER_PRINCIPAL)],
  [SUPPORT_TOKEN, session(SUPPORT_PRINCIPAL)],
  [OTHER_SUPPORT_TOKEN, session(OTHER_SUPPORT_PRINCIPAL)],
]);

/**
 * Only the founder holds a membership/grant in this organization. Both
 * support principals have a valid staff session and NO membership - the
 * exact shape break-glass exists for.
 */
const STAFF_GRANTS: ReadonlyArray<StaffAccessGrant> = [
  {
    membership: FOUNDER,
    authority: createAuthorityContext({ tenantScope: OS_SCOPE, permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true }),
    assignments: [],
  },
];

const STAFF_OPTIONS: NodeRuntimeOptions = { devStaffSessionFixtures: SESSION_FIXTURES, staffAccessGrants: STAFF_GRANTS };

function grantFor(
  grantId: string,
  overrides: {
    scope?: ReadonlyArray<BreakGlassSupportViewKind>;
    consentRequired?: boolean;
    expiresAt?: string;
    target?: TenantScope;
    grantedToRef?: string;
  } = {},
): BreakGlassAccessGrant {
  return createBreakGlassAccessGrant({
    grantId,
    supportTenantScope: SUPPORT_SCOPE,
    targetTenantScope: overrides.target ?? OS_SCOPE,
    grantedToRef: overrides.grantedToRef ?? SUPPORT_PRINCIPAL,
    grantedByRef: FOUNDER_PRINCIPAL,
    reason: "C7 runtime witness: investigating a reported incident",
    scope: overrides.scope ?? ALL_KINDS,
    consentRequired: overrides.consentRequired ?? false,
    expiresAt: overrides.expiresAt ?? "2999-01-01T00:00:00.000Z",
  });
}

function grantStore(dataDir: string): FileDurableBreakGlassAccessGrantStore {
  return new FileDurableBreakGlassAccessGrantStore(fileDurableRuntimeStoreDir(dataDir, "breakGlassAccessGrants"));
}

function auditStore(dataDir: string): FileDurableBreakGlassSupportAccessAuditStore {
  return new FileDurableBreakGlassSupportAccessAuditStore(fileDurableRuntimeStoreDir(dataDir, "breakGlassSupportAccessAudits"));
}

function auditsFor(dataDir: string): ReadonlyArray<BreakGlassSupportAccessAudit> {
  return auditStore(dataDir).findByTargetTenant(OS_SCOPE);
}

/** Every file the audit store has ever written, in any tenant (its lock directory aside). */
function auditStoreDataFiles(dataDir: string): ReadonlyArray<string> {
  return readdirSync(fileDurableRuntimeStoreDir(dataDir, "breakGlassSupportAccessAudits")).filter((name) => !name.startsWith("."));
}

function seedGrant(dataDir: string, grant: BreakGlassAccessGrant): void {
  grantStore(dataDir).putIfAbsentGrant(grant);
}

function seedConnection(dataDir: string): void {
  const ownership = createProjectOwnershipRef({ tenantId: OS_TENANT, customerId: "customer-c7", projectId: "project-c7" });
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "C7 runtime API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:c7-runtime-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-c7",
    ownership,
    requiredCapabilityRef: "cap:c7-runtime-ping",
    purpose: "C7 runtime test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const instance = transitionConnectorConnection(
    requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: SEEDED_CONNECTION,
      workspaceRef: "workspace-c7",
      integrationInstanceRef: "instance-c7",
      delegatedScope: [],
      authMode: "API_KEY",
      secretRef: createSecretRef({ secretRefId: "secret-c7" }),
    }),
    "CONNECTED_UNVERIFIED",
  );
  new FileDurableConnectorConnectionStore(fileDurableRuntimeStoreDir(dataDir, "connectorConnections")).save(instance);
}

async function withRuntime(run: (handle: RuntimeHandle) => Promise<void>, seed?: (dataDir: string) => void): Promise<void> {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    seedConnection(dataDir);
    seed?.(dataDir);
    const runtime = createNodeRuntime(resolveAppConfig({ DATA_DIR: dataDir, ...OS_ENV }), STAFF_OPTIONS);
    const port = await listen(runtime.server);
    try {
      await run({ port, dataDir: runtime.dataDir });
    } finally {
      await close(runtime.server);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// --- raw HTTP/1.1 over node:net ---

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function decodeChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      break;
    }
    const size = parseInt(raw.subarray(offset, lineEnd).toString("latin1"), 16);
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function parseRawResponse(raw: Buffer): RawResponse {
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.ok(headerEnd > 0, `expected a complete HTTP response head, got ${JSON.stringify(raw.toString("latin1").slice(0, 200))}`);
  const [statusLine, ...headerLines] = raw.subarray(0, headerEnd).toString("latin1").split("\r\n");
  const status = Number(statusLine?.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const rawBody = raw.subarray(headerEnd + 4);
  const body = headers["transfer-encoding"] === "chunked" ? decodeChunked(rawBody) : rawBody;
  return { status, headers, body: body.toString("utf8") };
}

function rawRequest(port: number, input: { readonly method: string; readonly path: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(parseRawResponse(Buffer.concat(received)));
      } catch (error) {
        reject(error);
      }
    });
    const bodyBytes = Buffer.from(input.body ?? "", "utf8");
    const lines = [`${input.method} ${input.path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      lines.push(`${name}: ${value}`);
    }
    if (input.body !== undefined) {
      lines.push(`Content-Length: ${bodyBytes.length}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (bodyBytes.length > 0) {
      socket.write(bodyBytes);
    }
  });
}

function getAdmin(port: number, headers: Readonly<Record<string, string>>): Promise<RawResponse> {
  return rawRequest(port, { method: "GET", path: "/os/admin", headers });
}

function breakGlassHeaders(token: string | undefined, grantId: string, consentRef?: string): Record<string, string> {
  return {
    ...(token !== undefined ? { [STAFF_SESSION_TOKEN_HEADER]: token } : {}),
    [BREAK_GLASS_GRANT_ID_HEADER]: grantId,
    ...(consentRef !== undefined ? { [BREAK_GLASS_CONSENT_REF_HEADER]: consentRef } : {}),
  };
}

/** No break-glass response may echo the grant id, the session token, a consent ref, or an internal error. */
function assertNoLeak(response: RawResponse, ...values: ReadonlyArray<string>): void {
  for (const value of values) {
    assert.ok(!response.body.includes(value), `response body must not echo ${JSON.stringify(value)}`);
  }
  assert.doesNotMatch(response.body, /Error|grantedToRef|supportTenantId|tenant "/);
}

/**
 * A handler composed from the SAME durable stores and admin-relevant
 * sources the runtime wires, in-process. With `breakGlass` omitted it is
 * exactly the pre-C7 composition of `/os/admin`; the header-absent witness
 * compares the real socket's body against it byte for byte.
 */
function replicaAdminHandler(dataDir: string, breakGlass?: BreakGlassSupportAccessDeps): (request: IncomingRequestLike) => ReturnType<ReturnType<typeof createInternalOsRequestHandler>> {
  const stores = createFileDurableRuntimeStores(dataDir);
  return createCurrentStaffAccessGrantsInternalOsRequestHandler({
    provider: createDevFixtureStaffSessionProvider({ fixtures: new Map(SESSION_FIXTURES), isProduction: false }),
    organizationSource: createDurableInternalOsOrganizationSource(stores.controlledOrganizationProvisioningStore, { tenantId: OS_TENANT, organizationId: OS_ORG }),
    grantSource: { listCurrentGrants: () => STAFF_GRANTS },
    resourceBindingSource: createDurableOrganizationResourceBindingSource(
      stores.organizationResourceBindingStore,
      stores.organizationMembershipStore,
      stores.organizationServicePrincipalStore,
      stores.projectStore,
      stores.connectorConnectionStore,
      stores.configurationPolicyDecisionStore,
      stores.evidenceReferenceStore,
    ),
    operationalObservabilitySource: createDurableOperationalObservabilitySource(stores.connectorConnectionStore),
    customerOffboardingAdminSource: createDurableCustomerOffboardingAdminSource(stores.customerOffboardingRequestStore),
    customerOffboardingDecision: { requestStore: stores.customerOffboardingRequestStore, customerRepository: stores.customerRepository },
    ...(breakGlass !== undefined ? { breakGlass } : {}),
  });
}

/** Break-glass ports that fail the test if they are ever touched. */
function untouchableBreakGlass(): BreakGlassSupportAccessDeps & { readonly touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    grantStore: {
      getGrant: () => {
        touched.push("grantStore.getGrant");
        throw new Error("the grant store must not be touched");
      },
    },
    auditStore: {
      append: () => {
        touched.push("auditStore.append");
        throw new Error("the audit store must not be touched");
      },
    },
    clock: () => {
      touched.push("clock");
      return "2026-10-27T00:00:00.000Z";
    },
  };
}

// --- C7-R1: header absent - the single most important regression witness ---

test("C7-R1: an ordinary GET /os/admin with NO break-glass header is byte-for-byte the pre-C7 page - identical to a handler composed without break-glass, the break-glass ports are never touched, and nothing is audited", async () => {
  await withRuntime(async ({ port, dataDir }) => {
    const viaSocket = await getAdmin(port, { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_TOKEN });
    assert.equal(viaSocket.status, 200);
    assert.equal(viaSocket.headers["content-type"], "text/html; charset=utf-8");
    for (const heading of ["Organization", "Your access", "Resource binding", "Observability, audit &amp; recovery", "Pending offboarding requests", "Not yet active in this build"]) {
      assert.ok(viaSocket.body.includes(heading), `the ordinary admin page must still render "${heading}"`);
    }
    assert.ok(viaSocket.body.includes('class="app-nav"'), "the ordinary admin page still renders the member navigation");
    assert.ok(!viaSocket.body.includes("Break-glass"), "the ordinary admin page never mentions break-glass");

    const request: IncomingRequestLike = { method: "GET", path: "/os/admin", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_TOKEN } };
    const preC7 = replicaAdminHandler(dataDir)(request);
    assert.equal(viaSocket.status, preC7.status);
    assert.equal(viaSocket.body, preC7.body, "the real runtime's /os/admin body must be byte-identical to the composition without break-glass");

    const spies = untouchableBreakGlass();
    const withPorts = replicaAdminHandler(dataDir, spies)(request);
    assert.equal(withPorts.status, preC7.status);
    assert.equal(withPorts.body, preC7.body);
    // An EMPTY header value is "absent" too: the ordinary path, unchanged.
    const emptyHeader = replicaAdminHandler(dataDir, spies)({ ...request, headers: { ...request.headers, [BREAK_GLASS_GRANT_ID_HEADER]: "" } });
    assert.equal(emptyHeader.body, preC7.body);
    assert.deepEqual(spies.touched, [], "no break-glass port may be touched for a request without the header");

    // Every pre-C7 denial is unchanged too: a no-membership session is 403, no session is 401.
    const supportNoHeader = await getAdmin(port, { [STAFF_SESSION_TOKEN_HEADER]: SUPPORT_TOKEN });
    assert.equal(supportNoHeader.status, 403);
    assert.equal(supportNoHeader.body, replicaAdminHandler(dataDir)({ ...request, headers: { [STAFF_SESSION_TOKEN_HEADER]: SUPPORT_TOKEN } }).body);
    const anonymous = await getAdmin(port, {});
    assert.equal(anonymous.status, 401);

    assert.deepEqual(auditStoreDataFiles(dataDir), []);
  });
});

// --- C7-R2: no such grant ---

test("C7-R2: the header names a grant that does not exist (including one that exists only under a DIFFERENT target tenant) -> 403, the domain gate is never reached, and nothing is audited", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      for (const grantId of ["bg-c7-does-not-exist", "bg-c7-foreign-file"]) {
        const response = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, grantId));
        assert.equal(response.status, 403, grantId);
        assert.ok(response.body.includes("Access denied"));
        assert.ok(!response.body.includes('class="app-nav"'));
        assertNoLeak(response, grantId, SUPPORT_TOKEN);
      }
      assert.deepEqual(auditStoreDataFiles(dataDir), []);
    },
    (dataDir) => {
      // Stored under the foreign tenant's own file: a lookup under this
      // deployment's tenant can never find it.
      seedGrant(dataDir, grantFor("bg-c7-foreign-file", { target: FOREIGN_SCOPE }));
    },
  );
});

// --- C7-R3: full scope ---

test("C7-R3: a fully-active grant naming all five kinds -> 200 read-only break-glass page with all five families, and exactly five audit records durably appended, one per kind", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      const response = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-full"));
      assert.equal(response.status, 200);
      assert.ok(response.body.includes("Break-glass support access (read-only, audited)"));
      assert.ok(response.body.includes("AKILTA Zero (C7)"), "the page names this deployment's own organization");
      for (const kind of ALL_KINDS) {
        assert.ok(response.body.includes(SECTION_HEADING[kind]), `missing ${kind} section`);
      }
      assert.ok(response.body.includes(SEEDED_CONNECTION), "the real connection from the durable store is shown under CONNECTION");
      // Nothing beyond the operational-observability fields: no nav, no
      // organization/access/resource-binding/offboarding cards.
      assert.ok(!response.body.includes('class="app-nav"'));
      for (const adminOnly of ["Your access", "Resource binding", "Pending offboarding requests", "Not yet active in this build", "Observability, audit &amp; recovery"]) {
        assert.ok(!response.body.includes(adminOnly), `the break-glass page must not render "${adminOnly}"`);
      }
      assertNoLeak(response, "bg-c7-full", SUPPORT_TOKEN);

      const audits = auditsFor(dataDir);
      assert.equal(audits.length, 5);
      assert.deepEqual(audits.map((audit) => audit.requestedView), ALL_KINDS);
      for (const audit of audits) {
        assert.equal(audit.grantId, "bg-c7-full");
        assert.equal(audit.decidedByPrincipalRef, SUPPORT_PRINCIPAL);
        assert.equal(audit.supportTenantId, SUPPORT_SCOPE.tenantId);
        assert.equal(audit.targetTenantId, OS_TENANT);
        assert.ok(!Number.isNaN(Date.parse(audit.decidedAt)));
      }
      assert.equal(new Set(audits.map((audit) => audit.auditRef)).size, 5, "every audit record has its own auditRef");
      assert.equal(new Set(audits.map((audit) => audit.decidedAt)).size, 1, "all five decisions share one server-clock instant");

      // A second request appends five MORE records - one audit per access, never deduplicated away.
      assert.equal((await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-full"))).status, 200);
      assert.equal(auditsFor(dataDir).length, 10);
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-full")),
  );
});

// --- C7-R4: partial scope ---

test("C7-R4: a partial-scope grant (QUOTA, TASK) -> 200 showing ONLY task and quota - nothing for connections/approvals/audit-evidence - and exactly two audit records", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      const response = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-partial"));
      assert.equal(response.status, 200);
      assert.ok(response.body.includes(SECTION_HEADING.TASK));
      assert.ok(response.body.includes(SECTION_HEADING.QUOTA));
      for (const kind of ["CONNECTION", "APPROVALS", "AUDIT_EVIDENCE"] as const) {
        assert.ok(!response.body.includes(SECTION_HEADING[kind]), `${kind} must not be rendered`);
      }
      assert.ok(!response.body.includes(SEEDED_CONNECTION), "a connection the grant did not admit must never reach the page");
      assert.ok(!response.body.includes("No connections tracked"), "an un-admitted kind is not even shown as empty");

      const audits = auditsFor(dataDir);
      assert.equal(audits.length, 2);
      assert.deepEqual(audits.map((audit) => audit.requestedView), ["TASK", "QUOTA"]);
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-partial", { scope: ["QUOTA", "TASK"] })),
  );
});

test("C7-R4b: against a source that populates EVERY dimension, a partial-scope grant (QUOTA, TASK) exposes only task and quota data - resolveBreakGlassObservabilityView copies across only the granted fields", () => {
  const fullView = {
    task: { runStatus: "RUNNING", currentAttempt: 2, workerHealth: "ACTIVE" },
    connections: [{ connectionBindingId: "conn-c7-hidden", connectionState: "VERIFIED", killSwitchEngaged: false, degraded: false }],
    quota: { unitLimit: 10, unitReserved: 3, unitCommitted: 1, unitRemaining: 6 },
    pendingApprovals: [{ waitRequestId: "wait-c7-hidden", effectRef: "effect", decisionRef: "decision", raisedAt: "2026-10-27T00:00:00.000Z", resolved: false }],
    auditEvidence: [{ evidenceId: "evidence-c7-hidden", evidenceType: "SCREENSHOT", capturedAt: "2026-10-27T00:00:00.000Z" }],
  } as unknown as ReturnType<OperationalObservabilitySource["resolveView"]>;
  const organization: Organization = activateOrganization({
    organization: createOrganization({ organizationId: OS_ORG, tenantScope: OS_SCOPE, displayName: "AKILTA Zero (C7 full source)", createdAt: "2026-10-23T00:00:00.000Z" }),
    activatedAt: "2026-10-23T00:00:01.000Z",
  });
  const appended: BreakGlassSupportAccessAudit[] = [];
  const handler = createInternalOsRequestHandler({
    provider: createDevFixtureStaffSessionProvider({ fixtures: new Map(SESSION_FIXTURES), isProduction: false }),
    organization,
    grants: STAFF_GRANTS,
    operationalObservabilitySource: { resolveView: () => fullView },
    breakGlass: {
      grantStore: { getGrant: () => grantFor("bg-c7-partial-full", { scope: ["QUOTA", "TASK"] }) },
      auditStore: { append: (audit) => void appended.push(audit) },
    },
  });
  const response = handler({ method: "GET", path: "/os/admin", headers: breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-partial-full") });
  assert.equal(response.status, 200);
  assert.ok(response.body.includes("RUNNING"));
  assert.ok(response.body.includes("Quota: 3/10 reserved, 1 committed, 6 remaining"));
  for (const hidden of ["conn-c7-hidden", "wait-c7-hidden", "evidence-c7-hidden"]) {
    assert.ok(!response.body.includes(hidden), `${hidden} must never reach the page`);
  }
  assert.deepEqual(appended.map((audit) => audit.requestedView), ["TASK", "QUOTA"]);

  const resolved = resolveBreakGlassObservabilityView({ organization, grantedKinds: ["QUOTA", "TASK", "QUOTA"], source: { resolveView: () => fullView } });
  assert.equal(resolved.kind, "READY");
  assert.deepEqual(resolved.grantedKinds, ["TASK", "QUOTA"]);
  if (resolved.kind === "READY") {
    assert.deepEqual(resolved.view, { task: fullView.task, connections: [], quota: fullView.quota, pendingApprovals: [], auditEvidence: [] });
    assert.notEqual(resolved.view, fullView, "a new object - never the source's own result");
  }
});

// --- C7-R5..R7: unusable grants ---

test("C7-R5/R6: an expired grant and a revoked grant -> 403 with zero audit records", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      for (const grantId of ["bg-c7-expired", "bg-c7-revoked"]) {
        const response = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, grantId));
        assert.equal(response.status, 403, grantId);
        assertNoLeak(response, grantId);
      }
      assert.deepEqual(auditStoreDataFiles(dataDir), []);
    },
    (dataDir) => {
      seedGrant(dataDir, grantFor("bg-c7-expired", { expiresAt: "2000-01-01T00:00:00.000Z" }));
      seedGrant(dataDir, grantFor("bg-c7-revoked"));
      grantStore(dataDir).reviseGrant({
        targetTenantScope: OS_SCOPE,
        grantId: "bg-c7-revoked",
        revise: (current) => revokeBreakGlassAccessGrant({ grant: current, revokedAt: "2026-10-26T00:00:00.000Z", revokedReason: "incident closed" }),
      });
    },
  );
});

test("C7-R7: identity mismatch - a different authenticated support principal, and even a full MEMBER of this organization, presenting someone else's grant -> 403 with zero audit records (the branch never falls back to the member path)", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      for (const token of [OTHER_SUPPORT_TOKEN, FOUNDER_TOKEN]) {
        const response = await getAdmin(port, breakGlassHeaders(token, "bg-c7-identity"));
        assert.equal(response.status, 403, token);
        assertNoLeak(response, "bg-c7-identity", token);
      }
      assert.deepEqual(auditStoreDataFiles(dataDir), []);
      // The founder without the header still gets the ordinary admin page.
      assert.equal((await getAdmin(port, { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_TOKEN })).status, 200);
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-identity")),
  );
});

test("C7-R5 (foreign tenant, through the domain gate): a compromised grant lookup that hands back a grant targeting a DIFFERENT tenant is denied for every kind by the gate itself -> 403, zero audits, and the observability source is never read", () => {
  const organization: Organization = activateOrganization({
    organization: createOrganization({ organizationId: OS_ORG, tenantScope: OS_SCOPE, displayName: "AKILTA Zero (C7 in-process)", createdAt: "2026-10-23T00:00:00.000Z" }),
    activatedAt: "2026-10-23T00:00:01.000Z",
  });
  const appended: BreakGlassSupportAccessAudit[] = [];
  let sourceReads = 0;
  const handler = createInternalOsRequestHandler({
    provider: createDevFixtureStaffSessionProvider({ fixtures: new Map(SESSION_FIXTURES), isProduction: false }),
    organization,
    grants: STAFF_GRANTS,
    operationalObservabilitySource: {
      resolveView: () => {
        sourceReads += 1;
        return composeOperationalObservabilityView({});
      },
    },
    breakGlass: {
      grantStore: { getGrant: () => grantFor("bg-c7-foreign", { target: FOREIGN_SCOPE }) },
      auditStore: { append: (audit) => void appended.push(audit) },
    },
  });
  const response = handler({ method: "GET", path: "/os/admin", headers: breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-foreign") });
  assert.equal(response.status, 403);
  assert.deepEqual(appended, []);
  assert.equal(sourceReads, 0);
});

// --- C7-R8: consent ---

test("C7-R8: a consent-required grant -> 403 with zero audits when no consent header is sent (or it is blank); supplying the consent header -> 200 for the in-scope kinds", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      for (const consent of [undefined, "   "]) {
        const response = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-consent", consent));
        assert.equal(response.status, 403, String(consent));
      }
      assert.deepEqual(auditStoreDataFiles(dataDir), []);

      const consented = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-consent", "consent-c7-session-1"));
      assert.equal(consented.status, 200);
      assert.ok(consented.body.includes(SECTION_HEADING.CONNECTION));
      assert.ok(consented.body.includes(SECTION_HEADING.APPROVALS));
      assert.ok(!consented.body.includes(SECTION_HEADING.TASK));
      assertNoLeak(consented, "consent-c7-session-1");
      assert.deepEqual(auditsFor(dataDir).map((audit) => audit.requestedView), ["CONNECTION", "APPROVALS"]);
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-consent", { scope: ["CONNECTION", "APPROVALS"], consentRequired: true })),
  );
});

// --- C7-R9: unauthenticated ---

test("C7-R9: the grant header is present but the staff session is absent or forged -> 401 (not 403, not a crash) - identically for a real grant id and an unknown one, so 401/403 is never a grant-existence oracle - and nothing is audited", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      for (const grantId of ["bg-c7-unauth", "bg-c7-unknown"]) {
        for (const token of [undefined, "not-a-real-token"]) {
          const response = await getAdmin(port, breakGlassHeaders(token, grantId));
          assert.equal(response.status, 401, `${grantId} / ${String(token)}`);
          assert.ok(response.body.includes("Sign-in required"));
          assertNoLeak(response, grantId);
        }
      }
      assert.deepEqual(auditStoreDataFiles(dataDir), []);
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-unauth")),
  );
});

// --- C7-R10: zero write affordance ---

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("C7-R10: the break-glass page carries no write affordance at all - no form and no button in the rendered HTML - and no new src/web module renders one", async () => {
  await withRuntime(
    async ({ port }) => {
      const response = await getAdmin(port, breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-readonly"));
      assert.equal(response.status, 200);
      assert.doesNotMatch(response.body, /<form/i);
      assert.doesNotMatch(response.body, /<button/i);
      assert.doesNotMatch(response.body, /<input/i);
      assert.doesNotMatch(response.body, /method="post"/i);
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-readonly")),
  );
  // The source-level allow-list (`web-internal-os-offboarding-decision.test.ts`)
  // is NOT widened by C7: none of the files C7 touches in src/web contains a
  // form or button tag.
  for (const file of ["src/web/authenticated-break-glass-support-access.ts", "src/web/internal-os-render.ts", "src/web/internal-os-request-handler.ts", "src/web/internal-os-view-state.ts"]) {
    assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), "utf8"), /<form\b|<button/i, file);
  }
});

// --- C7-R11: the unwired-source edge case ---

test("C7-R11: with no operationalObservabilitySource wired, a valid grant renders the break-glass page's NOT ACTIVE state (200, still audited per granted kind) - never a crash and never fabricated data", () => {
  const organization: Organization = activateOrganization({
    organization: createOrganization({ organizationId: OS_ORG, tenantScope: OS_SCOPE, displayName: "AKILTA Zero (C7 unwired)", createdAt: "2026-10-23T00:00:00.000Z" }),
    activatedAt: "2026-10-23T00:00:01.000Z",
  });
  const appended: BreakGlassSupportAccessAudit[] = [];
  const deps: InternalOsRequestHandlerDeps = {
    provider: createDevFixtureStaffSessionProvider({ fixtures: new Map(SESSION_FIXTURES), isProduction: false }),
    organization,
    grants: STAFF_GRANTS,
    breakGlass: {
      grantStore: { getGrant: (scope, grantId) => (scope.tenantId === OS_TENANT && grantId === "bg-c7-unwired" ? grantFor("bg-c7-unwired", { scope: ["TASK"] }) : undefined) },
      auditStore: { append: (audit) => void appended.push(audit) },
      clock: () => "2026-10-27T00:00:00.000Z",
    },
  };
  const response = createInternalOsRequestHandler(deps)({ method: "GET", path: "/os/admin", headers: breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-unwired") });
  assert.equal(response.status, 200);
  assert.ok(response.body.includes("NOT ACTIVE"));
  assert.ok(!response.body.includes(SECTION_HEADING.TASK));
  assert.deepEqual(appended.map((audit) => [audit.requestedView, audit.decidedAt]), [["TASK", "2026-10-27T00:00:00.000Z"]]);
});

test("C7-R11b: the observability source is resolved exactly ONCE per break-glass request, and only after at least one kind was granted", () => {
  const organization: Organization = activateOrganization({
    organization: createOrganization({ organizationId: OS_ORG, tenantScope: OS_SCOPE, displayName: "AKILTA Zero (C7 once)", createdAt: "2026-10-23T00:00:00.000Z" }),
    activatedAt: "2026-10-23T00:00:01.000Z",
  });
  let reads = 0;
  const source: OperationalObservabilitySource = {
    resolveView: () => {
      reads += 1;
      return composeOperationalObservabilityView({});
    },
  };
  const handler = createInternalOsRequestHandler({
    provider: createDevFixtureStaffSessionProvider({ fixtures: new Map(SESSION_FIXTURES), isProduction: false }),
    organization,
    grants: STAFF_GRANTS,
    operationalObservabilitySource: source,
    breakGlass: {
      grantStore: { getGrant: () => grantFor("bg-c7-once") },
      auditStore: { append: () => undefined },
    },
  });
  assert.equal(handler({ method: "GET", path: "/os/admin", headers: breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-once") }).status, 200);
  assert.equal(reads, 1);
  assert.equal(handler({ method: "GET", path: "/os/admin", headers: breakGlassHeaders(OTHER_SUPPORT_TOKEN, "bg-c7-once") }).status, 403);
  assert.equal(reads, 1, "a fully-denied request never reads the source");
});

// --- C7-R12: everything else is unchanged ---

test("C7-R12: everything else is unchanged - the break-glass header on any other destination is ignored (ordinary behavior), a POST to /os/admin with it stays 501, and /health carries both new store probes", async () => {
  await withRuntime(
    async ({ port, dataDir }) => {
      for (const path of ["/os", "/os/home", "/os/connections", "/os/people", "/os/attention", "/os/knowledge"]) {
        const asFounder = await rawRequest(port, { method: "GET", path, headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_TOKEN } });
        const asFounderWithHeader = await rawRequest(port, { method: "GET", path, headers: breakGlassHeaders(FOUNDER_TOKEN, "bg-c7-other") });
        assert.equal(asFounderWithHeader.status, asFounder.status, path);
        assert.equal(asFounderWithHeader.body, asFounder.body, path);
        const supportWithHeader = await rawRequest(port, { method: "GET", path, headers: breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-other") });
        assert.equal(supportWithHeader.status, 403, `${path}: a non-member stays forbidden everywhere but the break-glass admin branch`);
      }
      const post = await rawRequest(port, { method: "POST", path: "/os/admin", headers: breakGlassHeaders(SUPPORT_TOKEN, "bg-c7-other"), body: "" });
      assert.equal(post.status, 501);
      assert.deepEqual(auditStoreDataFiles(dataDir), []);

      const health = await rawRequest(port, { method: "GET", path: "/health" });
      assert.equal(health.status, 200);
      const probes = (JSON.parse(health.body) as { probes: Array<{ name: string; healthy: boolean }> }).probes;
      for (const name of ["file-store:break-glass-access-grants", "file-store:break-glass-support-access-audits"]) {
        assert.ok(probes.some((probe) => probe.name === name && probe.healthy), name);
      }
    },
    (dataDir) => seedGrant(dataDir, grantFor("bg-c7-other")),
  );
});
