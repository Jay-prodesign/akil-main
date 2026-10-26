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
import { createCustomer } from "../src/domain/customer.js";
import { requestCustomerOffboarding, type CustomerOffboardingRequestId } from "../src/domain/customer-offboarding.js";
import {
  FileDurableCustomerOffboardingRequestStore,
  type StoredCustomerOffboardingRequest,
} from "../src/domain/durable-customer-offboarding-request-store.js";
import { FileDurableCustomerRepository } from "../src/application/durable-customer-repository.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { INTERNAL_OS_MAX_REQUEST_BODY_BYTES } from "../src/web/http-server.js";

/**
 * C4 (gap scan 2026-10-23, first `/os` mutation slice): the customer-
 * offboarding deny/complete POST routes, exercised through the deployable
 * runtime's real composition root (`createNodeRuntime`) over a real TCP
 * socket. Requests are written byte-for-byte with `node:net`, so every
 * header (including the absence of `Origin`) is exactly what the test
 * says, and the body really crosses the wire. Every record is seeded, and
 * every outcome is read back, through a SEPARATELY CONSTRUCTED durable
 * store pointed at the runtime's own `DATA_DIR` (same discipline as
 * `runtime-attention-destination.test.ts`).
 */

const OS_TENANT = "tenant-c4-os";
const OS_ORG = "org-c4-zero";
const FOUNDER_PRINCIPAL = "staff-c4-founder";
const FOUNDER_MEMBERSHIP = "membership-c4-founder";
const REQUESTER_REF = "membership-c4-requester";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };

const FOUNDER_TOKEN = "dev-staff-token-c4-founder";
const WRITER_TOKEN = "dev-staff-token-c4-writer";
const READER_TOKEN = "dev-staff-token-c4-reader";
const STRANGER_TOKEN = "dev-staff-token-c4-stranger";

const DENY_PATH = "/os/admin/offboarding/deny";
const COMPLETE_PATH = "/os/admin/offboarding/complete";
const FORM = "application/x-www-form-urlencoded";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c4-runtime-data-"));
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

