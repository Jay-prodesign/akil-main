import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  createProtectedDecisionRecord,
  reviseProtectedDecisionRecord,
  type ProtectedDecisionOutcome,
} from "../src/domain/protected-decision-record.js";
import {
  FileDurableProtectedDecisionRecordStore,
  type DurableProtectedDecisionRecordStore,
} from "../src/domain/durable-protected-decision-record-store.js";
import { FileDurableProtectedDecisionWaitStore } from "../src/domain/durable-protected-decision-wait-store.js";
import type { ProtectedDecisionWaitRequest } from "../src/domain/protected-decision-wait-gate.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { createInternalOsRequestHandler, STAFF_SESSION_TOKEN_HEADER, type InternalOsRequestHandlerDeps } from "../src/web/internal-os-request-handler.js";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { createDurableAttentionSource } from "../src/web/attention-durable-source.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import {
  isSameOriginMutationRequest,
  parseOffboardingDecisionPath,
} from "../src/web/internal-os-offboarding-decision-route.js";
import {
  parseAttentionDecisionPath,
  parseAttentionDecisionForm,
} from "../src/web/internal-os-attention-decision-route.js";
import {
  attentionDecisionPath,
  renderAttentionDecisionControls,
  ATTENTION_DECISION_OUTCOMES,
} from "../src/web/internal-os-attention-decision-controls.js";
import type { IncomingRequestLike } from "../src/web/request-handler.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * C4 slice 3 (gap scan 2026-10-23, third `/os` mutation slice): transport-
 * agnostic tests of the attention decision route's pieces (path, form
 * parsing, controls) and the request handler's wiring of it, mirroring
 * `tests/web-internal-os-connection-state-decision.test.ts`'s own structure
 * and hunt-list exactly. The end-to-end proof over a real socket through
 * the composed runtime is `tests/runtime-attention-decision-route.test.ts`.
 */

const FORM = "application/x-www-form-urlencoded";

// --- path ---

test("C4 slice 3: parseAttentionDecisionPath recognizes exactly the one decision path shape (same segment rules as parseInternalOsPath)", () => {
  assert.equal(parseAttentionDecisionPath(attentionDecisionPath("decision-1")), "decision-1");
  assert.equal(parseAttentionDecisionPath("/os/attention/decisions/decision-1/"), "decision-1");
  assert.equal(parseAttentionDecisionPath("//os//attention/decisions/decision-1"), "decision-1");
  for (const path of [
    "/os/attention",
    "/os/attention/decisions",
    "/os/attention/decisions/decision-1/extra",
    "/os/attention/decisions//",
    "/os/attention/other/decision-1",
    "/portal/attention/decisions/decision-1",
    "/os/admin/decisions/decision-1",
  ]) {
    assert.equal(parseAttentionDecisionPath(path), undefined, path);
  }
  // This path shape must never collide with the offboarding decision paths' own parser.
  assert.equal(parseOffboardingDecisionPath(attentionDecisionPath("decision-1")), undefined);
});

// --- form parsing ---

