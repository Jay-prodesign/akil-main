import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  verifyConnectorConnection,
  type ConnectorConnectionInstance,
} from "../src/domain/integration-connector-catalog.js";
import {
  FileDurableConnectorConnectionStore,
  type StoredConnectorConnection,
} from "../src/domain/durable-connector-connection-store.js";
import type { TenantScope } from "../src/domain/tenant-scope.js";
import { createDurableConnectionsSource } from "../src/web/connections-durable-source.js";
import {
  NAV_DESTINATIONS,
  resolveConnectionsView,
  type ConnectionsSource,
  type ConnectionsViewState,
} from "../src/web/internal-os-view-state.js";
import {
  renderInternalOsPage,
  connectionsPageContent,
  notActiveDestinationPageContent,
} from "../src/web/internal-os-render.js";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  buildReviewWorkProjectSource,
  buildReviewWorkJobSource,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * C3 (gap scan 2026-10-23): the dedicated `/os/connections` destination,
 * backed by `ConnectionsSource` / `createDurableConnectionsSource` over
 * `FileDurableConnectorConnectionStore`, with secrets masked through
 * CONN-001's `buildIntegrationsAdminView`.
 */

const SECRET_REF_ID = "vault://c3-secret-ref-MUST-NOT-RENDER";

function connectionFor(tenantId: string, connectionBindingId: string, withSecret: boolean): ConnectorConnectionInstance {
  const ownership = createProjectOwnershipRef({
    tenantId,
    customerId: "customer-c3",
    projectId: "project-c3",
  });
  const descriptor = createConnectorDescriptor({
    connectorKind: "GITHUB",
    displayName: "GitHub",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:repo-access"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${connectionBindingId}`,
    ownership,
    requiredCapabilityRef: "cap:repo-access",
    purpose: "C3 test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  return requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-c3",
    integrationInstanceRef: "instance-c3",
    delegatedScope: ["repo:read"],
    authMode: "OAUTH2",
    ...(withSecret ? { secretRef: createSecretRef({ secretRefId: SECRET_REF_ID }) } : {}),
  });
}

function stored(instance: ConnectorConnectionInstance, version = 1): StoredConnectorConnection {
  return { instance, version };
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "c3-connections-"));
}

function tenantFilePath(dir: string, tenantId: string): string {
  return join(dir, `${Buffer.from(tenantId, "utf8").toString("base64url")}.json`);
}

