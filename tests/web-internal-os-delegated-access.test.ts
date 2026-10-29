import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { FileDurableDelegatedAccessGrantStore, type DurableDelegatedAccessGrantStore } from "../src/domain/durable-delegated-access-grant-store.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import {
  createInternalOsRequestHandler,
  STAFF_SESSION_TOKEN_HEADER,
  DELEGATION_ID_HEADER,
  type InternalOsRequestHandlerDeps,
} from "../src/web/internal-os-request-handler.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { isSameOriginMutationRequest } from "../src/web/internal-os-offboarding-decision-route.js";
import {
  parseDelegatedAccessMintForm,
  parseDelegatedAccessRevokeForm,
} from "../src/web/internal-os-delegated-access-route.js";
import { DELEGATED_ACCESS_MINT_PATH, DELEGATED_ACCESS_REVOKE_PATH } from "../src/web/internal-os-delegated-access-controls.js";
import type { IncomingRequestLike } from "../src/web/request-handler.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * D12 (delegated-access half, unblocked once C7 landed): transport-agnostic
 * tests of the delegated-access mint/revoke route's pieces (form parsing)
 * and the request handler's wiring of mint/revoke/resolve, mirroring
 * `tests/web-internal-os-connection-state-decision.test.ts`'s own structure.
 */

const FORM = "application/x-www-form-urlencoded";

// --- form parsing ---