async function withRuntime(options: NodeRuntimeOptions, run: (handle: RuntimeHandle) => Promise<void>, seed?: (dataDir: string) => void): Promise<void> {
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
    displayName: "AKILTA Zero (C4)",
    founderMembershipId: FOUNDER_MEMBERSHIP,
    founderPrincipalRef: FOUNDER_PRINCIPAL,
    idempotencyKey: "c4-provision-1",
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

function grant(membership: OrganizationMembership, permissions: ReadonlyArray<Permission>, canPerformProtectedActions: boolean): StaffAccessGrant {
  return {
    membership,
    authority: createAuthorityContext({ tenantScope: createTenantScope(OS_TENANT), permissions, canPerformProtectedActions }),
    assignments: [],
  };
}

function staffMembership(membershipId: string, principalRef: string): OrganizationMembership {
  return createOrganizationMembership({ membershipId, tenantScope: createTenantScope(OS_TENANT), principalRef, role: "STAFF" });
}

/**
 * Four staff sessions:
 * - founder: the provisioned founder membership, READ/WRITE/EXECUTE plus
 *   protected-action authority (may deny and complete);
 * - writer: READ/WRITE, no protected-action authority (may deny only);
 * - reader: READ only (may do neither, and cannot reach /os/admin);
 * - stranger: a valid session whose principal has no membership at all.
 */
function staffOptions(founderMembership: OrganizationMembership): NodeRuntimeOptions {
  return {
    devStaffSessionFixtures: new Map([
      [FOUNDER_TOKEN, session(FOUNDER_PRINCIPAL)],
      [WRITER_TOKEN, session("staff-c4-writer")],
      [READER_TOKEN, session("staff-c4-reader")],
      [STRANGER_TOKEN, session("staff-c4-stranger")],
    ]),
    staffAccessGrants: [
      grant(founderMembership, ["READ", "WRITE", "EXECUTE"], true),
      grant(staffMembership("membership-c4-writer", "staff-c4-writer"), ["READ", "WRITE"], false),
      grant(staffMembership("membership-c4-reader", "staff-c4-reader"), ["READ"], false),
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

function requestStore(dataDir: string): FileDurableCustomerOffboardingRequestStore {
  return new FileDurableCustomerOffboardingRequestStore(fileDurableRuntimeStoreDir(dataDir, "customerOffboardingRequests"));
}

function customerStore(dataDir: string): FileDurableCustomerRepository {
  return new FileDurableCustomerRepository(fileDurableRuntimeStoreDir(dataDir, "customers"));
}

function seedRequest(
  dataDir: string,
  requestId: string,
  options: { readonly saveCustomer?: boolean; readonly requestedByRef?: string } = {},
): StoredCustomerOffboardingRequest {
  const tenantScope = createTenantScope(OS_TENANT);
  const customer = createCustomer({ tenantScope, customerId: `customer-${requestId}`, displayName: `Customer ${requestId}` });
  if (options.saveCustomer === true) {
    customerStore(dataDir).save(customer);
  }
  const request = requestCustomerOffboarding({
    requestId,
    customer,
    requestedByRef: options.requestedByRef ?? REQUESTER_REF,
    requestedAt: "2026-10-23T00:00:00.000Z",
  });
  return requestStore(dataDir).createRequested(request);
}

function readRequest(dataDir: string, requestId: string): StoredCustomerOffboardingRequest | undefined {
  return requestStore(dataDir).get(createTenantScope(OS_TENANT).tenantId, requestId as CustomerOffboardingRequestId);
}

function assertUnchangedRequested(dataDir: string, requestId: string): void {
  const stored = readRequest(dataDir, requestId);
  assert.equal(stored?.request.status, "REQUESTED", `${requestId} must still be REQUESTED`);
  assert.equal(stored?.version, 1, `${requestId} must still be at version 1`);
  assert.equal(stored?.request.decidedByRef, undefined);
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
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

/** No error response from the decision route may echo a submitted value or an internal error message. */
function assertNoLeak(response: RawResponse, ...submitted: ReadonlyArray<string>): void {
  for (const value of submitted) {
    assert.ok(!response.body.includes(value), `response body must not echo ${JSON.stringify(value)}`);
  }
  assert.doesNotMatch(response.body, /Error|conflict:|expected \d|tenant "|CustomerOffboarding/);
}

const FOUNDER = founderMembershipFor();

// --- C4-R1..R3: the real mutation, end to end ---

test("C4-R1: a real HTTP POST (raw socket, no Origin header) denies a pending request - the body is read off the wire, the durable store shows DENIED, and the response is 303 to /os/admin", async () => {
  // A non-ASCII reason containing '&', '=' and '+' proves the UTF-8 body is
  // read and URL-decoded exactly, not truncated or mangled.
  const reason = "Müşteri talebi geri çekti & yeniden değerlendirilecek = 1+1";
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(
        port,
        DENY_PATH,
        form({ requestId: "req-c4-deny", expectedVersion: "1", reason }),
        asStaff(FOUNDER_TOKEN),
      );
      assert.equal(response.status, 303);
      assert.equal(response.headers["location"], "/os/admin");

      const stored = readRequest(dataDir, "req-c4-deny");
      assert.equal(stored?.request.status, "DENIED");
      assert.equal(stored?.version, 2);
      assert.equal(stored?.request.denialReason, reason);
      assert.equal(stored?.request.decidedByRef, FOUNDER_MEMBERSHIP);
      assert.ok(stored?.request.decidedAt !== undefined && !Number.isNaN(Date.parse(stored.request.decidedAt)));

      // The redirect target no longer lists it.
      const admin = await rawRequest(port, { method: "GET", path: "/os/admin", headers: asStaff(FOUNDER_TOKEN) });
      assert.equal(admin.status, 200);
      assert.ok(!admin.body.includes("customer-req-c4-deny"));
      assert.match(admin.body, /No pending offboarding requests\./);
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-deny");
    },
  );
});

test("C4-R2: optimistic concurrency fails closed - replaying the same deny (stale expectedVersion=1) and a forged future version are both 409 with zero store change", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const first = await postForm(port, DENY_PATH, form({ requestId: "req-c4-stale", expectedVersion: "1", reason: "first" }), asStaff(FOUNDER_TOKEN));
      assert.equal(first.status, 303);
      const afterFirst = readRequest(dataDir, "req-c4-stale");

      const replay = await postForm(port, DENY_PATH, form({ requestId: "req-c4-stale", expectedVersion: "1", reason: "second" }), asStaff(FOUNDER_TOKEN));
      assert.equal(replay.status, 409);
      assertNoLeak(replay, "req-c4-stale", "second");
      assert.deepEqual(readRequest(dataDir, "req-c4-stale"), afterFirst, "the replay must not overwrite the first decision");

      // Completing it with its now-current version still fails closed: terminal is terminal.
      const complete = await postForm(port, COMPLETE_PATH, form({ requestId: "req-c4-stale", expectedVersion: "2" }), asStaff(FOUNDER_TOKEN));
      assert.equal(complete.status, 409);
      assert.deepEqual(readRequest(dataDir, "req-c4-stale"), afterFirst);

      // A version the client invents for a still-pending request is refused too.
      const forged = await postForm(port, DENY_PATH, form({ requestId: "req-c4-forged", expectedVersion: "2", reason: "forged" }), asStaff(FOUNDER_TOKEN));
      assert.equal(forged.status, 409);
      assertUnchangedRequested(dataDir, "req-c4-forged");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-stale", { saveCustomer: true });
      seedRequest(dataDir, "req-c4-forged");
    },
  );
});

test("C4-R3: a staff member with protected-action authority completes a pending request through the real runtime - the durable store shows COMPLETED", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, COMPLETE_PATH, form({ requestId: "req-c4-complete", expectedVersion: "1" }), asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 303);
      assert.equal(response.headers["location"], "/os/admin");
      const stored = readRequest(dataDir, "req-c4-complete");
      assert.equal(stored?.request.status, "COMPLETED");
      assert.equal(stored?.version, 2);
      assert.equal(stored?.request.decidedByRef, FOUNDER_MEMBERSHIP);
      assert.equal(stored?.request.denialReason, undefined);
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-complete", { saveCustomer: true });
    },
  );
});

