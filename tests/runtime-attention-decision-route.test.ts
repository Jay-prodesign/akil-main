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
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import {
  createProtectedDecisionRecord,
  type ProtectedDecisionOutcome,
  type ProtectedDecisionRecord,
} from "../src/domain/protected-decision-record.js";
import { FileDurableProtectedDecisionRecordStore } from "../src/domain/durable-protected-decision-record-store.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import type { ProtectedDecisionWaitRequest } from "../src/domain/protected-decision-wait-gate.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { INTERNAL_OS_MAX_REQUEST_BODY_BYTES } from "../src/web/http-server.js";
import { attentionDecisionPath } from "../src/web/internal-os-attention-decision-controls.js";

/**
 * C4 slice 3 (gap scan 2026-10-23, third `/os` mutation slice): the
 * protected-decision-record create/revise POST route, exercised through
 * the deployable runtime's real composition root (`createNodeRuntime`)
 * over a real TCP socket - mirrors
 * `runtime-connector-connection-state-decision-route.test.ts`'s own
 * structure and hunt-list exactly. Requests are written byte-for-byte with
 * `node:net`, so every header (including the absence of `Origin`) is
 * exactly what the test says, and the body really crosses the wire.
 */

const OS_TENANT = "tenant-c4s3-os";
const OS_ORG = "org-c4s3-zero";
const FOUNDER_PRINCIPAL = "staff-c4s3-founder";
const FOUNDER_MEMBERSHIP = "membership-c4s3-founder";
const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };

const FOUNDER_TOKEN = "dev-staff-token-c4s3-founder";
const WRITER_TOKEN = "dev-staff-token-c4s3-writer";
const EXECUTE_NO_PROTECTED_TOKEN = "dev-staff-token-c4s3-execute-no-protected";
const READER_TOKEN = "dev-staff-token-c4s3-reader";
const STRANGER_TOKEN = "dev-staff-token-c4s3-stranger";

const FORM = "application/x-www-form-urlencoded";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c4s3-runtime-data-"));
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
    displayName: "AKILTA Zero (C4 slice 3)",
    founderMembershipId: FOUNDER_MEMBERSHIP,
    founderPrincipalRef: FOUNDER_PRINCIPAL,
    idempotencyKey: "c4s3-provision-1",
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
 * Five staff sessions:
 * - founder: the provisioned founder membership, READ/WRITE/EXECUTE plus
 *   protected-action authority (may decide);
 * - writer: READ/WRITE only (may not even reach `/os/attention` - that
 *   destination requires EXECUTE or protected-action authority);
 * - executeNoProtected: READ/WRITE/EXECUTE but no protected-action
 *   authority - clears the destination gate (EXECUTE) and
 *   `resolveAttentionView`'s own WRITE requirement, but fails the domain
 *   functions' own protected-action floor;
 * - reader: READ only (may not reach `/os/attention` at all);
 * - stranger: a valid session whose principal has no membership at all.
 */
