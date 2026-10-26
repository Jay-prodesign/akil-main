import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { Server } from "node:http";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import { createNodeRuntime, type NodeRuntimeOptions } from "../src/runtime/node-server-entrypoint.js";
import { fileDurableRuntimeStoreDir } from "../src/runtime/file-durable-runtime-stores.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef, type ConnectionState } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { INTERNAL_OS_MAX_REQUEST_BODY_BYTES } from "../src/web/http-server.js";
import { connectorConnectionStatePath } from "../src/web/internal-os-connection-state-controls.js";

/**
 * C4 slice 2 (gap scan 2026-10-23, second `/os` mutation slice): the
 * connector-connection state-mutation POST route, exercised through the
 * deployable runtime's real composition root (`createNodeRuntime`) over a
 * real TCP socket - mirrors `runtime-offboarding-decision-route.test.ts`'s
 * own structure and hunt-list exactly. Requests are written byte-for-byte
 * with `node:net`, so every header (including the absence of `Origin`) is
 * exactly what the test says, and the body really crosses the wire.
 */

const OS_TENANT = "tenant-c4s2-os";
const OS_ORG = "org-c4s2-zero";
const FOUNDER_PRINCIPAL = "staff-c4s2-founder";
const FOUNDER_MEMBERSHIP = "membership-c4s2-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };

const FOUNDER_TOKEN = "dev-staff-token-c4s2-founder";
const WRITER_TOKEN = "dev-staff-token-c4s2-writer";
const ADMIN_NO_EXECUTE_TOKEN = "dev-staff-token-c4s2-admin-no-execute";
const READER_TOKEN = "dev-staff-token-c4s2-reader";
const STRANGER_TOKEN = "dev-staff-token-c4s2-stranger";

const FORM = "application/x-www-form-urlencoded";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c4s2-runtime-data-"));
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