test("C4-R4: completing a request whose customer record is absent from the runtime's customer store is 404 with zero store change (no customer is fabricated)", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, COMPLETE_PATH, form({ requestId: "req-c4-nocustomer", expectedVersion: "1" }), asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 404);
      assertNoLeak(response, "req-c4-nocustomer", "customer-req-c4-nocustomer");
      assertUnchangedRequested(dataDir, "req-c4-nocustomer");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-nocustomer");
    },
  );
});

test("C4-R5: an unknown requestId is 404 and nothing is created", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const response = await postForm(port, DENY_PATH, form({ requestId: "req-c4-missing", expectedVersion: "1", reason: "x" }), asStaff(FOUNDER_TOKEN));
    assert.equal(response.status, 404);
    assertNoLeak(response, "req-c4-missing");
    assert.equal(readRequest(dataDir, "req-c4-missing"), undefined);
  });
});

// --- C4-R6: every existing access failure mode, with zero store mutation ---

test("C4-R6: every requireInternalOsAccess / authority failure mode fails closed exactly as on GET, with zero store mutation", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const denyBody = form({ requestId: "req-c4-authz", expectedVersion: "1", reason: "no" });
      const completeBody = form({ requestId: "req-c4-authz", expectedVersion: "1" });

      const cases: ReadonlyArray<{ label: string; path: string; body: string; headers: Record<string, string>; status: number }> = [
        { label: "no session token, deny", path: DENY_PATH, body: denyBody, headers: {}, status: 401 },
        { label: "no session token, complete", path: COMPLETE_PATH, body: completeBody, headers: {}, status: 401 },
        { label: "unknown session token", path: DENY_PATH, body: denyBody, headers: asStaff("not-a-real-token"), status: 401 },
        { label: "session with no membership", path: DENY_PATH, body: denyBody, headers: asStaff(STRANGER_TOKEN), status: 403 },
        { label: "READ-only staff cannot deny", path: DENY_PATH, body: denyBody, headers: asStaff(READER_TOKEN), status: 403 },
        { label: "READ-only staff cannot complete", path: COMPLETE_PATH, body: completeBody, headers: asStaff(READER_TOKEN), status: 403 },
        { label: "WRITE without protected-action authority cannot complete", path: COMPLETE_PATH, body: completeBody, headers: asStaff(WRITER_TOKEN), status: 403 },
      ];
      for (const entry of cases) {
        const response = await postForm(port, entry.path, entry.body, entry.headers);
        assert.equal(response.status, entry.status, entry.label);
        assertNoLeak(response, "req-c4-authz");
        assertUnchangedRequested(dataDir, "req-c4-authz");
      }

      // The domain's own asymmetry is wired through faithfully: WRITE alone
      // is enough to DENY (CUS-OFFBOARD-001 / REV216 F2).
      const writerDeny = await postForm(port, DENY_PATH, form({ requestId: "req-c4-writer-deny", expectedVersion: "1", reason: "writer" }), asStaff(WRITER_TOKEN));
      assert.equal(writerDeny.status, 303);
      assert.equal(readRequest(dataDir, "req-c4-writer-deny")?.request.status, "DENIED");
      assert.equal(readRequest(dataDir, "req-c4-writer-deny")?.request.decidedByRef, "membership-c4-writer");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-authz", { saveCustomer: true });
      seedRequest(dataDir, "req-c4-writer-deny");
    },
  );
});