function staffOptions(founderMembership: OrganizationMembership): NodeRuntimeOptions {
  return {
    devStaffSessionFixtures: new Map([
      [FOUNDER_TOKEN, session(FOUNDER_PRINCIPAL)],
      [WRITER_TOKEN, session("staff-c4s3-writer")],
      [EXECUTE_NO_PROTECTED_TOKEN, session("staff-c4s3-execute-no-protected")],
      [READER_TOKEN, session("staff-c4s3-reader")],
      [STRANGER_TOKEN, session("staff-c4s3-stranger")],
    ]),
    staffAccessGrants: [
      grant(founderMembership, ["READ", "WRITE", "EXECUTE"], true),
      grant(staffMembership("membership-c4s3-writer", "staff-c4s3-writer"), ["READ", "WRITE"], false),
      grant(staffMembership("membership-c4s3-execute-no-protected", "staff-c4s3-execute-no-protected"), ["READ", "WRITE", "EXECUTE"], false),
      grant(staffMembership("membership-c4s3-reader", "staff-c4s3-reader"), ["READ"], false),
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

function recordStore(dataDir: string): FileDurableProtectedDecisionRecordStore {
  return new FileDurableProtectedDecisionRecordStore(fileDurableRuntimeStoreDir(dataDir, "protectedDecisionRecords"));
}

function waitStore(dataDir: string): FileDurableProtectedDecisionWaitStore {
  return new FileDurableProtectedDecisionWaitStore(fileDurableRuntimeStoreDir(dataDir, "protectedDecisionWaits"));
}

function readRecord(dataDir: string, decisionRef: string): ProtectedDecisionRecord | undefined {
  return recordStore(dataDir).getDecisionRecord(createTenantScope(OS_TENANT).tenantId, decisionRef);
}

const SEED_ORGANIZATION = activateOrganization({
  organization: createOrganization({
    organizationId: OS_ORG,
    tenantScope: createTenantScope(OS_TENANT),
    displayName: "AKILTA Zero (C4 slice 3 seed)",
    createdAt: "2026-10-23T00:00:00.000Z",
  }),
  activatedAt: "2026-10-23T00:00:01.000Z",
});

/** Seeds a decision record directly through the real, already-reviewed domain function - never through the route under test. */
function seedRecord(dataDir: string, decisionRef: string, outcome: ProtectedDecisionOutcome, evidenceRef = "seed-evidence"): void {
  const tenantScope = createTenantScope(OS_TENANT);
  const founder = founderMembershipFor();
  const record = createProtectedDecisionRecord({
    tenantScope,
    decisionRef,
    outcome,
    organization: SEED_ORGANIZATION,
    membership: founder,
    currentPrincipalRef: FOUNDER_PRINCIPAL,
    authority: createAuthorityContext({ tenantScope, permissions: ["READ", "EXECUTE"], canPerformProtectedActions: true }),
    decidedAt: "2026-10-23T00:00:00.000Z",
    evidenceRef,
  });
  recordStore(dataDir).putIfAbsentDecisionRecord(tenantScope.tenantId, decisionRef, record);
}

function waitRequestFor(decisionRef: string, waitRequestId: string): ProtectedDecisionWaitRequest {
  return {
    waitRequestId: waitRequestId as ProtectedDecisionWaitRequest["waitRequestId"],
    tenantId: OS_TENANT as ProtectedDecisionWaitRequest["tenantId"],
    customerId: "customer-c4s3" as ProtectedDecisionWaitRequest["customerId"],
    projectId: "project-c4s3" as ProtectedDecisionWaitRequest["projectId"],
    jobId: "plan-c4s3:v1:req-1" as ProtectedDecisionWaitRequest["jobId"],
    runId: "run-c4s3",
    attempt: 1,
    effectRef: `effect:${waitRequestId}`,
    decisionRef,
    reason: "c4s3 wait reason",
    activationFingerprintAtWait: "fingerprint-c4s3",
    raisedAt: "2026-10-23T00:00:00.000Z",
  };
}

function seedWait(dataDir: string, decisionRef: string, waitRequestId: string): void {
  waitStore(dataDir).putIfAbsentWaitRequest(createTenantScope(OS_TENANT).tenantId, waitRequestId, waitRequestFor(decisionRef, waitRequestId));
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
 * `Content-Length` is computed from the UTF-8 body unless `contentLength`
 * overrides it.
 */
function rawRequest(
  port: number,
  input: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly contentLength?: number;
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
    const lines = [`${input.method} ${input.path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
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

function postForm(port: number, path: string, body: string, headers: Readonly<Record<string, string>> = {}): Promise<RawResponse> {
  return rawRequest(port, { method: "POST", path, headers: { "Content-Type": FORM, ...headers }, body });
}

function asStaff(token: string): Record<string, string> {
  return { [STAFF_SESSION_TOKEN_HEADER]: token };
}

/** No error response from the decision route may echo a submitted value, a decisionRef, a tenant id, or an internal error message. */
function assertNoLeak(response: RawResponse, ...submitted: ReadonlyArray<string>): void {
  for (const value of submitted) {
    assert.ok(!response.body.includes(value), `response body must not echo ${JSON.stringify(value)}`);
  }
  assert.doesNotMatch(response.body, /Error|conflict:|ProtectedDecisionRecord|tenant "/);
}

const FOUNDER = founderMembershipFor();

// --- C4S3-R1..R3: the real mutation, end to end ---

test("C4S3-R1: a real HTTP POST (raw socket, no Origin header) creates an APPROVED decision - the body is read off the wire, the durable store shows it, and the response is 303 to /os/attention", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const response = await postForm(
      port,
      attentionDecisionPath("decision-c4s3-approve"),
      "outcome=APPROVED&evidenceRef=evidence-approve",
      asStaff(FOUNDER_TOKEN),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers["location"], "/os/attention");

    const stored = readRecord(dataDir, "decision-c4s3-approve");
    assert.equal(stored?.outcome, "APPROVED");
    assert.equal(stored?.evidenceRef, "evidence-approve");
    assert.equal(stored?.decidedByPrincipalRef, FOUNDER_PRINCIPAL);
    assert.ok(stored?.decidedAt !== undefined && !Number.isNaN(Date.parse(stored.decidedAt)));
  });
});

test("C4S3-R2: a real HTTP POST creates a DENIED decision, and a separate decisionRef can be revised APPROVED -> REVOKED end to end", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const denied = await postForm(port, attentionDecisionPath("decision-c4s3-deny"), "outcome=DENIED&evidenceRef=evidence-deny", asStaff(FOUNDER_TOKEN));
      assert.equal(denied.status, 303);
      assert.equal(readRecord(dataDir, "decision-c4s3-deny")?.outcome, "DENIED");

      const revoked = await postForm(
        port,
        attentionDecisionPath("decision-c4s3-revoke"),
        "outcome=REVOKED&evidenceRef=evidence-revoke",
        asStaff(FOUNDER_TOKEN),
      );
      assert.equal(revoked.status, 303);
      const revokedStored = readRecord(dataDir, "decision-c4s3-revoke");
      assert.equal(revokedStored?.outcome, "REVOKED");
      assert.equal(revokedStored?.evidenceRef, "evidence-revoke");
    },
    (dataDir) => {
      seedRecord(dataDir, "decision-c4s3-revoke", "APPROVED");
    },
  );
});

test("C4S3-R3: attempting to create a decision that already exists is 409 with zero store change", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, attentionDecisionPath("decision-c4s3-exists"), "outcome=APPROVED&evidenceRef=ev-again", asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 409);
      assertNoLeak(response, "decision-c4s3-exists");
      assert.equal(readRecord(dataDir, "decision-c4s3-exists")?.evidenceRef, "seed-evidence");
    },
    (dataDir) => {
      seedRecord(dataDir, "decision-c4s3-exists", "APPROVED");
    },
  );
});

test("C4S3-R4: attempting to revoke a decisionRef that has never been decided is 409 with zero store change", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const response = await postForm(port, attentionDecisionPath("decision-c4s3-never"), "outcome=REVOKED&evidenceRef=ev", asStaff(FOUNDER_TOKEN));
    assert.equal(response.status, 409);
    assertNoLeak(response, "decision-c4s3-never");
    assert.equal(readRecord(dataDir, "decision-c4s3-never"), undefined);
  });
});

test("C4S3-R5: attempting to revoke a DENIED (terminal) decision is 409 with zero store change", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const response = await postForm(port, attentionDecisionPath("decision-c4s3-denied-terminal"), "outcome=REVOKED&evidenceRef=ev", asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 409);
      assertNoLeak(response, "decision-c4s3-denied-terminal");
      assert.equal(readRecord(dataDir, "decision-c4s3-denied-terminal")?.outcome, "DENIED");
    },
    (dataDir) => {
      seedRecord(dataDir, "decision-c4s3-denied-terminal", "DENIED");
    },
  );
});

// --- C4S3-R6: every access/authority failure mode, with zero store mutation ---

test("C4S3-R6: every requireInternalOsAccess / destination-gate / domain-authority failure mode fails closed exactly as on GET, with zero store mutation", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const body = "outcome=APPROVED&evidenceRef=ev";

      const cases: ReadonlyArray<{ label: string; headers: Record<string, string>; status: number }> = [
        { label: "no session token", headers: {}, status: 401 },
        { label: "unknown session token", headers: asStaff("not-a-real-token"), status: 401 },
        { label: "session with no membership", headers: asStaff(STRANGER_TOKEN), status: 403 },
        { label: "READ-only staff cannot even reach /os/attention", headers: asStaff(READER_TOKEN), status: 403 },
        { label: "WRITE without EXECUTE/protected authority cannot reach /os/attention", headers: asStaff(WRITER_TOKEN), status: 403 },
      ];
      for (const entry of cases) {
        const response = await postForm(port, attentionDecisionPath("decision-c4s3-authz"), body, entry.headers);
        assert.equal(response.status, entry.status, entry.label);
        assertNoLeak(response, "decision-c4s3-authz");
        assert.equal(readRecord(dataDir, "decision-c4s3-authz"), undefined, entry.label);
      }

      // EXECUTE but no protected-action authority clears the destination
      // gate (EXECUTE satisfies isDestinationVisible) but still fails the
      // domain functions' own protected-action floor -
      // ProtectedActionNotAuthorizedError is mapped to 403 (see
      // `internal-os-attention-decision-route.ts`'s own error-mapping doc
      // comment), never leaking any detail.
      const executeOnly = await postForm(port, attentionDecisionPath("decision-c4s3-execute-only"), body, asStaff(EXECUTE_NO_PROTECTED_TOKEN));
      assert.equal(executeOnly.status, 403);
      assertNoLeak(executeOnly, "decision-c4s3-execute-only");
      assert.equal(readRecord(dataDir, "decision-c4s3-execute-only"), undefined);

      // The READ-only and WRITE-only viewers cannot even reach the
      // destination to see a status or a form.
      for (const token of [READER_TOKEN, WRITER_TOKEN]) {
        const page = await rawRequest(port, { method: "GET", path: "/os/attention", headers: asStaff(token) });
        assert.equal(page.status, 403, token);
      }
    },
  );
});

// --- C4S3-R7: same-origin defense in depth ---

test("C4S3-R7: a POST with a foreign Origin, Origin: null, or Sec-Fetch-Site: cross-site is 403 with zero store change even with a valid staff session; a same-origin Origin succeeds", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const body = "outcome=APPROVED&evidenceRef=ev";
    for (const headers of [
      { Origin: "https://attacker.example" },
      { Origin: `http://127.0.0.1:${port + 1}` },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      const response = await postForm(port, attentionDecisionPath("decision-c4s3-origin"), body, { ...asStaff(FOUNDER_TOKEN), ...headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(readRecord(dataDir, "decision-c4s3-origin"), undefined);
    }

    const sameOrigin = await postForm(port, attentionDecisionPath("decision-c4s3-origin"), body, {
      ...asStaff(FOUNDER_TOKEN),
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(sameOrigin.status, 303);
    assert.equal(readRecord(dataDir, "decision-c4s3-origin")?.outcome, "APPROVED");
  });
});

// --- C4S3-R8: request parsing ---

test("C4S3-R8: a malformed body is a clean 400 with zero store change - never a crash; and an unauthenticated malformed POST is 401, not 400 (the session is checked before the body is parsed)", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const decisionRef = "decision-c4s3-malformed";
    const malformed: ReadonlyArray<{ label: string; body: string; contentType?: string }> = [
      { label: "JSON content type", body: JSON.stringify({ outcome: "APPROVED", evidenceRef: "ev" }), contentType: "application/json" },
      { label: "no content type", body: "outcome=APPROVED&evidenceRef=ev", contentType: "" },
      { label: "empty body", body: "" },
      { label: "unrecognized outcome", body: "outcome=MAYBE&evidenceRef=ev" },
      { label: "lowercase outcome", body: "outcome=approved&evidenceRef=ev" },
      { label: "missing outcome", body: "evidenceRef=ev" },
      { label: "duplicate outcome", body: "outcome=APPROVED&outcome=DENIED&evidenceRef=ev" },
      { label: "missing evidenceRef", body: "outcome=APPROVED" },
      { label: "empty evidenceRef", body: "outcome=APPROVED&evidenceRef=" },
      { label: "whitespace-only evidenceRef", body: "outcome=APPROVED&evidenceRef=%20%20%20" },
      { label: "unknown field decisionRef", body: "outcome=APPROVED&evidenceRef=ev&decisionRef=other" },
      { label: "unknown field decidedAt", body: "outcome=APPROVED&evidenceRef=ev&decidedAt=2000-01-01T00:00:00.000Z" },
    ];
    for (const entry of malformed) {
      const headers: Record<string, string> = { ...asStaff(FOUNDER_TOKEN) };
      const response = await rawRequest(port, {
        method: "POST",
        path: attentionDecisionPath(decisionRef),
        headers: entry.contentType === "" ? headers : { ...headers, "Content-Type": entry.contentType ?? FORM },
        body: entry.body,
      });
      assert.equal(response.status, 400, entry.label);
      assert.equal(readRecord(dataDir, decisionRef), undefined, entry.label);
    }

    const unauthenticated = await rawRequest(port, { method: "POST", path: attentionDecisionPath(decisionRef), headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(unauthenticated.status, 401);
    assert.equal(readRecord(dataDir, decisionRef), undefined);

    // A well-formed submission still works after all those rejections, and
    // leading/trailing whitespace in evidenceRef is trimmed, not rejected.
    const ok = await postForm(port, attentionDecisionPath(decisionRef), "outcome=APPROVED&evidenceRef=%20trimmed%20", asStaff(FOUNDER_TOKEN));
    assert.equal(ok.status, 303);
    assert.equal(readRecord(dataDir, decisionRef)?.evidenceRef, "trimmed");
  });
});

// --- C4S3-R9: body size cap (memory-exhaustion DoS) ---

test(`C4S3-R9: a body of exactly the cap (${INTERNAL_OS_MAX_REQUEST_BODY_BYTES} bytes) is read and reaches form parsing (never 413); one byte more is 413 with zero store change, before the body is ever parsed`, async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const prefix = "outcome=APPROVED&evidenceRef=";
    const overBody = `${prefix}${"a".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES + 1 - prefix.length)}`;
    assert.equal(Buffer.byteLength(overBody), INTERNAL_OS_MAX_REQUEST_BODY_BYTES + 1);
    const over = await postForm(port, attentionDecisionPath("decision-c4s3-cap-over"), overBody, asStaff(FOUNDER_TOKEN));
    assert.equal(over.status, 413);
    assert.equal(readRecord(dataDir, "decision-c4s3-cap-over"), undefined);

    const exactBody = `${prefix}${"a".repeat(INTERNAL_OS_MAX_REQUEST_BODY_BYTES - prefix.length)}`;
    assert.equal(Buffer.byteLength(exactBody), INTERNAL_OS_MAX_REQUEST_BODY_BYTES);
    const exact = await postForm(port, attentionDecisionPath("decision-c4s3-cap-exact"), exactBody, asStaff(FOUNDER_TOKEN));
    // The exact-cap body was read in full and reached the real mutation.
    assert.equal(exact.status, 303);
    assert.equal(readRecord(dataDir, "decision-c4s3-cap-exact")?.outcome, "APPROVED");
  });
});