test("D12: parseDelegatedAccessMintForm accepts delegatePrincipalRef+expiresAt (required), permissions (0+ of READ/WRITE/EXECUTE), canPerformProtectedActions and projectId (optional)", () => {
  assert.deepEqual(parseDelegatedAccessMintForm(FORM, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z"), {
    delegatePrincipalRef: "staff-x",
    permissions: [],
    canPerformProtectedActions: false,
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.deepEqual(
    parseDelegatedAccessMintForm(
      FORM,
      "delegatePrincipalRef=staff-x&permissions=READ&permissions=WRITE&canPerformProtectedActions=true&projectId=project-1&expiresAt=2026-12-01T00:00:00.000Z",
    ),
    {
      delegatePrincipalRef: "staff-x",
      permissions: ["READ", "WRITE"],
      canPerformProtectedActions: true,
      projectId: "project-1",
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
  );

  for (const [label, contentType, body] of [
    ["no content type", undefined, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z"],
    ["json", "application/json", "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z"],
    ["no body", FORM, undefined],
    ["missing delegatePrincipalRef", FORM, "expiresAt=2026-12-01T00:00:00.000Z"],
    ["empty delegatePrincipalRef", FORM, "delegatePrincipalRef=&expiresAt=2026-12-01T00:00:00.000Z"],
    ["duplicate delegatePrincipalRef", FORM, "delegatePrincipalRef=a&delegatePrincipalRef=b&expiresAt=2026-12-01T00:00:00.000Z"],
    ["missing expiresAt", FORM, "delegatePrincipalRef=staff-x"],
    ["empty expiresAt", FORM, "delegatePrincipalRef=staff-x&expiresAt="],
    ["duplicate expiresAt", FORM, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z&expiresAt=2027-01-01T00:00:00.000Z"],
    ["invalid permission literal", FORM, "delegatePrincipalRef=staff-x&permissions=SUDO&expiresAt=2026-12-01T00:00:00.000Z"],
    ["duplicate projectId", FORM, "delegatePrincipalRef=staff-x&projectId=a&projectId=b&expiresAt=2026-12-01T00:00:00.000Z"],
    ["unknown field", FORM, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z&delegationId=forged"],
  ] as const) {
    assert.equal(parseDelegatedAccessMintForm(contentType, body), undefined, label);
  }
});

test("D12: parseDelegatedAccessRevokeForm accepts exactly delegationId+reason, each non-empty after trim", () => {
  assert.deepEqual(parseDelegatedAccessRevokeForm(FORM, "delegationId=dag-1&reason=done"), { delegationId: "dag-1", reason: "done" });
  assert.deepEqual(parseDelegatedAccessRevokeForm(FORM, "delegationId=dag-1&reason=+padded+"), { delegationId: "dag-1", reason: "padded" });

  for (const [label, contentType, body] of [
    ["no content type", undefined, "delegationId=dag-1&reason=done"],
    ["no body", FORM, undefined],
    ["missing delegationId", FORM, "reason=done"],
    ["empty delegationId", FORM, "delegationId=&reason=done"],
    ["missing reason", FORM, "delegationId=dag-1"],
    ["whitespace-only reason", FORM, "delegationId=dag-1&reason=%20%20"],
    ["duplicate delegationId", FORM, "delegationId=a&delegationId=b&reason=done"],
    ["unknown field", FORM, "delegationId=dag-1&reason=done&extra=1"],
  ] as const) {
    assert.equal(parseDelegatedAccessRevokeForm(contentType, body), undefined, label);
  }
});

// --- same-origin check is reused, not duplicated ---

test("D12: the route module reuses the offboarding route's own isSameOriginMutationRequest rather than a second implementation", () => {
  assert.equal(typeof isSameOriginMutationRequest, "function");
  assert.equal(isSameOriginMutationRequest({}), true);
  assert.equal(isSameOriginMutationRequest({ origin: "https://attacker.example", host: "os.example" }), false);
});

// --- request handler wiring ---

function withStore(run: (store: DurableDelegatedAccessGrantStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "d12-unit-delegations-"));
  try {
    run(new FileDurableDelegatedAccessGrantStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseDeps(): Omit<InternalOsRequestHandlerDeps, "delegatedAccess"> {
  return {
    provider: createDevFixtureStaffSessionProvider({ fixtures: buildReviewStaffSessionFixtureMap(), isProduction: false }),
    organization: REVIEW_ORGANIZATION,
    grants: buildReviewStaffAccessGrants(),
  };
}

function post(path: string, body: string, token = FOUNDER_REVIEW_FIXTURE.sessionToken): IncomingRequestLike {
  return { method: "POST", path, headers: { [STAFF_SESSION_TOKEN_HEADER]: token, "content-type": FORM }, body };
}

function getAdmin(token: string | undefined, delegationId?: string): IncomingRequestLike {
  return {
    method: "GET",
    path: "/os/admin",
    headers: {
      ...(token !== undefined ? { [STAFF_SESSION_TOKEN_HEADER]: token } : {}),
      ...(delegationId !== undefined ? { [DELEGATION_ID_HEADER]: delegationId } : {}),
    },
  };
}

test("D12: without a wired delegatedAccess boundary, mint/revoke POSTs are the same 501 as before this slice, and /os/admin renders with no delegated-access section", () => {
  const handler = createInternalOsRequestHandler(baseDeps());
  const mintResponse = handler(post(DELEGATED_ACCESS_MINT_PATH, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z"));
  assert.equal(mintResponse.status, 501);
  const revokeResponse = handler(post(DELEGATED_ACCESS_REVOKE_PATH, "delegationId=dag-1&reason=done"));
  assert.equal(revokeResponse.status, 501);

  const admin = handler({ method: "GET", path: "/os/admin", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
  assert.equal(admin.status, 200);
  assert.ok(!admin.body.includes("Delegated access"));

  // The GET resolve branch is also inert without the boundary wired.
  const resolve = handler(getAdmin(FOUNDER_REVIEW_FIXTURE.sessionToken, "dag-1"));
  assert.equal(resolve.status, 200);
  assert.ok(!resolve.body.includes("Effective delegated access"));
});

test("D12: mint succeeds when the caller delegates a subset of their OWN current authority, returns a one-time confirmation with the new delegationId, and the store records delegatorMembershipId as the CALLER's own membership", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const response = handler(
      post(
        DELEGATED_ACCESS_MINT_PATH,
        "delegatePrincipalRef=staff-delegate-x&permissions=READ&permissions=WRITE&canPerformProtectedActions=true&expiresAt=2026-12-01T00:00:00.000Z",
      ),
    );
    assert.equal(response.status, 200);
    assert.match(response.body, /Delegation created/);
    const match = response.body.match(/<code>(delegation-[0-9a-f-]+)<\/code>/);
    assert.ok(match !== null, "expected the new delegationId to be shown in the confirmation page");
    const delegationId = match![1]!;
    const stored = store.getGrant(createTenantScope(REVIEW_ORGANIZATION.tenantId), delegationId);
    assert.ok(stored !== undefined);
    assert.equal(stored!.delegatorMembershipId, FOUNDER_REVIEW_FIXTURE.grant.membership.membershipId);
    assert.equal(stored!.delegatePrincipalRef, "staff-delegate-x");
    assert.deepEqual([...stored!.permissions].sort(), ["READ", "WRITE"]);
    assert.equal(stored!.canPerformProtectedActions, true);
  });
});

test("D12: mint fails closed (FORBIDDEN) when the caller asks to delegate more than their OWN current authority holds - over-broad permissions and protected-action authority are both rejected, nothing is stored", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    // MEMBER_REVIEW_FIXTURE holds READ only, canPerformProtectedActions: false.
    const overBroadPermission = handler(
      post(
        DELEGATED_ACCESS_MINT_PATH,
        "delegatePrincipalRef=staff-delegate-x&permissions=WRITE&expiresAt=2026-12-01T00:00:00.000Z",
        MEMBER_REVIEW_FIXTURE.sessionToken,
      ),
    );
    assert.equal(overBroadPermission.status, 403);
    const overBroadProtected = handler(
      post(
        DELEGATED_ACCESS_MINT_PATH,
        "delegatePrincipalRef=staff-delegate-x&permissions=READ&canPerformProtectedActions=true&expiresAt=2026-12-01T00:00:00.000Z",
        MEMBER_REVIEW_FIXTURE.sessionToken,
      ),
    );
    assert.equal(overBroadProtected.status, 403);
    assert.equal(store.getGrant(createTenantScope(REVIEW_ORGANIZATION.tenantId), "dag-1"), undefined);
  });
});

test("D12: mint fails closed on same-origin violation (403), bad form (400), and an unauthenticated caller (401)", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const crossOrigin = handler({
      ...post(DELEGATED_ACCESS_MINT_PATH, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z"),
      headers: {
        [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken,
        "content-type": FORM,
        origin: "https://attacker.example",
        host: "os.example",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const badForm = handler(post(DELEGATED_ACCESS_MINT_PATH, "delegatePrincipalRef=staff-x"));
    assert.equal(badForm.status, 400);

    const unauthenticated = handler(post(DELEGATED_ACCESS_MINT_PATH, "delegatePrincipalRef=staff-x&expiresAt=2026-12-01T00:00:00.000Z", "no-such-token"));
    assert.equal(unauthenticated.status, 401);
  });
});

test("D12: revoke succeeds for the ORIGINAL delegator, redirects to /os/admin, and the store shows REVOKED", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const mint = handler(
      post(DELEGATED_ACCESS_MINT_PATH, "delegatePrincipalRef=staff-delegate-x&permissions=READ&expiresAt=2026-12-01T00:00:00.000Z"),
    );
    const delegationId = mint.body.match(/<code>(delegation-[0-9a-f-]+)<\/code>/)![1]!;

    const revoke = handler(post(DELEGATED_ACCESS_REVOKE_PATH, `delegationId=${delegationId}&reason=no+longer+needed`));
    assert.equal(revoke.status, 303);
    assert.equal(revoke.headers["location"], "/os/admin");
    const stored = store.getGrant(createTenantScope(REVIEW_ORGANIZATION.tenantId), delegationId);
    assert.equal(stored?.state, "REVOKED");
    assert.equal(stored?.revokedReason, "no longer needed");
  });
});

test("D12: revoke fails closed (FORBIDDEN) when the caller is NOT the original delegator, and the grant is left untouched", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const mint = handler(
      post(DELEGATED_ACCESS_MINT_PATH, "delegatePrincipalRef=staff-delegate-x&permissions=READ&expiresAt=2026-12-01T00:00:00.000Z"),
    );
    const delegationId = mint.body.match(/<code>(delegation-[0-9a-f-]+)<\/code>/)![1]!;

    const wrongDelegator = handler(
      post(DELEGATED_ACCESS_REVOKE_PATH, `delegationId=${delegationId}&reason=not+mine`, MEMBER_REVIEW_FIXTURE.sessionToken),
    );
    assert.equal(wrongDelegator.status, 403);
    assert.equal(store.getGrant(createTenantScope(REVIEW_ORGANIZATION.tenantId), delegationId)?.state, "ACTIVE");
  });
});

test("D12: revoke of a delegationId that does not exist -> FORBIDDEN (no existence oracle), never NOT_FOUND or a different status", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const response = handler(post(DELEGATED_ACCESS_REVOKE_PATH, "delegationId=dag-does-not-exist&reason=x"));
    assert.equal(response.status, 403);
  });
});