test("C4-R7: the requester can never complete their own offboarding request through the route (domain self-completion guard) - 409, zero store change", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, COMPLETE_PATH, form({ requestId: "req-c4-self", expectedVersion: "1" }), asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 409);
      assertNoLeak(response, "req-c4-self", FOUNDER_MEMBERSHIP);
      assertUnchangedRequested(dataDir, "req-c4-self");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-self", { saveCustomer: true, requestedByRef: FOUNDER_MEMBERSHIP });
    },
  );
});

// --- C4-R8: same-origin defense in depth ---

test("C4-R8: a POST with a foreign Origin, Origin: null, or Sec-Fetch-Site: cross-site is 403 with zero store change even with a valid staff session; a same-origin Origin succeeds", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const body = form({ requestId: "req-c4-origin", expectedVersion: "1", reason: "csrf" });
      for (const headers of [
        { Origin: "https://attacker.example" },
        { Origin: `http://127.0.0.1:${port + 1}` },
        { Origin: "null" },
        { "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Site": "same-site" },
      ]) {
        const response = await postForm(port, DENY_PATH, body, { ...asStaff(FOUNDER_TOKEN), ...headers });
        assert.equal(response.status, 403, JSON.stringify(headers));
        assertUnchangedRequested(dataDir, "req-c4-origin");
      }

      const sameOrigin = await postForm(port, DENY_PATH, body, {
        ...asStaff(FOUNDER_TOKEN),
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
      });
      assert.equal(sameOrigin.status, 303);
      assert.equal(readRequest(dataDir, "req-c4-origin")?.request.status, "DENIED");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-origin");
    },
  );
});

// --- C4-R9: request parsing ---

test("C4-R9: a malformed body is a clean 400 with zero store change - never a crash; and an unauthenticated malformed POST is 401, not 400 (the session is checked before the body is parsed)", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const requestId = "req-c4-malformed";
      const malformed: ReadonlyArray<{ label: string; path: string; body: string; contentType?: string }> = [
        { label: "JSON content type", path: DENY_PATH, body: JSON.stringify({ requestId, expectedVersion: 1, reason: "x" }), contentType: "application/json" },
        { label: "no content type", path: DENY_PATH, body: form({ requestId, expectedVersion: "1", reason: "x" }), contentType: "" },
        { label: "empty body", path: DENY_PATH, body: "" },
        { label: "missing expectedVersion", path: DENY_PATH, body: form({ requestId, reason: "x" }) },
        { label: "non-integer expectedVersion", path: DENY_PATH, body: form({ requestId, expectedVersion: "1.0", reason: "x" }) },
        { label: "zero expectedVersion", path: DENY_PATH, body: form({ requestId, expectedVersion: "0", reason: "x" }) },
        { label: "negative expectedVersion", path: DENY_PATH, body: form({ requestId, expectedVersion: "-1", reason: "x" }) },
        { label: "text expectedVersion", path: DENY_PATH, body: form({ requestId, expectedVersion: "one", reason: "x" }) },
        { label: "missing requestId", path: DENY_PATH, body: form({ expectedVersion: "1", reason: "x" }) },
        { label: "requestId with surrounding whitespace", path: DENY_PATH, body: form({ requestId: ` ${requestId}`, expectedVersion: "1", reason: "x" }) },
        { label: "duplicate requestId", path: DENY_PATH, body: `${form({ requestId, expectedVersion: "1", reason: "x" })}&requestId=other` },
        { label: "unknown field", path: DENY_PATH, body: form({ requestId, expectedVersion: "1", reason: "x", tenantId: "tenant-other" }) },
        { label: "missing reason", path: DENY_PATH, body: form({ requestId, expectedVersion: "1" }) },
        { label: "whitespace-only reason", path: DENY_PATH, body: form({ requestId, expectedVersion: "1", reason: "   " }) },
        { label: "reason on complete", path: COMPLETE_PATH, body: form({ requestId, expectedVersion: "1", reason: "x" }) },
      ];
      for (const entry of malformed) {
        const headers: Record<string, string> = { ...asStaff(FOUNDER_TOKEN) };
        const response = await rawRequest(port, {
          method: "POST",
          path: entry.path,
          headers: entry.contentType === "" ? headers : { ...headers, "Content-Type": entry.contentType ?? FORM },
          body: entry.body,
        });
        assert.equal(response.status, 400, entry.label);
        assert.match(response.body, /Nothing was changed/);
        assertUnchangedRequested(dataDir, requestId);
      }

      const unauthenticated = await rawRequest(port, { method: "POST", path: DENY_PATH, headers: { "Content-Type": "application/json" }, body: "{" });
      assert.equal(unauthenticated.status, 401);
      assertUnchangedRequested(dataDir, requestId);

      // A reason typed with surrounding spaces is trimmed, not rejected.
      const padded = await postForm(port, DENY_PATH, form({ requestId, expectedVersion: "1", reason: "  spaced reason  " }), asStaff(FOUNDER_TOKEN));
      assert.equal(padded.status, 303);
      assert.equal(readRequest(dataDir, requestId)?.request.denialReason, "spaced reason");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-malformed");
    },
  );
});

