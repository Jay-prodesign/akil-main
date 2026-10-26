import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createConnectionRequirement, createSecretRef, type ConnectionState } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore, type DurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { createInternalOsRequestHandler, STAFF_SESSION_TOKEN_HEADER, type InternalOsRequestHandlerDeps } from "../src/web/internal-os-request-handler.js";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { createDurableConnectionsSource } from "../src/web/connections-durable-source.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import {
  isSameOriginMutationRequest,
  parseOffboardingDecisionPath,
} from "../src/web/internal-os-offboarding-decision-route.js";
import {
  parseConnectorConnectionStatePath,
  parseConnectorConnectionStateForm,
} from "../src/web/internal-os-connector-connection-decision-route.js";
import {
  connectorConnectionStatePath,
  renderConnectorConnectionStateControls,
  CONNECTION_STATE_OPTIONS,
} from "../src/web/internal-os-connection-state-controls.js";
import type { IncomingRequestLike } from "../src/web/request-handler.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * C4 slice 2 (gap scan 2026-10-23, second `/os` mutation slice): transport-
 * agnostic tests of the connector-connection state-decision route's pieces
 * (path, form parsing, controls) and the request handler's wiring of it,
 * mirroring `tests/web-internal-os-offboarding-decision.test.ts`'s own
 * structure and hunt-list exactly. The end-to-end proof over a real socket
 * through the composed runtime is
 * `tests/runtime-connector-connection-state-decision-route.test.ts`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORM = "application/x-www-form-urlencoded";

// --- path ---

test("C4 slice 2: parseConnectorConnectionStatePath recognizes exactly the one state path shape (same segment rules as parseInternalOsPath)", () => {
  assert.equal(parseConnectorConnectionStatePath(connectorConnectionStatePath("bind-1")), "bind-1");
  assert.equal(parseConnectorConnectionStatePath("/os/connections/bind-1/state/"), "bind-1");
  assert.equal(parseConnectorConnectionStatePath("//os//connections/bind-1/state"), "bind-1");
  for (const path of [
    "/os/connections",
    "/os/connections/bind-1",
    "/os/connections/bind-1/state/extra",
    "/os/connections//state",
    "/os/connections/bind-1/other",
    "/portal/connections/bind-1/state",
    "/os/admin/bind-1/state",
  ]) {
    assert.equal(parseConnectorConnectionStatePath(path), undefined, path);
  }
  // This path shape must never collide with the offboarding decision paths' own parser.
  assert.equal(parseOffboardingDecisionPath(connectorConnectionStatePath("bind-1")), undefined);
});

// --- form parsing ---

test("C4 slice 2: parseConnectorConnectionStateForm accepts exactly one field (`to`), exactly one of the six recognized ConnectionState literals", () => {
  for (const state of CONNECTION_STATE_OPTIONS) {
    assert.equal(parseConnectorConnectionStateForm(FORM, `to=${state}`), state);
  }
  assert.equal(parseConnectorConnectionStateForm(`${FORM}; charset=UTF-8`, "to=DEGRADED"), "DEGRADED");

  for (const [label, contentType, body] of [
    ["no content type", undefined, "to=DEGRADED"],
    ["json", "application/json", "to=DEGRADED"],
    ["multipart", "multipart/form-data", "to=DEGRADED"],
    ["no body", FORM, undefined],
    ["unrecognized state", FORM, "to=UNKNOWN_STATE"],
    ["lowercase state", FORM, "to=degraded"],
    ["empty to", FORM, "to="],
    ["missing to", FORM, "other=DEGRADED"],
    ["duplicate to", FORM, "to=DEGRADED&to=REVOKED"],
    ["unknown field", FORM, "to=DEGRADED&expectedVersion=1"],
    ["unknown field connectionBindingId", FORM, "to=DEGRADED&connectionBindingId=bind-1"],
  ] as const) {
    assert.equal(parseConnectorConnectionStateForm(contentType, body), undefined, label);
  }
});

// --- controls ---