test("C4 slice 3: parseAttentionDecisionForm accepts exactly the two allow-listed fields once each, with outcome in the 3-value enum and evidenceRef non-empty after trim", () => {
  for (const outcome of ATTENTION_DECISION_OUTCOMES) {
    assert.deepEqual(parseAttentionDecisionForm(FORM, `outcome=${outcome}&evidenceRef=ev-1`), { outcome, evidenceRef: "ev-1" });
  }
  assert.deepEqual(parseAttentionDecisionForm(`${FORM}; charset=UTF-8`, "outcome=APPROVED&evidenceRef=+padded+"), {
    outcome: "APPROVED",
    evidenceRef: "padded",
  });

  for (const [label, contentType, body] of [
    ["no content type", undefined, "outcome=APPROVED&evidenceRef=ev-1"],
    ["json", "application/json", "outcome=APPROVED&evidenceRef=ev-1"],
    ["multipart", "multipart/form-data", "outcome=APPROVED&evidenceRef=ev-1"],
    ["no body", FORM, undefined],
    ["unrecognized outcome", FORM, "outcome=MAYBE&evidenceRef=ev-1"],
    ["lowercase outcome", FORM, "outcome=approved&evidenceRef=ev-1"],
    ["empty outcome", FORM, "outcome=&evidenceRef=ev-1"],
    ["missing outcome", FORM, "evidenceRef=ev-1"],
    ["duplicate outcome", FORM, "outcome=APPROVED&outcome=DENIED&evidenceRef=ev-1"],
    ["missing evidenceRef", FORM, "outcome=APPROVED"],
    ["empty evidenceRef", FORM, "outcome=APPROVED&evidenceRef="],
    ["whitespace-only evidenceRef", FORM, "outcome=APPROVED&evidenceRef=%20%20%20"],
    ["duplicate evidenceRef", FORM, "outcome=APPROVED&evidenceRef=ev-1&evidenceRef=ev-2"],
    ["unknown field decisionRef", FORM, "outcome=APPROVED&evidenceRef=ev-1&decisionRef=decision-1"],
    ["unknown field decidedAt", FORM, "outcome=APPROVED&evidenceRef=ev-1&decidedAt=2000-01-01T00:00:00.000Z"],
  ] as const) {
    assert.equal(parseAttentionDecisionForm(contentType, body), undefined, label);
  }
});

// --- controls ---