// --- C4-R10: body size cap (memory-exhaustion DoS) ---

test(`C4-R10: a body of exactly the cap (${INTERNAL_OS_MAX_REQUEST_BODY_BYTES} bytes) is accepted; one byte more is 413 with zero store change`, async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const prefix = form({ requestId: "req-c4-cap-over", expectedVersion: "1" });
      const overBody = `${prefix}&reason=${"a".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES + 1 - prefix.length - "&reason=".length)}`;
      assert.equal(Buffer.byteLength(overBody), INTERNAL_OS_MAX_REQUEST_BODY_BYTES + 1);
      const over = await postForm(port, DENY_PATH, overBody, asStaff(FOUNDER_TOKEN));
      assert.equal(over.status, 413);
      assertUnchangedRequested(dataDir, "req-c4-cap-over");

      const exactPrefix = form({ requestId: "req-c4-cap-exact", expectedVersion: "1" });
      const exactBody = `${exactPrefix}&reason=${"a".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES - exactPrefix.length - "&reason=".length)}`;
      assert.equal(Buffer.byteLength(exactBody), INTERNAL_OS_MAX_REQUEST_BODY_BYTES);
      const exact = await postForm(port, DENY_PATH, exactBody, asStaff(FOUNDER_TOKEN));
      assert.equal(exact.status, 303);
      assert.equal(readRequest(dataDir, "req-c4-cap-exact")?.request.status, "DENIED");
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-cap-over");
      seedRequest(dataDir, "req-c4-cap-exact");
    },
  );
});

test("C4-R11: a declared Content-Length above the cap is answered 413 at once, before any body byte is sent - authenticated or not - and nothing is decided", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      for (const headers of [asStaff(FOUNDER_TOKEN), {}]) {
        // Only the head is sent; the server must not wait for 10 MB that never comes.
        const response = await rawRequest(port, {
          method: "POST",
          path: DENY_PATH,
          headers: { ...headers, "Content-Type": FORM },
          contentLength: 10 * 1024 * 1024,
        });
        assert.equal(response.status, 413);
        assert.equal(response.headers["connection"], "close");
        assertUnchangedRequested(dataDir, "req-c4-declared");
      }
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-declared");
    },
  );
});