test("C4 slice 2: renderConnectorConnectionStateControls escapes a hostile connectionBindingId everywhere, and renders nothing when the viewer may not mutate state", () => {
  const hostile = `"><script>alert(1)</script>` as never;
  const html = renderConnectorConnectionStateControls({ connectionBindingId: hostile, canMutateState: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /action="\/os\/connections\/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\/state"/);
  for (const state of CONNECTION_STATE_OPTIONS) {
    assert.match(html, new RegExp(`<option value="${state}">${state}</option>`));
  }
  assert.equal(renderConnectorConnectionStateControls({ connectionBindingId: "bind-1" as never, canMutateState: false }), "");
});

// --- same-origin check is reused, not duplicated ---

test("C4 slice 2: the route module reuses the offboarding route's own isSameOriginMutationRequest rather than a second implementation", () => {
  assert.equal(typeof isSameOriginMutationRequest, "function");
  assert.equal(isSameOriginMutationRequest({}), true);
  assert.equal(isSameOriginMutationRequest({ origin: "https://attacker.example", host: "os.example" }), false);
});

// --- request handler wiring ---

function withStore(run: (store: DurableConnectorConnectionStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "c4s2-unit-connections-"));
  try {
    run(new FileDurableConnectorConnectionStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ownershipFor(connectionBindingId: string): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: REVIEW_ORGANIZATION.tenantId,
    customerId: `customer-${connectionBindingId}`,
    projectId: `project-${connectionBindingId}`,
  });
}