test("C4S3-R10: a declared Content-Length above the cap is answered 413 at once, before any body byte is sent - authenticated or not - and nothing is changed", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    for (const headers of [asStaff(FOUNDER_TOKEN), {}]) {
      const response = await rawRequest(port, {
        method: "POST",
        path: attentionDecisionPath("decision-c4s3-declared"),
        headers: { ...headers, "Content-Type": FORM },
        contentLength: 10 * 1024 * 1024,
      });
      assert.equal(response.status, 413);
      assert.equal(response.headers["connection"], "close");
      assert.equal(readRecord(dataDir, "decision-c4s3-declared"), undefined);
    }
  });
});

test("C4S3-R11: an oversized chunked body with no Content-Length is cut off - the server stops reading and closes the connection long before the sender finishes, and the (otherwise valid) decision inside it never runs", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
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
          `POST ${attentionDecisionPath("decision-c4s3-stream")} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: close",
          `${STAFF_SESSION_TOKEN_HEADER}: ${FOUNDER_TOKEN}`,
          `Content-Type: ${FORM}`,
          "Transfer-Encoding: chunked",
          "",
          "",
        ].join("\r\n"),
      );
      const head = Buffer.from("outcome=APPROVED&evidenceRef=", "utf8");
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
    assert.equal(readRecord(dataDir, "decision-c4s3-stream"), undefined);

    const health = await rawRequest(port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200);
  });
});

// --- C4S3-R12: the /os/attention controls ---

test("C4S3-R12: /os/attention renders Approve+Deny for a pending row and Revoke for an APPROVED row, never the staff session token, and submitting the rendered form works", async () => {
  await withRuntime(
    staffOptions(FOUNDER),
    async ({ port, dataDir }) => {
      const founderPage = await rawRequest(port, { method: "GET", path: "/os/attention", headers: asStaff(FOUNDER_TOKEN) });
      assert.equal(founderPage.status, 200);
      assert.match(founderPage.body, new RegExp(`action="/os/attention/decisions/decision-c4s3-forms-pending"[^]*?value="APPROVED"`));
      assert.match(founderPage.body, new RegExp(`action="/os/attention/decisions/decision-c4s3-forms-approved"[^]*?value="REVOKED"`));
      assert.ok(!founderPage.body.includes(FOUNDER_TOKEN), "the session token must never be rendered into the page");

      const writerPage = await rawRequest(port, { method: "GET", path: "/os/attention", headers: asStaff(WRITER_TOKEN) });
      assert.equal(writerPage.status, 403);

      const submit = await postForm(
        port,
        attentionDecisionPath("decision-c4s3-forms-pending"),
        "outcome=APPROVED&evidenceRef=evidence-from-page",
        asStaff(FOUNDER_TOKEN),
      );
      assert.equal(submit.status, 303);
      assert.equal(readRecord(dataDir, "decision-c4s3-forms-pending")?.outcome, "APPROVED");
    },
    (dataDir) => {
      seedWait(dataDir, "decision-c4s3-forms-pending", "wait-c4s3-forms-pending");
      seedWait(dataDir, "decision-c4s3-forms-approved", "wait-c4s3-forms-approved");
      seedRecord(dataDir, "decision-c4s3-forms-approved", "APPROVED");
    },
  );
});

// --- C4S3-R13: everything else is unchanged ---

test("C4S3-R13: other methods and paths are unchanged - PUT to a decision path stays 501; other /os/attention sub-paths stay 501; health stays healthy and carries the new store's probe", async () => {
  await withRuntime(staffOptions(FOUNDER), async ({ port, dataDir }) => {
    const put = await rawRequest(port, {
      method: "PUT",
      path: attentionDecisionPath("decision-c4s3-other"),
      headers: { ...asStaff(FOUNDER_TOKEN), "Content-Type": FORM },
      body: "outcome=APPROVED&evidenceRef=ev",
    });
    assert.equal(put.status, 501);
    assert.equal(readRecord(dataDir, "decision-c4s3-other"), undefined);

    for (const path of ["/os/attention", "/os/attention/decisions", "/os/attention/decisions/decision-c4s3-other/extra"]) {
      const response = await postForm(port, path, "outcome=APPROVED&evidenceRef=ev", asStaff(FOUNDER_TOKEN));
      assert.equal(response.status, 501, path);
    }

    const health = await rawRequest(port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200);
    assert.ok(
      (JSON.parse(health.body) as { probes: Array<{ name: string; healthy: boolean }> }).probes.some(
        (probe) => probe.name === "file-store:protected-decision-records" && probe.healthy,
      ),
    );
  });
});