test("C4 slice 3: renderAttentionDecisionControls escapes a hostile decisionRef everywhere, renders Approve+Deny when pending, Revoke when APPROVED, and nothing when terminal or the viewer may not decide", () => {
  const hostile = `"><script>alert(1)</script>`;
  const pending = renderAttentionDecisionControls({ decisionRef: hostile, canDecide: true });
  assert.doesNotMatch(pending, /<script>/);
  assert.match(pending, /action="\/os\/attention\/decisions\/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(pending, /value="APPROVED"/);
  assert.match(pending, /value="DENIED"/);
  assert.doesNotMatch(pending, /value="REVOKED"/);

  const approved = renderAttentionDecisionControls({ decisionRef: "decision-1", outcome: "APPROVED", canDecide: true });
  assert.match(approved, /value="REVOKED"/);
  assert.doesNotMatch(approved, /value="APPROVED"/);
  assert.doesNotMatch(approved, /value="DENIED"/);

  for (const outcome of ["DENIED", "REVOKED"] as const) {
    assert.equal(renderAttentionDecisionControls({ decisionRef: "decision-1", outcome, canDecide: true }), "");
  }
  assert.equal(renderAttentionDecisionControls({ decisionRef: "decision-1", canDecide: false }), "");
  assert.equal(renderAttentionDecisionControls({ decisionRef: "decision-1", outcome: "APPROVED", canDecide: false }), "");
});

// --- same-origin check is reused, not duplicated ---

test("C4 slice 3: the route module reuses the offboarding route's own isSameOriginMutationRequest rather than a second implementation", () => {
  assert.equal(typeof isSameOriginMutationRequest, "function");
  assert.equal(isSameOriginMutationRequest({}), true);
  assert.equal(isSameOriginMutationRequest({ origin: "https://attacker.example", host: "os.example" }), false);
});

// --- request handler wiring ---

function withStore(run: (store: DurableProtectedDecisionRecordStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "c4s3-unit-decisions-"));
  try {
    run(new FileDurableProtectedDecisionRecordStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseDeps(): Omit<InternalOsRequestHandlerDeps, "attentionDecision" | "attentionSource"> {
  return {
    provider: createDevFixtureStaffSessionProvider({ fixtures: buildReviewStaffSessionFixtureMap(), isProduction: false }),
    organization: REVIEW_ORGANIZATION,
    grants: buildReviewStaffAccessGrants(),
  };
}

function post(path: string, body: string, token = FOUNDER_REVIEW_FIXTURE.sessionToken): IncomingRequestLike {
  return { method: "POST", path, headers: { [STAFF_SESSION_TOKEN_HEADER]: token, "content-type": FORM }, body };
}

/** Seeds a decision record directly through the real, already-reviewed domain function - never through the route under test. */
function seedRecord(
  store: DurableProtectedDecisionRecordStore,
  decisionRef: string,
  outcome: ProtectedDecisionOutcome,
  evidenceRef = "seed-evidence",
): void {
  const record = createProtectedDecisionRecord({
    tenantScope: createTenantScope(REVIEW_ORGANIZATION.tenantId),
    decisionRef,
    outcome,
    organization: REVIEW_ORGANIZATION,
    membership: FOUNDER_REVIEW_FIXTURE.grant.membership,
    currentPrincipalRef: FOUNDER_REVIEW_FIXTURE.session.principal.principalId,
    authority: FOUNDER_REVIEW_FIXTURE.grant.authority,
    ...(FOUNDER_REVIEW_FIXTURE.grant.roleContext !== undefined ? { roleContext: FOUNDER_REVIEW_FIXTURE.grant.roleContext } : {}),
    decidedAt: "2026-10-23T00:00:00.000Z",
    evidenceRef,
  });
  store.putIfAbsentDecisionRecord(REVIEW_ORGANIZATION.tenantId, decisionRef, record);
}

/** Seeds an APPROVED record, then revises it to REVOKED, both through the real, already-reviewed domain functions. */
function seedRevokedRecord(store: DurableProtectedDecisionRecordStore, decisionRef: string, evidenceRef = "seed-evidence-revoked"): void {
  seedRecord(store, decisionRef, "APPROVED");
  const current = store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, decisionRef);
  assert.ok(current !== undefined);
  const revision = reviseProtectedDecisionRecord({
    current: current!,
    tenantScope: createTenantScope(REVIEW_ORGANIZATION.tenantId),
    outcome: "REVOKED",
    organization: REVIEW_ORGANIZATION,
    membership: FOUNDER_REVIEW_FIXTURE.grant.membership,
    currentPrincipalRef: FOUNDER_REVIEW_FIXTURE.session.principal.principalId,
    authority: FOUNDER_REVIEW_FIXTURE.grant.authority,
    ...(FOUNDER_REVIEW_FIXTURE.grant.roleContext !== undefined ? { roleContext: FOUNDER_REVIEW_FIXTURE.grant.roleContext } : {}),
    decidedAt: "2026-10-23T00:01:00.000Z",
    evidenceRef,
  });
  store.reviseDecisionRecord(REVIEW_ORGANIZATION.tenantId, decisionRef, revision);
}

/**
 * A fixture with WRITE (so it clears every destination gate that only
 * needs WRITE) but no EXECUTE and no protected-action authority - isolates
 * the `/os/attention` destination's own EXECUTE-or-protected-actions gate
 * from the ordinary WRITE floor, mirroring slice 2's own
 * `writeOnlyAdminFixture`.
 */
function writeOnlyFixture(): { token: string; session: StaffSessionContext; grant: StaffAccessGrant } {
  const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
  const principal = createAuthenticatedStaffPrincipal({ principalId: "staff-c4s3-write-only", displayName: "Write Only" });
  const membership = createOrganizationMembership({
    membershipId: "membership-c4s3-write-only",
    tenantScope,
    principalRef: principal.principalId,
    role: "STAFF",
  });
  return {
    token: "dev-staff-c4s3-write-only",
    session: { principal, issuedAt: "2026-01-01T00:00:00.000Z" },
    grant: {
      membership,
      authority: createAuthorityContext({ tenantScope, permissions: ["READ", "WRITE"], canPerformProtectedActions: false }),
      assignments: [],
    },
  };
}

function depsWithExtraGrant(
  store: DurableProtectedDecisionRecordStore,
  extra: { readonly token: string; readonly session: StaffSessionContext; readonly grant: StaffAccessGrant },
) {
  const fixtures = new Map(buildReviewStaffSessionFixtureMap());
  fixtures.set(extra.token, extra.session);
  return {
    provider: createDevFixtureStaffSessionProvider({ fixtures, isProduction: false }),
    organization: REVIEW_ORGANIZATION,
    grants: [...buildReviewStaffAccessGrants(), extra.grant],
    attentionDecision: { store },
  };
}

test("C4 slice 3: without a wired decision boundary, a decision POST is the same 501 as before this slice, nothing changes, and /os/attention renders with no form", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler(baseDeps());
    const response = handler(post(attentionDecisionPath("decision-unwired"), "outcome=APPROVED&evidenceRef=ev-1"));
    assert.equal(response.status, 501);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-unwired"), undefined);
  });
});