async function withRuntime(
  options: NodeRuntimeOptions,
  run: (handle: RuntimeHandle) => Promise<void>,
  seed?: (dataDir: string) => void,
): Promise<void> {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    seed?.(dataDir);
    const runtime = createNodeRuntime(resolveAppConfig({ DATA_DIR: dataDir, ...OS_ENV }), options);
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

function provisionOsOrganization(dataDir: string): OrganizationMembership {
  const store = new FileDurableControlledOrganizationProvisioningStore(
    fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"),
  );
  const outcome = store.provision({
    tenantScope: createTenantScope(OS_TENANT),
    organizationId: OS_ORG,
    displayName: "AKILTA Zero (C4 slice 2)",
    founderMembershipId: FOUNDER_MEMBERSHIP,
    founderPrincipalRef: FOUNDER_PRINCIPAL,
    idempotencyKey: "c4s2-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

function session(principalId: string): StaffSessionContext {
  return {
    principal: createAuthenticatedStaffPrincipal({ principalId, displayName: principalId }),
    issuedAt: "2026-10-23T00:00:00.000Z",
  };
}

function grant(
  membership: OrganizationMembership,
  permissions: ReadonlyArray<Permission>,
  canPerformProtectedActions: boolean,
  role?: "OWNER" | "ADMIN",
): StaffAccessGrant {
  return {
    membership,
    authority: createAuthorityContext({ tenantScope: createTenantScope(OS_TENANT), permissions, canPerformProtectedActions }),
    assignments: [],
    ...(role !== undefined ? { roleContext: createOrganizationAccessRoleContext({ membership, role }) } : {}),
  };
}

function staffMembership(membershipId: string, principalRef: string): OrganizationMembership {
  return createOrganizationMembership({ membershipId, tenantScope: createTenantScope(OS_TENANT), principalRef, role: "STAFF" });
}

/**
 * Five staff sessions:
 * - founder: the provisioned founder membership, a curated OWNER role,
 *   READ/WRITE/EXECUTE plus protected-action authority (may mutate state);
 * - writer: READ/WRITE, no curated role (defaults to MEMBER), no
 *   protected-action authority (may reach `/os/connections` but may not
 *   mutate - fails the domain mutation's role floor);
 * - adminNoExecute: a curated ADMIN role, READ/WRITE but no EXECUTE and no
 *   protected-action authority - clears the role floor but fails the
 *   EXECUTE-permission floor specifically;
 * - reader: READ only (may not reach `/os/connections` at all);
 * - stranger: a valid session whose principal has no membership at all.
 */
function staffOptions(founderMembership: OrganizationMembership): NodeRuntimeOptions {
  return {
    devStaffSessionFixtures: new Map([
      [FOUNDER_TOKEN, session(FOUNDER_PRINCIPAL)],
      [WRITER_TOKEN, session("staff-c4s2-writer")],
      [ADMIN_NO_EXECUTE_TOKEN, session("staff-c4s2-admin-no-execute")],
      [READER_TOKEN, session("staff-c4s2-reader")],
      [STRANGER_TOKEN, session("staff-c4s2-stranger")],
    ]),
    staffAccessGrants: [
      grant(founderMembership, ["READ", "WRITE", "EXECUTE"], true, "OWNER"),
      grant(staffMembership("membership-c4s2-writer", "staff-c4s2-writer"), ["READ", "WRITE"], false),
      grant(staffMembership("membership-c4s2-admin-no-execute", "staff-c4s2-admin-no-execute"), ["READ", "WRITE"], false, "ADMIN"),
      grant(staffMembership("membership-c4s2-reader", "staff-c4s2-reader"), ["READ"], false),
    ],
  };
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

function connectorConnectionStore(dataDir: string): FileDurableConnectorConnectionStore {
  return new FileDurableConnectorConnectionStore(fileDurableRuntimeStoreDir(dataDir, "connectorConnections"));
}

function ownershipFor(connectionBindingId: string): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: OS_TENANT,
    customerId: `customer-${connectionBindingId}`,
    projectId: `project-${connectionBindingId}`,
  });
}

/** Builds a REQUESTED connection, then transitions it to `at` before seeding the store. */
function seedConnection(dataDir: string, connectionBindingId: string, at: ConnectionState): ConnectorConnectionInstance {
  const ownership = ownershipFor(connectionBindingId);
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "C4 slice 2 runtime API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:c4s2-runtime-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${connectionBindingId}`,
    ownership,
    requiredCapabilityRef: "cap:c4s2-runtime-ping",
    purpose: "C4 slice 2 runtime test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  const store = connectorConnectionStore(dataDir);
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-c4s2-runtime",
    integrationInstanceRef: "instance-c4s2-runtime",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: `secret-${connectionBindingId}` }),
  });
  if (at !== "REQUESTED") {
    instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  }
  if (at === "VERIFIED" || at === "DEGRADED" || at === "REVOKED" || at === "HANDOVER_COMPLETE") {
    instance = verifyConnectorConnection(instance, `evidence-${connectionBindingId}`);
  }
  if (at === "DEGRADED" || at === "REVOKED" || at === "HANDOVER_COMPLETE") {
    instance = transitionConnectorConnection(instance, at);
  }
  store.save(instance);
  return instance;
}

function readConnectionState(dataDir: string, connectionBindingId: string): ConnectionState | undefined {
  return connectorConnectionStore(dataDir).get(createTenantScope(OS_TENANT).tenantId, connectionBindingId as never)?.instance.binding
    .connectionState;
}

function readConnectionVersion(dataDir: string, connectionBindingId: string): number | undefined {
  return connectorConnectionStore(dataDir).get(createTenantScope(OS_TENANT).tenantId, connectionBindingId as never)?.version;
}