async function withServer(
  deps: Parameters<typeof createInternalOsHttpServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createInternalOsHttpServer(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const devDeps = {
  isProduction: false as const,
  devStaffFixtures: buildReviewStaffSessionFixtureMap(),
  organization: REVIEW_ORGANIZATION,
  grants: buildReviewStaffAccessGrants(),
  projectSource: buildReviewWorkProjectSource(),
  jobSource: buildReviewWorkJobSource(),
};

const founderHeaders = { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken };

// --- resolveConnectionsView ---

test("C3-V1: resolveConnectionsView with no source is NOT_ACTIVE", () => {
  assert.deepEqual(resolveConnectionsView(REVIEW_ORGANIZATION, undefined), { kind: "NOT_ACTIVE" });
});

test("C3-V2: resolveConnectionsView with a source that returns no records is EMPTY, distinct from NOT_ACTIVE", () => {
  const source: ConnectionsSource = { listConnections: () => [] };
  assert.deepEqual(resolveConnectionsView(REVIEW_ORGANIZATION, source), { kind: "EMPTY" });
});

test("C3-V3: resolveConnectionsView with a throwing source is ERROR - a read failure is never relabeled as EMPTY", () => {
  const source: ConnectionsSource = {
    listConnections: () => {
      throw new Error("disk on fire");
    },
  };
  assert.deepEqual(resolveConnectionsView(REVIEW_ORGANIZATION, source), { kind: "ERROR" });
});

test("C3-V4: resolveConnectionsView READY carries the masked summary - no secretRef anywhere in the view", () => {
  const record = stored(connectionFor(REVIEW_ORGANIZATION.tenantId, "bind-c3-v4", true), 3);
  assert.equal(record.instance.binding.secretRef, SECRET_REF_ID, "precondition: the stored record really holds a secretRef");
  const view = resolveConnectionsView(REVIEW_ORGANIZATION, { listConnections: () => [record] });
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") return;
  assert.equal(view.connections.length, 1);
  const summary = view.connections[0]!;
  assert.equal(summary.connectionBindingId, "bind-c3-v4");
  assert.equal(summary.connectorKind, "GITHUB");
  assert.equal(summary.connectionState, "REQUESTED");
  assert.equal(summary.version, 3);
  assert.equal("secretRef" in summary, false);
  assert.doesNotMatch(JSON.stringify(view), /c3-secret-ref|secretRef/);
});

test("C3-V5: resolveConnectionsView fails closed to ERROR (not a silently filtered list) when the source returns a foreign tenant's record", () => {
  const own = stored(connectionFor(REVIEW_ORGANIZATION.tenantId, "bind-c3-own", false));
  const foreign = stored(connectionFor("tenant-c3-foreign", "bind-c3-foreign", false));
  assert.deepEqual(resolveConnectionsView(REVIEW_ORGANIZATION, { listConnections: () => [own, foreign] }), { kind: "ERROR" });
  // Only-foreign must not become EMPTY either.
  assert.deepEqual(resolveConnectionsView(REVIEW_ORGANIZATION, { listConnections: () => [foreign] }), { kind: "ERROR" });
});

// --- connectionsPageContent ---

test("C3-R1: connectionsPageContent NOT_ACTIVE is byte-identical to the pre-C3 notActiveDestinationPageContent('connections') page", () => {
  const before = renderInternalOsPage(notActiveDestinationPageContent(NAV_DESTINATIONS, "Org", "connections"));
  const after = renderInternalOsPage(connectionsPageContent(NAV_DESTINATIONS, "Org", { kind: "NOT_ACTIVE" }));
  assert.deepEqual(after, before);
});

test("C3-R2: connectionsPageContent ERROR renders the OS ERROR page (500) with no data", () => {
  const rendered = renderInternalOsPage(connectionsPageContent(NAV_DESTINATIONS, "Org", { kind: "ERROR" }));
  assert.equal(rendered.status, 500);
  assert.match(rendered.html, /Something went wrong/);
  assert.doesNotMatch(rendered.html, /No connections/);
});

test("C3-R3: connectionsPageContent EMPTY says no connections are configured, and is not the NOT ACTIVE card", () => {
  const rendered = renderInternalOsPage(connectionsPageContent(NAV_DESTINATIONS, "Org", { kind: "EMPTY" }));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /No connections are configured for this organization yet/);
  assert.doesNotMatch(rendered.html, /NOT ACTIVE/);
});

test("C3-R4: connectionsPageContent READY renders every masked field HTML-escaped, with a visible state label and no mutation control", () => {
  const view: ConnectionsViewState = {
    kind: "READY",
    connections: [
      {
        connectionBindingId: "bind-<script>" as never,
        connectorKind: "OPENAI",
        authMode: "API_KEY",
        connectionState: "REVOKED",
        ownership: { tenantId: "t" as TenantScope["tenantId"], customerId: "cust-r4" as never, projectId: "proj-r4" as never, serviceRef: "svc-r4" },
        workspaceRef: "ws-\"quoted\"",
        integrationInstanceRef: "inst-r4",
        version: 2,
        verificationEvidenceRef: "evidence-r4",
      },
    ],
  };
  const rendered = renderInternalOsPage(connectionsPageContent(NAV_DESTINATIONS, "Org", view));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /bind-&lt;script&gt;/);
  assert.doesNotMatch(rendered.html, /bind-<script>/);
  assert.match(rendered.html, /ws-&quot;quoted&quot;/);
  assert.match(rendered.html, /OPENAI/);
  assert.match(rendered.html, /API_KEY/);
  assert.match(rendered.html, /<span class="status status-danger" role="status">REVOKED<\/span>/);
  assert.match(rendered.html, /cust-r4 \/ proj-r4 \/ svc-r4/);
  assert.match(rendered.html, /evidence-r4/);
  assert.match(rendered.html, /aria-current="page">Connections</);
  assert.doesNotMatch(rendered.html, /<button/i);
  assert.doesNotMatch(rendered.html, /<form/i);
});

// --- createDurableConnectionsSource over the real store ---