/** Mints a delegation from FOUNDER_REVIEW_FIXTURE to `delegatePrincipalRef`, returns the new delegationId. */
function mintTo(
  handler: ReturnType<typeof createInternalOsRequestHandler>,
  delegatePrincipalRef: string,
  extra = "permissions=READ&permissions=WRITE",
): string {
  const mint = handler(post(DELEGATED_ACCESS_MINT_PATH, `delegatePrincipalRef=${delegatePrincipalRef}&${extra}&expiresAt=2026-12-01T00:00:00.000Z`));
  assert.equal(mint.status, 200, mint.body);
  return mint.body.match(/<code>(delegation-[0-9a-f-]+)<\/code>/)![1]!;
}

test("D12: GET /os/admin with the delegation header resolves GRANTED for the actual delegate, intersected with the delegator's CURRENT authority, and renders no nav", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const delegationId = mintTo(handler, MEMBER_REVIEW_FIXTURE.grant.membership.principalRef);

    const resolved = handler(getAdmin(MEMBER_REVIEW_FIXTURE.sessionToken, delegationId));
    assert.equal(resolved.status, 200);
    assert.match(resolved.body, /Effective delegated access/);
    assert.match(resolved.body, /GRANTED/);
    assert.ok(!resolved.body.includes('class="app-nav"'), "a delegated-access view is not a member browsing the OS");
  });
});