function assertUnchanged(dataDir: string, connectionBindingId: string, expectedState: ConnectionState, expectedVersion: number): void {
  assert.equal(readConnectionState(dataDir, connectionBindingId), expectedState, `${connectionBindingId} must still be ${expectedState}`);
  assert.equal(readConnectionVersion(dataDir, connectionBindingId), expectedVersion, `${connectionBindingId} must still be at version ${expectedVersion}`);
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

/**
 * Sends one request on a fresh connection (`Connection: close`) and reads
 * the response to EOF. `Host` defaults to the real listening address;
 * pass `host: null` to send no Host header at all. `Content-Length` is
 * computed from the UTF-8 body unless `contentLength` overrides it.
 */
function rawRequest(
  port: number,
  input: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly contentLength?: number;
    readonly host?: string | null;
  },
): Promise<RawResponse> {
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
    const lines = [`${input.method} ${input.path} HTTP/1.1`];
    const host = input.host === undefined ? `127.0.0.1:${port}` : input.host;
    if (host !== null) {
      lines.push(`Host: ${host}`);
    }
    lines.push("Connection: close");
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      lines.push(`${name}: ${value}`);
    }
    if (input.body !== undefined || input.contentLength !== undefined) {
      lines.push(`Content-Length: ${input.contentLength ?? bodyBytes.length}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (bodyBytes.length > 0) {
      socket.write(bodyBytes);
    }
  });
}

function postForm(
  port: number,
  path: string,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<RawResponse> {
  return rawRequest(port, { method: "POST", path, headers: { "Content-Type": FORM, ...headers }, body });
}

function asStaff(token: string): Record<string, string> {
  return { [STAFF_SESSION_TOKEN_HEADER]: token };
}

/** No error response from the decision route may echo a submitted value, a connectionBindingId, a tenant id, or an internal error message. */
function assertNoLeak(response: RawResponse, ...submitted: ReadonlyArray<string>): void {
  for (const value of submitted) {
    assert.ok(!response.body.includes(value), `response body must not echo ${JSON.stringify(value)}`);
  }
  assert.doesNotMatch(response.body, /Error|conflict:|ConnectorConnection|tenant "/);
}

const FOUNDER = founderMembershipFor();

// --- C4S2-R1..R3: the real mutation, end to end ---

test("C4S2-R1: a real HTTP POST (raw socket, no Origin header) transitions a connection - the body is read off the wire, the durable store shows the new state, and the response is 303 to /os/connections", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, connectorConnectionStatePath("bind-c4s2-transition"), "to=DEGRADED", asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 303);
      assert.equal(response.headers["location"], "/os/connections");
      assert.equal(readConnectionState(dataDir, "bind-c4s2-transition"), "DEGRADED");
      assert.equal(readConnectionVersion(dataDir, "bind-c4s2-transition"), 2);

      const connections = await rawRequest(port, { method: "GET", path: "/os/connections", headers: asStaff(FOUNDER_TOKEN) });
      assert.equal(connections.status, 200);
      assert.match(connections.body, /DEGRADED/);
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-transition", "VERIFIED");
    },
  );
});

test("C4S2-R2: the domain mutation always re-reads the current version fresh, so there is no caller-supplied version to go stale - two sequential transitions from the same founder both succeed", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const first = await postForm(port, connectorConnectionStatePath("bind-c4s2-sequential"), "to=DEGRADED", asStaff(FOUNDER_TOKEN));
      assert.equal(first.status, 303);
      assert.equal(readConnectionState(dataDir, "bind-c4s2-sequential"), "DEGRADED");
      assert.equal(readConnectionVersion(dataDir, "bind-c4s2-sequential"), 2);

      const second = await postForm(port, connectorConnectionStatePath("bind-c4s2-sequential"), "to=REVOKED", asStaff(FOUNDER_TOKEN));
      assert.equal(second.status, 303);
      assert.equal(readConnectionState(dataDir, "bind-c4s2-sequential"), "REVOKED");
      assert.equal(readConnectionVersion(dataDir, "bind-c4s2-sequential"), 3);
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-sequential", "VERIFIED");
    },
  );
});

test("C4S2-R3: an illegal transition (VERIFIED -> CONNECTED_UNVERIFIED) is 409 with zero store change - the domain's own transition table is the sole source of truth, never duplicated in the web layer", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, connectorConnectionStatePath("bind-c4s2-illegal"), "to=CONNECTED_UNVERIFIED", asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 409);
      assertNoLeak(response, "bind-c4s2-illegal");
      assertUnchanged(dataDir, "bind-c4s2-illegal", "VERIFIED", 1);

      // REQUESTED has no legal edge straight to VERIFIED either (see
      // CONNECTION_MAIN_TRANSITIONS) - only through CONNECTED_UNVERIFIED.
      const requestedAttempt = await postForm(port, connectorConnectionStatePath("bind-c4s2-requested"), "to=VERIFIED", asStaff(FOUNDER_TOKEN));
      assert.equal(requestedAttempt.status, 409);
      assertUnchanged(dataDir, "bind-c4s2-requested", "REQUESTED", 1);
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-illegal", "VERIFIED");
      seedConnection(dataDir, "bind-c4s2-requested", "REQUESTED");
    },
  );
});

test("C4S2-R4: a nonexistent connectionBindingId is 403, never 404 - this route deliberately never gives an existence-enumeration oracle via status code", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const response = await postForm(port, connectorConnectionStatePath("bind-c4s2-missing"), "to=DEGRADED", asStaff(FOUNDER_TOKEN));
    assert.equal(response.status, 403);
    assertNoLeak(response, "bind-c4s2-missing");
    assert.equal(readConnectionState(dataDir, "bind-c4s2-missing"), undefined);
  });
});

// --- C4S2-R5: every access/authority failure mode, with zero store mutation ---

test("C4S2-R5: every requireInternalOsAccess / destination-gate / domain-authority failure mode fails closed exactly as on GET, with zero store mutation", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const body = "to=DEGRADED";

      const cases: ReadonlyArray<{ label: string; headers: Record<string, string>; status: number }> = [
        { label: "no session token", headers: {}, status: 401 },
        { label: "unknown session token", headers: asStaff("not-a-real-token"), status: 401 },
        { label: "session with no membership", headers: asStaff(STRANGER_TOKEN), status: 403 },
        { label: "READ-only staff cannot even reach /os/connections", headers: asStaff(READER_TOKEN), status: 403 },
        { label: "WRITE without a curated OWNER/ADMIN role cannot mutate", headers: asStaff(WRITER_TOKEN), status: 403 },
        { label: "curated ADMIN role but no EXECUTE permission cannot mutate", headers: asStaff(ADMIN_NO_EXECUTE_TOKEN), status: 403 },
      ];
      for (const entry of cases) {
        const response = await postForm(port, connectorConnectionStatePath("bind-c4s2-authz"), body, entry.headers);
        assert.equal(response.status, entry.status, entry.label);
        assertNoLeak(response, "bind-c4s2-authz");
        assertUnchanged(dataDir, "bind-c4s2-authz", "VERIFIED", 1);
      }

      // The same WRITE-only viewer can still reach the read-only page, just
      // without the control.
      const writerPage = await rawRequest(port, { method: "GET", path: "/os/connections", headers: asStaff(WRITER_TOKEN) });
      assert.equal(writerPage.status, 200);
      assert.doesNotMatch(writerPage.body, /<form/i);

      // The READ-only viewer cannot even reach the destination.
      const readerPage = await rawRequest(port, { method: "GET", path: "/os/connections", headers: asStaff(READER_TOKEN) });
      assert.equal(readerPage.status, 403);
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-authz", "VERIFIED");
    },
  );
});

// --- C4S2-R6: same-origin defense in depth ---

test("C4S2-R6: a POST with a foreign Origin, Origin: null, or Sec-Fetch-Site: cross-site is 403 with zero store change even with a valid staff session; a same-origin Origin succeeds", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const body = "to=DEGRADED";
      for (const headers of [
        { Origin: "https://attacker.example" },
        { Origin: `http://127.0.0.1:${port + 1}` },
        { Origin: "null" },
        { "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Site": "same-site" },
      ]) {
        const response = await postForm(port, connectorConnectionStatePath("bind-c4s2-origin"), body, { ...asStaff(FOUNDER_TOKEN), ...headers });
        assert.equal(response.status, 403, JSON.stringify(headers));
        assertUnchanged(dataDir, "bind-c4s2-origin", "VERIFIED", 1);
      }

      const sameOrigin = await postForm(port, connectorConnectionStatePath("bind-c4s2-origin"), body, {
        ...asStaff(FOUNDER_TOKEN),
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
      });
      assert.equal(sameOrigin.status, 303);
      assert.equal(readConnectionState(dataDir, "bind-c4s2-origin"), "DEGRADED");
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-origin", "VERIFIED");
    },
  );
});