test("C4 slice 3: a wired handler creates an APPROVED decision through the real store and redirects 303 to /os/attention; decidedAt comes from the server clock, never from the request", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({
      ...baseDeps(),
      attentionDecision: { store, clock: () => "2026-10-23T12:00:00.000Z" },
    });
    const response = handler(post(attentionDecisionPath("decision-approve"), "outcome=APPROVED&evidenceRef=evidence-approve"));
    assert.equal(response.status, 303);
    assert.equal(response.headers["location"], "/os/attention");
    const stored = store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-approve");
    assert.equal(stored?.outcome, "APPROVED");
    assert.equal(stored?.evidenceRef, "evidence-approve");
    assert.equal(stored?.decidedAt, "2026-10-23T12:00:00.000Z");
    assert.equal(stored?.decidedByPrincipalRef, FOUNDER_REVIEW_FIXTURE.session.principal.principalId);

    // A submitted decidedAt field is an unknown field - rejected outright
    // (400), proving the request body can never influence it.
    const rejected = handler(
      post(attentionDecisionPath("decision-approve-2"), "outcome=APPROVED&evidenceRef=ev&decidedAt=2000-01-01T00:00:00.000Z"),
    );
    assert.equal(rejected.status, 400);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-approve-2"), undefined);
  });
});

test("C4 slice 3: a wired handler creates a DENIED decision through the real store and redirects 303", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const response = handler(post(attentionDecisionPath("decision-deny"), "outcome=DENIED&evidenceRef=evidence-deny"));
    assert.equal(response.status, 303);
    const stored = store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-deny");
    assert.equal(stored?.outcome, "DENIED");
  });
});

test("C4 slice 3: a wired handler revises an APPROVED decision to REVOKED through the real store and redirects 303", () => {
  withStore((store) => {
    seedRecord(store, "decision-revoke", "APPROVED");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const response = handler(post(attentionDecisionPath("decision-revoke"), "outcome=REVOKED&evidenceRef=evidence-revoke"));
    assert.equal(response.status, 303);
    const stored = store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-revoke");
    assert.equal(stored?.outcome, "REVOKED");
    assert.equal(stored?.evidenceRef, "evidence-revoke");
  });
});

test("C4 slice 3: a Member (READ only) cannot post a decision - 403 from the /os/attention destination gate, zero store change", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const response = handler(
      post(attentionDecisionPath("decision-member"), "outcome=APPROVED&evidenceRef=ev", MEMBER_REVIEW_FIXTURE.sessionToken),
    );
    assert.equal(response.status, 403);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-member"), undefined);
  });
});

test("C4 slice 3: WRITE without EXECUTE and without protected-action authority is 403 from the /os/attention destination gate itself - zero store change, no form rendered", () => {
  withStore((store) => {
    const fixture = writeOnlyFixture();
    const { token } = fixture;
    const deps = depsWithExtraGrant(store, fixture);
    const handler = createInternalOsRequestHandler(deps);

    const response = handler(post(attentionDecisionPath("decision-write-only"), "outcome=APPROVED&evidenceRef=ev", token));
    assert.equal(response.status, 403);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-write-only"), undefined);

    // WRITE alone is not enough to even reach /os/attention (it requires
    // EXECUTE or protected-action authority), so the destination itself is
    // FORBIDDEN, not merely the control hidden.
    const page = handler({ method: "GET", path: "/os/attention", headers: { [STAFF_SESSION_TOKEN_HEADER]: token } });
    assert.equal(page.status, 403);
  });
});

