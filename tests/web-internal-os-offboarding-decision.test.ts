import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createCustomer } from "../src/domain/customer.js";
import { requestCustomerOffboarding, type CustomerOffboardingRequest, type CustomerOffboardingRequestId } from "../src/domain/customer-offboarding.js";
import {
  FileDurableCustomerOffboardingRequestStore,
  type DurableCustomerOffboardingRequestStore,
} from "../src/domain/durable-customer-offboarding-request-store.js";
import { FileDurableCustomerRepository } from "../src/application/durable-customer-repository.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createInternalOsRequestHandler, STAFF_SESSION_TOKEN_HEADER, type InternalOsRequestHandlerDeps } from "../src/web/internal-os-request-handler.js";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { createDurableCustomerOffboardingAdminSource } from "../src/web/customer-offboarding-admin-source.js";
import { resolvePendingOffboardingRequestsView, type CustomerOffboardingAdminSource } from "../src/web/internal-os-view-state.js";
import {
  isSameOriginMutationRequest,
  parseOffboardingDecisionForm,
  parseOffboardingDecisionPath,
} from "../src/web/internal-os-offboarding-decision-route.js";
import {
  OFFBOARDING_COMPLETE_PATH,
  OFFBOARDING_DENY_PATH,
  renderOffboardingDecisionControls,
} from "../src/web/internal-os-offboarding-decision-controls.js";
import type { IncomingRequestLike } from "../src/web/request-handler.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * C4 (gap scan 2026-10-23, first `/os` mutation slice): transport-agnostic
 * tests of the offboarding decision route's pieces (path, same-origin
 * check, form parsing, controls), the request handler's wiring of them,
 * and the containment of the one write affordance. The end-to-end proof
 * over a real socket through the composed runtime is
 * `runtime-offboarding-decision-route.test.ts`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORM = "application/x-www-form-urlencoded";

// --- path ---

test("C4: parseOffboardingDecisionPath recognizes exactly the two decision paths (same segment rules as parseInternalOsPath)", () => {
  assert.equal(parseOffboardingDecisionPath(OFFBOARDING_DENY_PATH), "deny");
  assert.equal(parseOffboardingDecisionPath(OFFBOARDING_COMPLETE_PATH), "complete");
  assert.equal(parseOffboardingDecisionPath("/os/admin/offboarding/deny/"), "deny");
  assert.equal(parseOffboardingDecisionPath("//os//admin/offboarding/complete"), "complete");
  for (const path of ["/os/admin", "/os/admin/offboarding", "/os/admin/offboarding/approve", "/os/admin/offboarding/deny/x", "/portal/admin/offboarding/deny", "/os/home/offboarding/deny"]) {
    assert.equal(parseOffboardingDecisionPath(path), undefined, path);
  }
});

// --- same-origin defense in depth ---

test("C4: isSameOriginMutationRequest - no Origin passes (non-browser client); a matching Origin passes; a foreign, null, malformed or non-http Origin fails; a missing Host with an Origin fails", () => {
  assert.equal(isSameOriginMutationRequest({}), true);
  assert.equal(isSameOriginMutationRequest({ host: "os.example" }), true);
  assert.equal(isSameOriginMutationRequest({ origin: "https://os.example", host: "os.example" }), true);
  assert.equal(isSameOriginMutationRequest({ origin: "http://127.0.0.1:8080", host: "127.0.0.1:8080" }), true);
  assert.equal(isSameOriginMutationRequest({ origin: "https://OS.example", host: "os.EXAMPLE" }), true, "host comparison is case-insensitive");
  assert.equal(isSameOriginMutationRequest({ origin: "https://os.example", host: "os.example:443" }), true, "an explicit default port matches");

  assert.equal(isSameOriginMutationRequest({ origin: "https://attacker.example", host: "os.example" }), false);
  assert.equal(isSameOriginMutationRequest({ origin: "https://os.example.attacker.example", host: "os.example" }), false);
  assert.equal(isSameOriginMutationRequest({ origin: "http://127.0.0.1:8081", host: "127.0.0.1:8080" }), false, "a different port is a different origin");
  assert.equal(isSameOriginMutationRequest({ origin: "null", host: "os.example" }), false);
  assert.equal(isSameOriginMutationRequest({ origin: "not a url", host: "os.example" }), false);
  assert.equal(isSameOriginMutationRequest({ origin: "file:///etc/passwd", host: "os.example" }), false);
  assert.equal(isSameOriginMutationRequest({ origin: "https://os.example" }), false, "an Origin with no Host to compare against fails closed");
  assert.equal(isSameOriginMutationRequest({ origin: "https://os.example", host: "attacker.example@os.example" }), false, "userinfo in Host is rejected, not parsed past");
  assert.equal(isSameOriginMutationRequest({ origin: "https://os.example", host: "os.example/path" }), false);
});