test("C3-S1: createDurableConnectionsSource returns the tenant's stored connections from the real FileDurableConnectorConnectionStore, and nothing from another tenant", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    store.save(connectionFor(REVIEW_ORGANIZATION.tenantId, "bind-c3-s1", true));
    store.save(connectionFor("tenant-c3-other", "bind-c3-other", false));
    const listed = createDurableConnectionsSource(store).listConnections(REVIEW_ORGANIZATION);
    assert.deepEqual(
      listed.map((record) => record.instance.binding.connectionBindingId),
      ["bind-c3-s1"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3-S2: createDurableConnectionsSource propagates a corrupted tenant file as a throw (never an empty list)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    writeFileSync(tenantFilePath(dir, REVIEW_ORGANIZATION.tenantId), "{ not json", "utf8");
    const source = createDurableConnectionsSource(store);
    assert.throws(() => source.listConnections(REVIEW_ORGANIZATION), { name: "CorruptedConnectorConnectionFileError" });
    assert.deepEqual(resolveConnectionsView(REVIEW_ORGANIZATION, source), { kind: "ERROR" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the real /os/connections route ---

test("C3-H1: /os/connections with no connectionsSource wired renders exactly the pre-C3 NOT_ACTIVE page", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/connections`, { headers: founderHeaders });
    assert.equal(response.status, 200);
    const body = await response.text();
    // The founder fixture sees every destination, so its nav is NAV_DESTINATIONS.
    const expected = renderInternalOsPage(
      notActiveDestinationPageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, "connections"),
    );
    assert.equal(body, expected.html);
    assert.match(body, /NOT ACTIVE/);
  });
});

test("C3-H2: /os/connections with a durable source renders real connections through the real route, and the stored secretRef never appears in the HTML", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const created = store.save(connectionFor(REVIEW_ORGANIZATION.tenantId, "bind-c3-h2", true));
    const connected = store.save(transitionConnectorConnection(created.instance, "CONNECTED_UNVERIFIED"), created.version);
    const verified = store.save(verifyConnectorConnection(connected.instance, "evidence-c3-h2"), connected.version);
    store.save(transitionConnectorConnection(verified.instance, "DEGRADED"), verified.version);
    await withServer({ ...devDeps, connectionsSource: createDurableConnectionsSource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/connections`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /bind-c3-h2/);
      assert.match(body, /GITHUB/);
      assert.match(body, /OAUTH2/);
      assert.match(body, /<span class="status status-warning" role="status">DEGRADED<\/span>/);
      assert.match(body, /customer-c3 \/ project-c3/);
      assert.match(body, /workspace-c3/);
      assert.doesNotMatch(body, /NOT ACTIVE/);
      assert.doesNotMatch(body, /c3-secret-ref|MUST-NOT-RENDER|vault:\/\//);
      assert.doesNotMatch(body, /<button/i);
      assert.doesNotMatch(body, /<form/i);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3-H3: /os/connections with a durable source and no stored connections renders EMPTY, not NOT_ACTIVE", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    await withServer({ ...devDeps, connectionsSource: createDurableConnectionsSource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/connections`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /No connections are configured for this organization yet/);
      assert.doesNotMatch(body, /NOT ACTIVE/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3-H4: /os/connections over a corrupted store file renders the OS ERROR page (500), not EMPTY, and the server keeps serving", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    writeFileSync(tenantFilePath(dir, REVIEW_ORGANIZATION.tenantId), "[]", "utf8");
    await withServer({ ...devDeps, connectionsSource: createDurableConnectionsSource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/connections`, { headers: founderHeaders });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No connections are configured/);
      assert.doesNotMatch(body, /Corrupted|JSON object/);
      const home = await fetch(`${baseUrl}/os/home`, { headers: founderHeaders });
      assert.equal(home.status, 200);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3-H5: access stays fail-closed before the source is ever read - unauthenticated is 401 and a Member (no WRITE) is 403, with zero source reads", async () => {
  let reads = 0;
  const source: ConnectionsSource = {
    listConnections: () => {
      reads += 1;
      return [stored(connectionFor(REVIEW_ORGANIZATION.tenantId, "bind-c3-h5", false))];
    },
  };
  await withServer({ ...devDeps, connectionsSource: source }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/os/connections`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /bind-c3-h5/);
    const member = await fetch(`${baseUrl}/os/connections`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(member.status, 403);
    assert.doesNotMatch(await member.text(), /bind-c3-h5/);
    assert.equal(reads, 0);
  });
});

test("C3-H6: wiring connectionsSource changes only /os/connections - attention, ai-capabilities and knowledge still render NOT_ACTIVE", async () => {
  const source: ConnectionsSource = {
    listConnections: () => [stored(connectionFor(REVIEW_ORGANIZATION.tenantId, "bind-c3-h6", false))],
  };
  await withServer({ ...devDeps, connectionsSource: source }, async (baseUrl) => {
    for (const key of ["attention", "ai-capabilities", "knowledge"] as const) {
      const response = await fetch(`${baseUrl}/os/${key}`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      const expected = renderInternalOsPage(
        notActiveDestinationPageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, key),
      );
      assert.equal(body, expected.html);
      assert.doesNotMatch(body, /bind-c3-h6/);
    }
  });
});