test("C4 slice 3: attempting to create a decision that already exists is 409 (ProtectedDecisionRecordTransitionError), zero store change", () => {
  withStore((store) => {
    seedRecord(store, "decision-exists", "APPROVED");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const response = handler(post(attentionDecisionPath("decision-exists"), "outcome=APPROVED&evidenceRef=ev-again"));
    assert.equal(response.status, 409);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-exists")?.evidenceRef, "seed-evidence");
  });
});

test("C4 slice 3: attempting to revoke a decisionRef that has never been decided is 409, zero store change (a fresh row never offers a Revoke control)", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const response = handler(post(attentionDecisionPath("decision-never-decided"), "outcome=REVOKED&evidenceRef=ev"));
    assert.equal(response.status, 409);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-never-decided"), undefined);
  });
});

test("C4 slice 3: attempting to revoke a DENIED (terminal) decision is 409, zero store change", () => {
  withStore((store) => {
    seedRecord(store, "decision-denied-terminal", "DENIED");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const response = handler(post(attentionDecisionPath("decision-denied-terminal"), "outcome=REVOKED&evidenceRef=ev"));
    assert.equal(response.status, 409);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-denied-terminal")?.outcome, "DENIED");
  });
});

test("C4 slice 3: attempting to revoke an already-REVOKED decision is also 409, zero store change", () => {
  withStore((store) => {
    seedRecord(store, "decision-revoked-terminal", "APPROVED");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const first = handler(post(attentionDecisionPath("decision-revoked-terminal"), "outcome=REVOKED&evidenceRef=ev-1"));
    assert.equal(first.status, 303);
    const second = handler(post(attentionDecisionPath("decision-revoked-terminal"), "outcome=REVOKED&evidenceRef=ev-2"));
    assert.equal(second.status, 409);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-revoked-terminal")?.evidenceRef, "ev-1");
  });
});

test("C4 slice 3: a malformed outcome or empty evidenceRef is a clean 400, zero store change", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    for (const body of ["outcome=MAYBE&evidenceRef=ev", "outcome=APPROVED&evidenceRef=", "outcome=APPROVED", "evidenceRef=ev"]) {
      const response = handler(post(attentionDecisionPath("decision-malformed"), body));
      assert.equal(response.status, 400, body);
    }
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-malformed"), undefined);
  });
});

test("C4 slice 3: a same-origin bypass attempt (foreign Origin) is 403 with zero store change, even with a valid staff session", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store } });
    const request: IncomingRequestLike = {
      method: "POST",
      path: attentionDecisionPath("decision-csrf"),
      headers: {
        [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken,
        "content-type": FORM,
        origin: "https://attacker.example",
        host: "os.example",
      },
      body: "outcome=APPROVED&evidenceRef=ev",
    };
    const response = handler(request);
    assert.equal(response.status, 403);
    assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-csrf"), undefined);
  });
});

test("C4 slice 3: an unexpected store failure renders the generic OS ERROR page (500) and never the error's own message, decisionRef, or tenant id", () => {
  withStore((store) => {
    const secret = "SECRET-INTERNAL-DETAIL /var/data/tenant-file.json";
    const failingStore: DurableProtectedDecisionRecordStore = {
      ...store,
      getDecisionRecord: () => {
        throw new Error(secret);
      },
      putIfAbsentDecisionRecord: (tenantId, decisionRef, record) => store.putIfAbsentDecisionRecord(tenantId, decisionRef, record),
      reviseDecisionRecord: (tenantId, decisionRef, revision) => store.reviseDecisionRecord(tenantId, decisionRef, revision),
    };
    const handler = createInternalOsRequestHandler({ ...baseDeps(), attentionDecision: { store: failingStore } });
    const response = handler(post(attentionDecisionPath("decision-failure"), "outcome=APPROVED&evidenceRef=ev"));
    assert.equal(response.status, 500);
    assert.ok(!response.body.includes("SECRET-INTERNAL-DETAIL"));
    assert.ok(!response.body.includes("/var/data"));
    assert.ok(!response.body.includes("decision-failure"));
    assert.ok(!response.body.includes(REVIEW_ORGANIZATION.tenantId));
  });
});