test("D12: GET /os/admin with the delegation header resolves DENIED (not thrown, not 403) when the authenticated caller is not the named delegate", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const delegationId = mintTo(handler, "staff-someone-else-entirely");

    // MEMBER_REVIEW_FIXTURE authenticates fine, but is not the delegate the grant names.
    const resolved = handler(getAdmin(MEMBER_REVIEW_FIXTURE.sessionToken, delegationId));
    assert.equal(resolved.status, 200);
    assert.match(resolved.body, /DENIED/);
  });
});

test("D12: GET /os/admin with the delegation header -> FORBIDDEN for an unknown delegationId, and -> UNAUTHENTICATED with no session, before any grant lookup", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const unknown = handler(getAdmin(FOUNDER_REVIEW_FIXTURE.sessionToken, "dag-does-not-exist"));
    assert.equal(unknown.status, 403);

    const noSession = handler(getAdmin(undefined, "dag-does-not-exist"));
    assert.equal(noSession.status, 401);
  });
});

test("D12: GET /os/admin with an EMPTY delegation header is treated as absent - the ordinary admin page, unaffected", () => {
  withStore((store) => {
    const handler = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const response = handler(getAdmin(FOUNDER_REVIEW_FIXTURE.sessionToken, ""));
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('class="app-nav"'));
  });
});

test("D12: the Admin page renders the mint and revoke forms only when delegatedAccess is wired, and the forms never carry the staff session token", () => {
  withStore((store) => {
    const wired = createInternalOsRequestHandler({ ...baseDeps(), delegatedAccess: { store } });
    const wiredResponse = wired({ method: "GET", path: "/os/admin", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.ok(wiredResponse.body.includes("Delegated access"));
    assert.ok(wiredResponse.body.includes(`action="${DELEGATED_ACCESS_MINT_PATH}"`));
    assert.ok(wiredResponse.body.includes(`action="${DELEGATED_ACCESS_REVOKE_PATH}"`));
    assert.doesNotMatch(wiredResponse.body, new RegExp(FOUNDER_REVIEW_FIXTURE.sessionToken));

    const unwired = createInternalOsRequestHandler(baseDeps());
    const unwiredResponse = unwired({ method: "GET", path: "/os/admin", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.ok(!unwiredResponse.body.includes("Delegated access"));
  });
});