// --- C4S2-R7: request parsing ---

test("C4S2-R7: a malformed body is a clean 400 with zero store change - never a crash; and an unauthenticated malformed POST is 401, not 400 (the session is checked before the body is parsed)", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const connectionBindingId = "bind-c4s2-malformed";
      const malformed: ReadonlyArray<{ label: string; body: string; contentType?: string }> = [
        { label: "JSON content type", body: JSON.stringify({ to: "DEGRADED" }), contentType: "application/json" },
        { label: "no content type", body: "to=DEGRADED", contentType: "" },
        { label: "empty body", body: "" },
        { label: "unrecognized state", body: "to=NOT_A_STATE" },
        { label: "lowercase state", body: "to=degraded" },
        { label: "missing to", body: "other=DEGRADED" },
        { label: "duplicate to", body: "to=DEGRADED&to=REVOKED" },
        { label: "unknown field expectedVersion", body: "to=DEGRADED&expectedVersion=1" },
      ];
      for (const entry of malformed) {
        const headers: Record<string, string> = { ...asStaff(FOUNDER_TOKEN) };
        const response = await rawRequest(port, {
          method: "POST",
          path: connectorConnectionStatePath(connectionBindingId),
          headers: entry.contentType === "" ? headers : { ...headers, "Content-Type": entry.contentType ?? FORM },
          body: entry.body,
        });
        assert.equal(response.status, 400, entry.label);
        assertUnchanged(dataDir, connectionBindingId, "VERIFIED", 1);
      }

      const unauthenticated = await rawRequest(port, {
        method: "POST",
        path: connectorConnectionStatePath(connectionBindingId),
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      assert.equal(unauthenticated.status, 401);
      assertUnchanged(dataDir, connectionBindingId, "VERIFIED", 1);

      // A well-formed submission still works after all those rejections.
      const ok = await postForm(port, connectorConnectionStatePath(connectionBindingId), "to=DEGRADED", asStaff(FOUNDER_TOKEN));
      assert.equal(ok.status, 303);
      assert.equal(readConnectionState(dataDir, connectionBindingId), "DEGRADED");
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-malformed", "VERIFIED");
    },
  );
});