test("C4 slice 3: the dev-only standalone internal OS server also wires and serves this route over a real socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c4s3-standalone-decisions-"));
  try {
    const store = new FileDurableProtectedDecisionRecordStore(dir);
    const server = createInternalOsHttpServer({
      isProduction: false,
      devStaffFixtures: buildReviewStaffSessionFixtureMap(),
      organization: REVIEW_ORGANIZATION,
      grants: buildReviewStaffAccessGrants(),
      attentionDecision: { store },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${attentionDecisionPath("decision-standalone")}`, {
        method: "POST",
        redirect: "manual",
        headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken, "content-type": FORM },
        body: "outcome=APPROVED&evidenceRef=evidence-standalone",
      });
      assert.equal(response.status, 303);
      assert.equal(store.getDecisionRecord(REVIEW_ORGANIZATION.tenantId, "decision-standalone")?.outcome, "APPROVED");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- /os/attention renders the correct control (or none) for each decision state ---

function waitRequestFor(decisionRef: string, waitRequestId: string): ProtectedDecisionWaitRequest {
  return {
    waitRequestId: waitRequestId as ProtectedDecisionWaitRequest["waitRequestId"],
    tenantId: REVIEW_ORGANIZATION.tenantId,
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

/** Extracts the single `<tr>...</tr>` block whose text contains `marker`, so assertions never accidentally span two rows. */
function rowContaining(body: string, marker: string): string {
  const match = body.match(new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?${marker}(?:(?!</tr>)[\\s\\S])*?</tr>`));
  assert.ok(match !== null, `expected a <tr> row containing ${JSON.stringify(marker)}`);
  return match![0];
}

function withAttentionDeps(
  run: (deps: { recordStore: FileDurableProtectedDecisionRecordStore; waitStore: FileDurableProtectedDecisionWaitStore }) => void,
): void {
  const recordDir = mkdtempSync(join(tmpdir(), "c4s3-attention-records-"));
  const waitDir = mkdtempSync(join(tmpdir(), "c4s3-attention-waits-"));
  try {
    run({ recordStore: new FileDurableProtectedDecisionRecordStore(recordDir), waitStore: new FileDurableProtectedDecisionWaitStore(waitDir) });
  } finally {
    rmSync(recordDir, { recursive: true, force: true });
    rmSync(waitDir, { recursive: true, force: true });
  }
}