test("C4: isSameOriginMutationRequest - Sec-Fetch-Site other than same-origin/none fails, even without an Origin header", () => {
  assert.equal(isSameOriginMutationRequest({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(isSameOriginMutationRequest({ "sec-fetch-site": "none" }), true);
  assert.equal(isSameOriginMutationRequest({ "sec-fetch-site": "same-site" }), false);
  assert.equal(isSameOriginMutationRequest({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(isSameOriginMutationRequest({ "sec-fetch-site": "cross-site", origin: "https://os.example", host: "os.example" }), false);
});

// --- form parsing ---

test("C4: parseOffboardingDecisionForm accepts exactly the allow-listed fields once each, with a positive integer version", () => {
  assert.deepEqual(parseOffboardingDecisionForm("complete", FORM, "requestId=req-1&expectedVersion=3"), {
    kind: "complete",
    requestId: "req-1",
    expectedVersion: 3,
  });
  assert.deepEqual(parseOffboardingDecisionForm("deny", `${FORM}; charset=UTF-8`, "requestId=req-1&expectedVersion=1&reason=No+longer+needed"), {
    kind: "deny",
    requestId: "req-1",
    expectedVersion: 1,
    reason: "No longer needed",
  });
  // A requestId is opaque: a prototype-shaped id is just an id.
  assert.equal(parseOffboardingDecisionForm("complete", FORM, "requestId=__proto__&expectedVersion=1")?.requestId, "__proto__");

  for (const [label, contentType, body] of [
    ["no content type", undefined, "requestId=req-1&expectedVersion=1"],
    ["json", "application/json", "requestId=req-1&expectedVersion=1"],
    ["multipart", "multipart/form-data", "requestId=req-1&expectedVersion=1"],
    ["no body", FORM, undefined],
    ["huge version", FORM, "requestId=req-1&expectedVersion=10000000000"],
    ["hex version", FORM, "requestId=req-1&expectedVersion=0x1"],
    ["exponent version", FORM, "requestId=req-1&expectedVersion=1e2"],
    ["leading zero version", FORM, "requestId=req-1&expectedVersion=01"],
    ["empty requestId", FORM, "requestId=&expectedVersion=1"],
    ["duplicate version", FORM, "requestId=req-1&expectedVersion=1&expectedVersion=2"],
    ["unknown field", FORM, "requestId=req-1&expectedVersion=1&completedAt=2020-01-01T00:00:00.000Z"],
  ] as const) {
    assert.equal(parseOffboardingDecisionForm("complete", contentType, body), undefined, label);
  }
});

// --- controls ---

test("C4: renderOffboardingDecisionControls escapes a hostile request id in every attribute, and renders nothing when the viewer may take neither decision", () => {
  const hostile = `"><script>alert(1)</script>` as CustomerOffboardingRequestId;
  const html = renderOffboardingDecisionControls({ requestId: hostile, version: 1, canDeny: true, canComplete: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.equal(renderOffboardingDecisionControls({ requestId: "req-1" as CustomerOffboardingRequestId, version: 1, canDeny: false, canComplete: false }), "");
});

test("C4: resolvePendingOffboardingRequestsView keeps only a positive integer version from a versioned source, and carries decision controls only when asked", () => {
  const request: CustomerOffboardingRequest = {
    requestId: "req-v" as CustomerOffboardingRequestId,
    tenantId: REVIEW_ORGANIZATION.tenantId,
    customerId: "customer-v" as CustomerOffboardingRequest["customerId"],
    requestedByRef: "membership-requester",
    requestedAt: "2026-10-23T00:00:00.000Z",
    status: "REQUESTED",
  };
  const source = (version: number): CustomerOffboardingAdminSource => ({
    listPendingRequests: () => {
      throw new Error("the versioned listing must be preferred when present");
    },
    listPendingRequestsWithVersion: () => [{ request, version }],
  });
  const good = resolvePendingOffboardingRequestsView(REVIEW_ORGANIZATION, source(4), { canDeny: true, canComplete: false });
  assert.deepEqual(good, {
    kind: "READY",
    requests: [{ requestId: "req-v", customerId: "customer-v", requestedByRef: "membership-requester", requestedAt: "2026-10-23T00:00:00.000Z", version: 4 }],
    decisionControls: { canDeny: true, canComplete: false },
  });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const view = resolvePendingOffboardingRequestsView(REVIEW_ORGANIZATION, source(bad));
    assert.equal(view.kind, "READY");
    if (view.kind === "READY") {
      assert.equal(view.requests[0]?.version, undefined, String(bad));
      assert.equal(view.decisionControls, undefined);
    }
  }
});

// --- request handler wiring ---

function withStores(run: (deps: { requestStore: DurableCustomerOffboardingRequestStore; customerRepository: FileDurableCustomerRepository }) => void): void {
  const requestDir = mkdtempSync(join(tmpdir(), "c4-unit-requests-"));
  const customerDir = mkdtempSync(join(tmpdir(), "c4-unit-customers-"));
  try {
    run({ requestStore: new FileDurableCustomerOffboardingRequestStore(requestDir), customerRepository: new FileDurableCustomerRepository(customerDir) });
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
}

function seed(requestStore: DurableCustomerOffboardingRequestStore, requestId: string): void {
  const customer = createCustomer({ tenantScope: createTenantScope(REVIEW_ORGANIZATION.tenantId), customerId: `customer-${requestId}`, displayName: "C4 Unit Customer" });
  requestStore.createRequested(requestCustomerOffboarding({ requestId, customer, requestedByRef: "membership-requester", requestedAt: "2026-10-23T00:00:00.000Z" }));
}

function baseDeps(): Omit<InternalOsRequestHandlerDeps, "customerOffboardingDecision" | "customerOffboardingAdminSource"> {
  return {
    provider: createDevFixtureStaffSessionProvider({ fixtures: buildReviewStaffSessionFixtureMap(), isProduction: false }),
    organization: REVIEW_ORGANIZATION,
    grants: buildReviewStaffAccessGrants(),
  };
}

function post(path: string, body: string, token = FOUNDER_REVIEW_FIXTURE.sessionToken): IncomingRequestLike {
  return { method: "POST", path, headers: { [STAFF_SESSION_TOKEN_HEADER]: token, "content-type": FORM }, body };
}

test("C4: without a wired decision boundary, a decision POST is the same 501 as before C4, nothing changes, and /os/admin renders the pending list with no form", () => {
  withStores(({ requestStore }) => {
    seed(requestStore, "req-unwired");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), customerOffboardingAdminSource: createDurableCustomerOffboardingAdminSource(requestStore) });
    const response = handler(post(OFFBOARDING_DENY_PATH, "requestId=req-unwired&expectedVersion=1&reason=x"));
    assert.equal(response.status, 501);
    assert.equal(requestStore.get(REVIEW_ORGANIZATION.tenantId, "req-unwired" as CustomerOffboardingRequestId)?.request.status, "REQUESTED");

    const admin = handler({ method: "GET", path: "/os/admin", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(admin.status, 200);
    assert.match(admin.body, /customer-req-unwired/);
    assert.doesNotMatch(admin.body, /<form/i);
    assert.doesNotMatch(admin.body, /<button/i);
  });
});

test("C4: with the boundary wired but a source that reports no versions, /os/admin still renders no form (a form never carries a guessed version)", () => {
  withStores((decision) => {
    seed(decision.requestStore, "req-noversion");
    const durable = createDurableCustomerOffboardingAdminSource(decision.requestStore);
    const handler = createInternalOsRequestHandler({
      ...baseDeps(),
      customerOffboardingAdminSource: { listPendingRequests: durable.listPendingRequests },
      customerOffboardingDecision: decision,
    });
    const admin = handler({ method: "GET", path: "/os/admin", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(admin.status, 200);
    assert.match(admin.body, /customer-req-noversion/);
    assert.doesNotMatch(admin.body, /<form/i);
  });
});

test("C4: a wired handler denies through the real store and redirects 303; decidedAt comes from the server clock, never from the request", () => {
  withStores((decision) => {
    seed(decision.requestStore, "req-unit-deny");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), customerOffboardingDecision: { ...decision, clock: () => "2026-10-23T12:00:00.000Z" } });
    const response = handler(post(OFFBOARDING_DENY_PATH, "requestId=req-unit-deny&expectedVersion=1&reason=duplicate"));
    assert.equal(response.status, 303);
    assert.equal(response.headers["location"], "/os/admin");
    const stored = decision.requestStore.get(REVIEW_ORGANIZATION.tenantId, "req-unit-deny" as CustomerOffboardingRequestId);
    assert.equal(stored?.request.status, "DENIED");
    assert.equal(stored?.request.decidedAt, "2026-10-23T12:00:00.000Z");
    assert.equal(stored?.request.decidedByRef, "membership-founder");
  });
});

test("C4: a Member (READ only) cannot post a decision - 403 from the /os/admin destination gate, zero store change", () => {
  withStores((decision) => {
    seed(decision.requestStore, "req-unit-member");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), customerOffboardingDecision: decision });
    const response = handler(post(OFFBOARDING_DENY_PATH, "requestId=req-unit-member&expectedVersion=1&reason=x", MEMBER_REVIEW_FIXTURE.sessionToken));
    assert.equal(response.status, 403);
    assert.equal(decision.requestStore.get(REVIEW_ORGANIZATION.tenantId, "req-unit-member" as CustomerOffboardingRequestId)?.version, 1);
  });
});

test("C4: an unexpected store failure renders the generic OS ERROR page (500) and never the error's own message", () => {
  withStores((decision) => {
    const secret = "SECRET-INTERNAL-DETAIL /var/data/tenant-file.json";
    const failingStore: DurableCustomerOffboardingRequestStore = {
      ...decision.requestStore,
      get: () => {
        throw new Error(secret);
      },
      createRequested: (request) => decision.requestStore.createRequested(request),
      transitionToTerminal: (input) => decision.requestStore.transitionToTerminal(input),
      list: (tenantId) => decision.requestStore.list(tenantId),
      listPending: (tenantId) => decision.requestStore.listPending(tenantId),
    };
    const handler = createInternalOsRequestHandler({ ...baseDeps(), customerOffboardingDecision: { ...decision, requestStore: failingStore } });
    const response = handler(post(OFFBOARDING_DENY_PATH, "requestId=req-x&expectedVersion=1&reason=x"));
    assert.equal(response.status, 500);
    assert.ok(!response.body.includes("SECRET-INTERNAL-DETAIL"));
    assert.ok(!response.body.includes("/var/data"));
    assert.ok(!response.body.includes("req-x"));
  });
});

test("C4: the dev-only standalone internal OS server also reads a bounded POST body off a real socket", async () => {
  const requestDir = mkdtempSync(join(tmpdir(), "c4-standalone-requests-"));
  const customerDir = mkdtempSync(join(tmpdir(), "c4-standalone-customers-"));
  try {
    const requestStore = new FileDurableCustomerOffboardingRequestStore(requestDir);
    seed(requestStore, "req-standalone");
    const server = createInternalOsHttpServer({
      isProduction: false,
      devStaffFixtures: buildReviewStaffSessionFixtureMap(),
      organization: REVIEW_ORGANIZATION,
      grants: buildReviewStaffAccessGrants(),
      customerOffboardingDecision: { requestStore, customerRepository: new FileDurableCustomerRepository(customerDir) },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${OFFBOARDING_DENY_PATH}`, {
        method: "POST",
        redirect: "manual",
        headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken, "content-type": FORM },
        body: "requestId=req-standalone&expectedVersion=1&reason=standalone",
      });
      assert.equal(response.status, 303);
      assert.equal(requestStore.get(REVIEW_ORGANIZATION.tenantId, "req-standalone" as CustomerOffboardingRequestId)?.request.denialReason, "standalone");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    rmSync(requestDir, { recursive: true, force: true });
    rmSync(customerDir, { recursive: true, force: true });
  }
});

// --- containment of the one write affordance ---

test("C4: the offboarding controls module is one of exactly three src/web modules whose source contains a <form> or <button> (the others are the C4 slice 2 connection-state controls module and the C4 slice 3 attention decision controls module), and its only forms POST to the two decision paths", () => {
  const webDir = join(REPO_ROOT, "src", "web");
  const withAffordance = readdirSync(webDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /<form\b|<button/i.test(readFileSync(join(webDir, name), "utf8")))
    .sort();
  assert.deepEqual(withAffordance, [
    "internal-os-attention-decision-controls.ts",
    "internal-os-connection-state-controls.ts",
    "internal-os-offboarding-decision-controls.ts",
  ]);

  const controls = readFileSync(join(webDir, "internal-os-offboarding-decision-controls.ts"), "utf8");
  const formTags = controls.match(/<form\b[^>]*>/g) ?? [];
  assert.deepEqual(formTags, [
    '<form method="post" action="${OFFBOARDING_COMPLETE_PATH}" class="decision-form">',
    '<form method="post" action="${OFFBOARDING_DENY_PATH}" class="decision-form">',
  ]);
  assert.doesNotMatch(controls, new RegExp(STAFF_SESSION_TOKEN_HEADER), "a form must never carry the staff session token");

  // C4 slice 2: the sibling connection-state controls module carries the
  // same containment guarantee - exactly one form shape, and it never
  // carries the staff session token either.
  const connectionStateControls = readFileSync(join(webDir, "internal-os-connection-state-controls.ts"), "utf8");
  const connectionStateFormTags = connectionStateControls.match(/<form\b[^>]*>/g) ?? [];
  assert.deepEqual(connectionStateFormTags, ['<form method="post" action="${escapeHtml(path)}" class="connection-state-form">']);
  assert.doesNotMatch(
    connectionStateControls,
    new RegExp(STAFF_SESSION_TOKEN_HEADER),
    "a form must never carry the staff session token",
  );
});