/** Builds a REQUESTED connection, then transitions it to `at` before seeding the store (VERIFIED requires the separate verify path). */
function seedConnection(store: DurableConnectorConnectionStore, connectionBindingId: string, at: ConnectionState): ConnectorConnectionInstance {
  const ownership = ownershipFor(connectionBindingId);
  const descriptor = createConnectorDescriptor({
    connectorKind: "GENERIC_CUSTOM_API",
    displayName: "C4 slice 2 API",
    supportedAuthModes: ["API_KEY", "BEARER_TOKEN"],
    capabilityRefs: ["cap:c4s2-ping"],
    isAiModelProvider: false,
    requiresOAuthRedirect: false,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${connectionBindingId}`,
    ownership,
    requiredCapabilityRef: "cap:c4s2-ping",
    purpose: "C4 slice 2 test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-c4s2",
    integrationInstanceRef: "instance-c4s2",
    delegatedScope: [],
    authMode: "API_KEY",
    secretRef: createSecretRef({ secretRefId: `secret-${connectionBindingId}` }),
  });
  if (at === "REQUESTED") {
    store.save(instance);
    return instance;
  }
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  if (at === "CONNECTED_UNVERIFIED") {
    store.save(instance);
    return instance;
  }
  if (at === "VERIFIED") {
    instance = verifyConnectorConnection(instance, `evidence-${connectionBindingId}`);
    store.save(instance);
    return instance;
  }
  // DEGRADED / REVOKED / HANDOVER_COMPLETE each go through VERIFIED first.
  instance = verifyConnectorConnection(instance, `evidence-${connectionBindingId}`);
  instance = transitionConnectorConnection(instance, at);
  store.save(instance);
  return instance;
}

function baseDeps(): Omit<InternalOsRequestHandlerDeps, "connectorConnectionStateDecision" | "connectionsSource"> {
  return {
    provider: createDevFixtureStaffSessionProvider({ fixtures: buildReviewStaffSessionFixtureMap(), isProduction: false }),
    organization: REVIEW_ORGANIZATION,
    grants: buildReviewStaffAccessGrants(),
  };
}

function post(path: string, body: string, token = FOUNDER_REVIEW_FIXTURE.sessionToken): IncomingRequestLike {
  return { method: "POST", path, headers: { [STAFF_SESSION_TOKEN_HEADER]: token, "content-type": FORM }, body };
}

/**
 * A fixture with WRITE (so it clears the `/os/connections` destination
 * gate) but no EXECUTE and no protected-action authority, and a curated
 * ADMIN access role (so it clears the domain mutation's own role check) -
 * isolates the EXECUTE-permission floor from both the destination gate and
 * the role floor. `buildReviewStaffAccessGrants()`'s own three fixtures
 * never exercise this combination.
 */
function writeOnlyAdminFixture(): { token: string; session: StaffSessionContext; grant: StaffAccessGrant } {
  const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
  const principal = createAuthenticatedStaffPrincipal({ principalId: "staff-c4s2-write-admin", displayName: "Write Admin" });
  const membership = createOrganizationMembership({
    membershipId: "membership-c4s2-write-admin",
    tenantScope,
    principalRef: principal.principalId,
    role: "STAFF",
  });
  return {
    token: "dev-staff-c4s2-write-admin",
    session: { principal, issuedAt: "2026-01-01T00:00:00.000Z" },
    grant: {
      membership,
      authority: createAuthorityContext({
        tenantScope,
        permissions: ["READ", "WRITE"],
        canPerformProtectedActions: false,
      }),
      assignments: [],
      roleContext: createOrganizationAccessRoleContext({ membership, role: "ADMIN" }),
    },
  };
}

function depsWithExtraGrant(
  store: DurableConnectorConnectionStore,
  extra: { readonly token: string; readonly session: StaffSessionContext; readonly grant: StaffAccessGrant },
) {
  const fixtures = new Map(buildReviewStaffSessionFixtureMap());
  fixtures.set(extra.token, extra.session);
  return {
    provider: createDevFixtureStaffSessionProvider({ fixtures, isProduction: false }),
    organization: REVIEW_ORGANIZATION,
    grants: [...buildReviewStaffAccessGrants(), extra.grant],
    connectorConnectionStateDecision: { store },
  };
}

test("C4 slice 2: without a wired decision boundary, a state-change POST is the same 501 as before this slice, nothing changes, and /os/connections renders with no form", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unwired", "VERIFIED");
    const handler = createInternalOsRequestHandler({ ...baseDeps(), connectionsSource: createDurableConnectionsSource(store) });
    const response = handler(post(connectorConnectionStatePath("bind-unwired"), "to=DEGRADED"));
    assert.equal(response.status, 501);
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "VERIFIED");

    const connections = handler({ method: "GET", path: "/os/connections", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(connections.status, 200);
    assert.match(connections.body, /bind-unwired/);
    assert.doesNotMatch(connections.body, /<form/i);
    assert.doesNotMatch(connections.body, /<button/i);
  });
});

test("C4 slice 2: a wired handler transitions through the real store and redirects 303 to /os/connections; /os/connections then renders the control for the OWNER+EXECUTE+protected viewer", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unit-transition", "VERIFIED");
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store } };
    const handler = createInternalOsRequestHandler(deps);

    const founder = handler({ method: "GET", path: "/os/connections", headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(founder.status, 200);
    assert.match(founder.body, new RegExp(`<form method="post" action="/os/connections/${bound.binding.connectionBindingId}/state"`));
    assert.ok(!founder.body.includes(FOUNDER_REVIEW_FIXTURE.sessionToken), "the session token must never be rendered into the page");

    const response = handler(post(connectorConnectionStatePath("bind-unit-transition"), "to=DEGRADED"));
    assert.equal(response.status, 303);
    assert.equal(response.headers["location"], "/os/connections");
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "DEGRADED");
  });
});

test("C4 slice 2: a Member (READ only, no WRITE) cannot post a state change - 403 from the /os/connections destination gate, zero store change, and sees no control on the GET page", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unit-member", "VERIFIED");
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store } };
    const handler = createInternalOsRequestHandler(deps);

    const response = handler(post(connectorConnectionStatePath("bind-unit-member"), "to=DEGRADED", MEMBER_REVIEW_FIXTURE.sessionToken));
    assert.equal(response.status, 403);
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "VERIFIED");

    // MEMBER_REVIEW_FIXTURE has READ only, so it cannot even reach
    // /os/connections (WRITE-gated) - the destination itself is FORBIDDEN,
    // not merely the control hidden.
    const connections = handler({ method: "GET", path: "/os/connections", headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(connections.status, 403);
  });
});

test("C4 slice 2: WRITE plus a curated ADMIN role, but no EXECUTE permission and no protected-action authority, is 403 from the domain mutation's own floor - zero store change, no form rendered", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unit-write-only", "VERIFIED");
    const fixture = writeOnlyAdminFixture();
    const { token } = fixture;
    const deps = depsWithExtraGrant(store, fixture);
    const handler = createInternalOsRequestHandler({ ...deps, connectionsSource: createDurableConnectionsSource(store) });

    const response = handler(post(connectorConnectionStatePath("bind-unit-write-only"), "to=DEGRADED", token));
    assert.equal(response.status, 403);
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "VERIFIED");

    // WRITE is enough to clear the destination gate, so the page itself
    // renders - but canMutateConnectorConnectionState still withholds the
    // control, because EXECUTE/protected-action authority is missing.
    const connections = handler({ method: "GET", path: "/os/connections", headers: { [STAFF_SESSION_TOKEN_HEADER]: token } });
    assert.equal(connections.status, 200);
    assert.doesNotMatch(connections.body, /<form/i);
  });
});

test("C4 slice 2: an illegal transition (VERIFIED -> CONNECTED_UNVERIFIED) is 409, zero store change", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unit-illegal", "VERIFIED");
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store } };
    const handler = createInternalOsRequestHandler(deps);

    const response = handler(post(connectorConnectionStatePath("bind-unit-illegal"), "to=CONNECTED_UNVERIFIED"));
    assert.equal(response.status, 409);
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "VERIFIED");
  });
});

test("C4 slice 2: a nonexistent connectionBindingId is 403 (never 404 - see the route's own doc comment on why), nothing is created", () => {
  withStore((store) => {
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store } };
    const handler = createInternalOsRequestHandler(deps);

    const response = handler(post(connectorConnectionStatePath("bind-does-not-exist"), "to=DEGRADED"));
    assert.equal(response.status, 403);
    assert.ok(!response.body.includes("bind-does-not-exist"));
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, "bind-does-not-exist" as never), undefined);
  });
});

test("C4 slice 2: a malformed `to` value is a clean 400, zero store change", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unit-malformed", "VERIFIED");
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store } };
    const handler = createInternalOsRequestHandler(deps);

    for (const body of ["to=NOT_A_STATE", "to=", "", "to=DEGRADED&to=REVOKED"]) {
      const response = handler(post(connectorConnectionStatePath("bind-unit-malformed"), body));
      assert.equal(response.status, 400, body);
    }
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "VERIFIED");
  });
});

test("C4 slice 2: an unexpected store failure renders the generic OS ERROR page (500) and never the error's own message, connectionBindingId, or tenant id", () => {
  withStore((store) => {
    const secret = "SECRET-INTERNAL-DETAIL /var/data/tenant-file.json";
    const failingStore: DurableConnectorConnectionStore = {
      ...store,
      get: () => {
        throw new Error(secret);
      },
      save: (instance, expectedVersion) => store.save(instance, expectedVersion),
      list: (tenantId) => store.list(tenantId),
    };
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store: failingStore } };
    const handler = createInternalOsRequestHandler(deps);

    const response = handler(post(connectorConnectionStatePath("bind-unit-failure"), "to=DEGRADED"));
    assert.equal(response.status, 500);
    assert.ok(!response.body.includes("SECRET-INTERNAL-DETAIL"));
    assert.ok(!response.body.includes("/var/data"));
    assert.ok(!response.body.includes("bind-unit-failure"));
    assert.ok(!response.body.includes(REVIEW_ORGANIZATION.tenantId));
  });
});

test("C4 slice 2: a same-origin bypass attempt (foreign Origin) is 403 with zero store change, even with a valid staff session", () => {
  withStore((store) => {
    const bound = seedConnection(store, "bind-unit-csrf", "VERIFIED");
    const deps = { ...baseDeps(), connectionsSource: createDurableConnectionsSource(store), connectorConnectionStateDecision: { store } };
    const handler = createInternalOsRequestHandler(deps);

    const request: IncomingRequestLike = {
      method: "POST",
      path: connectorConnectionStatePath("bind-unit-csrf"),
      headers: {
        [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken,
        "content-type": FORM,
        origin: "https://attacker.example",
        host: "os.example",
      },
      body: "to=DEGRADED",
    };
    const response = handler(request);
    assert.equal(response.status, 403);
    assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "VERIFIED");
  });
});

test("C4 slice 2: the dev-only standalone internal OS server also wires and serves this route over a real socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c4s2-standalone-connections-"));
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const bound = seedConnection(store, "bind-standalone", "VERIFIED");
    const server = createInternalOsHttpServer({
      isProduction: false,
      devStaffFixtures: buildReviewStaffSessionFixtureMap(),
      organization: REVIEW_ORGANIZATION,
      grants: buildReviewStaffAccessGrants(),
      connectionsSource: createDurableConnectionsSource(store),
      connectorConnectionStateDecision: { store },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${connectorConnectionStatePath("bind-standalone")}`, {
        method: "POST",
        redirect: "manual",
        headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken, "content-type": FORM },
        body: "to=DEGRADED",
      });
      assert.equal(response.status, 303);
      assert.equal(store.get(REVIEW_ORGANIZATION.tenantId, bound.binding.connectionBindingId)?.instance.binding.connectionState, "DEGRADED");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- containment ---

test("C4 slice 2: internal-os-connection-state-controls.ts is one of exactly three src/web modules that render a <form> or <button> (the others are the offboarding controls module and the C4 slice 3 attention decision controls module)", () => {
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
});