test("C4 slice 3: /os/attention renders Approve+Deny for a pending row, Revoke for an APPROVED row, and no form for DENIED/REVOKED rows, never the session token", () => {
  withAttentionDeps(({ recordStore, waitStore }) => {
    waitStore.putIfAbsentWaitRequest(REVIEW_ORGANIZATION.tenantId, "wait-pending", waitRequestFor("decision-pending", "wait-pending"));
    waitStore.putIfAbsentWaitRequest(REVIEW_ORGANIZATION.tenantId, "wait-approved", waitRequestFor("decision-approved", "wait-approved"));
    waitStore.putIfAbsentWaitRequest(REVIEW_ORGANIZATION.tenantId, "wait-denied", waitRequestFor("decision-denied", "wait-denied"));
    waitStore.putIfAbsentWaitRequest(REVIEW_ORGANIZATION.tenantId, "wait-revoked", waitRequestFor("decision-revoked", "wait-revoked"));
    seedRecord(recordStore, "decision-approved", "APPROVED");
    seedRecord(recordStore, "decision-denied", "DENIED");
    seedRevokedRecord(recordStore, "decision-revoked");

    const handler = createInternalOsRequestHandler({
      ...baseDeps(),
      attentionSource: createDurableAttentionSource({ list: () => [] } as never, waitStore, recordStore),
      attentionDecision: { store: recordStore },
    });
    const response = handler({ method: "GET", path: "/os/attention", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(response.status, 200);
    const body = response.body;
    assert.ok(!body.includes(FOUNDER_REVIEW_FIXTURE.sessionToken), "the session token must never be rendered into the page");

    // Pending: Approve and Deny forms, status "Pending decision".
    const pendingRow = rowContaining(body, "decision-pending");
    assert.match(pendingRow, /Pending decision/);
    assert.match(pendingRow, /action="\/os\/attention\/decisions\/decision-pending"[^]*?value="APPROVED"/);
    assert.match(pendingRow, /action="\/os\/attention\/decisions\/decision-pending"[^]*?value="DENIED"/);
    assert.doesNotMatch(pendingRow, /value="REVOKED"/);

    // APPROVED: Revoke form, status "APPROVED".
    const approvedRow = rowContaining(body, "decision-approved");
    assert.match(approvedRow, /action="\/os\/attention\/decisions\/decision-approved"[^]*?value="REVOKED"/);
    assert.doesNotMatch(approvedRow, /value="APPROVED"/);
    assert.doesNotMatch(approvedRow, /value="DENIED"/);

    // DENIED: status text only, no form at all.
    const deniedRow = rowContaining(body, "decision-denied");
    assert.doesNotMatch(deniedRow, /<form/i);
    assert.match(deniedRow, />DENIED</);

    // REVOKED: status text only, no form at all.
    const revokedRow = rowContaining(body, "decision-revoked");
    assert.doesNotMatch(revokedRow, /<form/i);
    assert.match(revokedRow, />REVOKED</);
  });
});

/**
 * EXECUTE plus WRITE, but no protected-action authority - clears both the
 * `/os/attention` destination gate (EXECUTE) and `resolveAttentionView`'s
 * own WRITE requirement, but fails `canDecideProtectedDecision`'s stricter
 * EXECUTE-AND-protected-actions floor. Isolates "sees the page and the
 * decision status, but never the form" from the destination gate itself.
 */
function executeOnlyFixture(): { token: string; session: StaffSessionContext; grant: StaffAccessGrant } {
  const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
  const principal = createAuthenticatedStaffPrincipal({ principalId: "staff-c4s3-execute-only", displayName: "Execute Only" });
  const membership = createOrganizationMembership({
    membershipId: "membership-c4s3-execute-only",
    tenantScope,
    principalRef: principal.principalId,
    role: "STAFF",
  });
  return {
    token: "dev-staff-c4s3-execute-only",
    session: { principal, issuedAt: "2026-01-01T00:00:00.000Z" },
    grant: {
      membership,
      authority: createAuthorityContext({ tenantScope, permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: false }),
      assignments: [],
    },
  };
}

test("C4 slice 3: /os/attention shows decision status but renders no form for a viewer who can reach the page yet lacks protected-action authority, even when the decision boundary is wired", () => {
  withAttentionDeps(({ recordStore, waitStore }) => {
    waitStore.putIfAbsentWaitRequest(REVIEW_ORGANIZATION.tenantId, "wait-ro", waitRequestFor("decision-ro", "wait-ro"));
    seedRecord(recordStore, "decision-ro", "APPROVED");
    const fixture = executeOnlyFixture();
    const { token } = fixture;
    const fixtures = new Map(buildReviewStaffSessionFixtureMap());
    fixtures.set(token, fixture.session);
    const handler = createInternalOsRequestHandler({
      provider: createDevFixtureStaffSessionProvider({ fixtures, isProduction: false }),
      organization: REVIEW_ORGANIZATION,
      grants: [...buildReviewStaffAccessGrants(), fixture.grant],
      attentionSource: createDurableAttentionSource({ list: () => [] } as never, waitStore, recordStore),
      attentionDecision: { store: recordStore },
    });
    const response = handler({ method: "GET", path: "/os/attention", headers: { [STAFF_SESSION_TOKEN_HEADER]: token } });
    assert.equal(response.status, 200);
    assert.match(response.body, /APPROVED/);
    assert.doesNotMatch(response.body, /<form/i);
    assert.doesNotMatch(response.body, /<button/i);
  });
});