// --- C4S2-R8: body size cap (memory-exhaustion DoS) ---

test(`C4S2-R8: a body of exactly the cap (${INTERNAL_OS_MAX_REQUEST_BODY_BYTES} bytes) is read and reaches form parsing (never 413); one byte more is 413 with zero store change, before the body is ever parsed - this route's own form has no free-text field to pad with, so both bodies use an oversized, necessarily-malformed \`to\` value: the point is the SIZE cap firing independently of content legality`, async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const overBody = `to=${"D".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES + 1 - "to=".length)}`;
      assert.equal(Buffer.byteLength(overBody), INTERNAL_OS_MAX_REQUEST_BODY_BYTES + 1);
      const over = await postForm(port, connectorConnectionStatePath("bind-c4s2-cap-over"), overBody, asStaff(FOUNDER_TOKEN));
      assert.equal(over.status, 413);
      assertUnchanged(dataDir, "bind-c4s2-cap-over", "VERIFIED", 1);

      const exactBody = `to=${"D".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES - "to=".length)}`;
      assert.equal(Buffer.byteLength(exactBody), INTERNAL_OS_MAX_REQUEST_BODY_BYTES);
      const exact = await postForm(port, connectorConnectionStatePath("bind-c4s2-cap-exact"), exactBody, asStaff(FOUNDER_TOKEN));
      // Not a recognized ConnectionState, so 400 - but critically NOT 413:
      // the exact-cap body was read in full and reached form parsing.
      assert.equal(exact.status, 400);
      assertUnchanged(dataDir, "bind-c4s2-cap-exact", "VERIFIED", 1);
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-cap-over", "VERIFIED");
      seedConnection(dataDir, "bind-c4s2-cap-exact", "VERIFIED");
    },
  );
});

test("C4S2-R9: a declared Content-Length above the cap is answered 413 at once, before any body byte is sent - authenticated or not - and nothing is changed", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      for (const headers of [asStaff(FOUNDER_TOKEN), {}]) {
        const response = await rawRequest(port, {
          method: "POST",
          path: connectorConnectionStatePath("bind-c4s2-declared"),
          headers: { ...headers, "Content-Type": FORM },
          contentLength: 10 * 1024 * 1024,
        });
        assert.equal(response.status, 413);
        assert.equal(response.headers["connection"], "close");
        assertUnchanged(dataDir, "bind-c4s2-declared", "VERIFIED", 1);
      }
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-declared", "VERIFIED");
    },
  );
});