test("C4-R12: an oversized chunked body with no Content-Length is cut off - the server stops reading and closes the connection long before the sender finishes, and the (otherwise valid) deny inside it never runs", async () => {
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
            `POST ${DENY_PATH} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            // So a regressed server that buffers everything still answers and
            // closes, and this test fails on the assertion below, not on a hang.
            "Connection: close",
            `${STAFF_SESSION_TOKEN_HEADER}: ${FOUNDER_TOKEN}`,
            `Content-Type: ${FORM}`,
            "Transfer-Encoding: chunked",
            "",
            "",
          ].join("\r\n"),
        );
        // A valid deny form whose reason just never ends. If the server
        // buffered it all and ran the handler, the request would be DENIED.
        const head = Buffer.from(`${form({ requestId: "req-c4-stream", expectedVersion: "1" })}&reason=`, "utf8");
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
      assertUnchangedRequested(dataDir, "req-c4-stream");

      // The server is still healthy and serving after cutting that connection off.
      const health = await rawRequest(port, { method: "GET", path: "/health" });
      assert.equal(health.status, 200);
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-stream");
    },
  );
});

// --- C4-R13: the /os/admin forms ---

test("C4-R13: /os/admin renders deny and complete forms for a protected-action viewer, carrying the request id and the exact stored version as hidden fields (never the session token); a WRITE-only viewer gets only the deny form", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const founder = await rawRequest(port, { method: "GET", path: "/os/admin", headers: asStaff(FOUNDER_TOKEN) });
      assert.equal(founder.status, 200);
      assert.match(founder.body, /<form method="post" action="\/os\/admin\/offboarding\/complete"/);
      assert.match(founder.body, /<form method="post" action="\/os\/admin\/offboarding\/deny"/);
      assert.match(founder.body, /<input type="hidden" name="requestId" value="req-c4-forms">/);
      assert.match(founder.body, /<input type="hidden" name="expectedVersion" value="1">/);
      assert.ok(!founder.body.includes(FOUNDER_TOKEN), "the session token must never be rendered into the page");

      const writer = await rawRequest(port, { method: "GET", path: "/os/admin", headers: asStaff(WRITER_TOKEN) });
      assert.equal(writer.status, 200);
      assert.match(writer.body, /action="\/os\/admin\/offboarding\/deny"/);
      assert.doesNotMatch(writer.body, /action="\/os\/admin\/offboarding\/complete"/);

      // Submitting exactly what the founder's page carries works.
      const version = /name="expectedVersion" value="(\d+)"/.exec(founder.body)?.[1];
      assert.equal(version, String(readRequest(dataDir, "req-c4-forms")?.version));
      const submit = await postForm(port, DENY_PATH, form({ requestId: "req-c4-forms", expectedVersion: version ?? "", reason: "from the page" }), asStaff(FOUNDER_TOKEN));
      assert.equal(submit.status, 303);
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-forms");
    },
  );
});

// --- C4-R14: everything else is unchanged ---

test("C4-R14: other methods and paths are unchanged - POST to any other /os path and PUT to a decision path stay 501; the customer /portal surface never reads a body (an oversized POST still gets its own 501, not 413) and its GETs are unaffected", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      for (const path of ["/os/admin", "/os/home", "/os/admin/offboarding", "/os/admin/offboarding/other"]) {
        const response = await postForm(port, path, form({ requestId: "req-c4-other", expectedVersion: "1", reason: "x" }), asStaff(FOUNDER_TOKEN));
        assert.equal(response.status, 501, path);
      }
      const put = await rawRequest(port, {
        method: "PUT",
        path: DENY_PATH,
        headers: { ...asStaff(FOUNDER_TOKEN), "Content-Type": FORM },
        body: form({ requestId: "req-c4-other", expectedVersion: "1", reason: "x" }),
      });
      assert.equal(put.status, 501);
      assertUnchangedRequested(dataDir, "req-c4-other");

      const portalPath = `/portal/${OS_TENANT}/customer-c4/project-c4`;
      const portalGet = await rawRequest(port, { method: "GET", path: portalPath });
      assert.equal(portalGet.status, 401);
      const portalPost = await rawRequest(port, {
        method: "POST",
        path: portalPath,
        headers: { "Content-Type": FORM },
        body: "a".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES * 4),
      });
      assert.equal(portalPost.status, 501);

      const health = await rawRequest(port, { method: "GET", path: "/health" });
      assert.equal(health.status, 200);
      assert.ok((JSON.parse(health.body) as { probes: Array<{ name: string; healthy: boolean }> }).probes.some((probe) => probe.name === "file-store:customers" && probe.healthy));
    },
    (dataDir) => {
      seedRequest(dataDir, "req-c4-other");
    },
  );
});