test("C4S2-R10: an oversized chunked body with no Content-Length is cut off - the server stops reading and closes the connection long before the sender finishes, and the (otherwise valid) transition inside it never runs", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const LIMIT = 64 * 1024 * 1024;
      const result = await new Promise<{ written: number; received: Buffer }>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        const received: Buffer[] = [];
        let written = 0;
        let closed = false;
        socket.on("data", (chunk: Buffer) => received.push(chunk));
        socket.on("error", () => {
          // EPIPE / ECONNRESET once the server has destroyed the socket.
        });
        socket.on("close", () => {
          closed = true;
          resolve({ written, received: Buffer.concat(received) });
        });
        socket.write(
          [
            `POST ${connectorConnectionStatePath("bind-c4s2-stream")} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Connection: close",
            `${STAFF_SESSION_TOKEN_HEADER}: ${FOUNDER_TOKEN}`,
            `Content-Type: ${FORM}`,
            "Transfer-Encoding: chunked",
            "",
            "",
          ].join("\r\n"),
        );
        // A valid-looking form whose field just never ends. If the server
        // buffered it all and ran the handler, the connection would transition.
        const head = Buffer.from("to=DEGRADED&padding=", "utf8");
        const filler = Buffer.alloc(64 * 1024, "a");
        const frame = (payload: Buffer): Buffer => Buffer.concat([Buffer.from(`${payload.length.toString(16)}\r\n`), payload, Buffer.from("\r\n")]);
        const pump = (): void => {
          while (!closed && written < LIMIT) {
            const payload = written === 0 ? Buffer.concat([head, filler]) : filler;
            written += payload.length;
            if (!socket.write(frame(payload))) {
              socket.once("drain", pump);
              return;
            }
          }
          if (!closed) {
            socket.end("0\r\n\r\n");
          }
        };
        pump();
      });

      assert.ok(result.written < LIMIT, `the server must cut the connection off before the full ${LIMIT} bytes are accepted (wrote ${result.written})`);
      if (result.received.length > 0) {
        assert.match(result.received.toString("latin1"), /^HTTP\/1\.1 413 /);
      }
      assertUnchanged(dataDir, "bind-c4s2-stream", "VERIFIED", 1);

      const health = await rawRequest(port, { method: "GET", path: "/health" });
      assert.equal(health.status, 200);
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-stream", "VERIFIED");
    },
  );
});

// --- C4S2-R11: the /os/connections control ---

test("C4S2-R11: /os/connections renders the state-mutation control only for a viewer with EXECUTE and protected-action authority, never the staff session token, and submitting it works", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const founderPage = await rawRequest(port, { method: "GET", path: "/os/connections", headers: asStaff(FOUNDER_TOKEN) });
      assert.equal(founderPage.status, 200);
      assert.match(founderPage.body, /<form method="post" action="\/os\/connections\/bind-c4s2-forms\/state"/);
      assert.ok(!founderPage.body.includes(FOUNDER_TOKEN), "the session token must never be rendered into the page");

      const writerPage = await rawRequest(port, { method: "GET", path: "/os/connections", headers: asStaff(WRITER_TOKEN) });
      assert.equal(writerPage.status, 200);
      assert.doesNotMatch(writerPage.body, /<form/i);

      const submit = await postForm(port, connectorConnectionStatePath("bind-c4s2-forms"), "to=DEGRADED", asStaff(FOUNDER_TOKEN));
      assert.equal(submit.status, 303);
      assert.equal(readConnectionState(dataDir, "bind-c4s2-forms"), "DEGRADED");
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-forms", "VERIFIED");
    },
  );
});

// --- C4S2-R12: everything else is unchanged ---

test("C4S2-R12: other methods and paths are unchanged - PUT to a state path stays 501; a nonexistent connections sub-path stays 404/NOT_FOUND-equivalent dispatch; health stays healthy", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const put = await rawRequest(port, {
        method: "PUT",
        path: connectorConnectionStatePath("bind-c4s2-other"),
        headers: { ...asStaff(FOUNDER_TOKEN), "Content-Type": FORM },
        body: "to=DEGRADED",
      });
      assert.equal(put.status, 501);
      assertUnchanged(dataDir, "bind-c4s2-other", "VERIFIED", 1);

      for (const path of ["/os/connections", "/os/connections/bind-c4s2-other", "/os/connections/bind-c4s2-other/state/extra"]) {
        const response = await postForm(port, path, "to=DEGRADED", asStaff(FOUNDER_TOKEN));
        assert.equal(response.status, 501, path);
      }

      const health = await rawRequest(port, { method: "GET", path: "/health" });
      assert.equal(health.status, 200);
      assert.ok(
        (JSON.parse(health.body) as { probes: Array<{ name: string; healthy: boolean }> }).probes.some(
          (probe) => probe.name === "file-store:connector-connections" && probe.healthy,
        ),
      );
    },
    (dataDir) => {
      seedConnection(dataDir, "bind-c4s2-other", "VERIFIED");
    },
  );
});
