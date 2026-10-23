import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef, type ConnectionState } from "../src/domain/connection-authority.js";
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
import {
  FileDurableProtectedDecisionWaitStore,
  type StoredProtectedDecisionWait,
} from "../src/domain/durable-protected-decision-wait-store.js";
import type {
  ProtectedDecisionWaitRequest,
  ProtectedDecisionResumeAuthorization,
} from "../src/domain/protected-decision-wait-gate.js";
import type { TenantScope } from "../src/domain/tenant-scope.js";
import { createDurableAttentionSource } from "../src/web/attention-durable-source.js";
import {
  NAV_DESTINATIONS,
  isDestinationVisible,
  resolveAttentionView,
  type AttentionSource,
  type AttentionViewState,
} from "../src/web/internal-os-view-state.js";
import {
  renderInternalOsPage,
  attentionPageContent,
  notActiveDestinationPageContent,
} from "../src/web/internal-os-render.js";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { InternalOsAccessContext } from "../src/web/internal-os-access.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  buildReviewWorkProjectSource,
  buildReviewWorkJobSource,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
  RESTRICTED_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * C3 Attention slice (gap scan 2026-10-23): the dedicated `/os/attention`
 * destination, backed by `AttentionSource` / `createDurableAttentionSource`
 * over `FileDurableConnectorConnectionStore` (credential/access problem:
 * DEGRADED/REVOKED) and `FileDurableProtectedDecisionWaitStore.listByTenant`
 * (customer approval required: WAIT with no resume).
 */

const SECRET_REF_ID = "vault://c3a-secret-ref-MUST-NOT-RENDER";
const WAIT_REASON = "c3a-wait-reason-MUST-NOT-RENDER";
const FINGERPRINT = "c3a-fingerprint-MUST-NOT-RENDER";
const OWN_TENANT = REVIEW_ORGANIZATION.tenantId;

/** Builds a real connection instance, walked through the real transition graph to `state`. */
function connectionInState(tenantId: string, connectionBindingId: string, state: ConnectionState): ConnectorConnectionInstance {
  const ownership = createProjectOwnershipRef({ tenantId, customerId: "customer-c3a", projectId: "project-c3a" });
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
    purpose: "C3A test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
  let instance = requestConnectorConnection({
    requirement,
    connectorDescriptor: descriptor,
    connectionBindingId,
    workspaceRef: "workspace-c3a",
    integrationInstanceRef: "instance-c3a",
    delegatedScope: ["repo:read"],
    authMode: "OAUTH2",
    secretRef: createSecretRef({ secretRefId: SECRET_REF_ID }),
  });
  if (state === "REQUESTED") return instance;
  if (state === "REVOKED") return transitionConnectorConnection(instance, "REVOKED");
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  if (state === "CONNECTED_UNVERIFIED") return instance;
  instance = verifyConnectorConnection(instance, `evidence-${connectionBindingId}`);
  if (state === "VERIFIED") return instance;
  return transitionConnectorConnection(instance, state);
}

function stored(instance: ConnectorConnectionInstance, version = 1): StoredConnectorConnection {
  return { instance, version };
}

function waitRequest(
  tenantId: string,
  waitRequestId: string,
  overrides: Partial<Omit<ProtectedDecisionWaitRequest, "tenantId" | "waitRequestId">> = {},
): ProtectedDecisionWaitRequest {
  return {
    waitRequestId: waitRequestId as ProtectedDecisionWaitRequest["waitRequestId"],
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: "customer-c3a" as ProtectedDecisionWaitRequest["customerId"],
    projectId: "project-c3a" as ProtectedDecisionWaitRequest["projectId"],
    jobId: "plan-c3a:v1:req-1" as ProtectedDecisionWaitRequest["jobId"],
    runId: "run-c3a-internal",
    attempt: 7,
    effectRef: `effect:${waitRequestId}`,
    decisionRef: "decision:c3a-publish",
    reason: WAIT_REASON,
    activationFingerprintAtWait: FINGERPRINT,
    raisedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function resumeFor(request: ProtectedDecisionWaitRequest): ProtectedDecisionResumeAuthorization {
  return {
    waitRequestId: request.waitRequestId as unknown as ProtectedDecisionResumeAuthorization["waitRequestId"],
    effectRef: request.effectRef,
    resolvedAt: "2026-10-23T02:00:00.000Z",
    resolvedByPrincipalRef: "membership-c3a-approver",
    decisionRef: request.decisionRef,
    decisionEvidenceRef: "evidence:c3a-decision",
  };
}

function source(
  connections: ReadonlyArray<StoredConnectorConnection>,
  waits: ReadonlyArray<StoredProtectedDecisionWait>,
): AttentionSource {
  return { listConnections: () => connections, listProtectedDecisionWaits: () => waits };
}

function accessContext(permissions: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">, canPerformProtectedActions = false): InternalOsAccessContext {
  return {
    access: { decision: "GRANTED", permissions: new Set(permissions), canPerformProtectedActions },
  } as unknown as InternalOsAccessContext;
}

/** Founder-like: passes the destination gate (EXECUTE/protected) and holds WRITE. */
const WRITE_CONTEXT = accessContext(["READ", "WRITE", "EXECUTE"], true);

function resolve(src: AttentionSource | undefined, context: InternalOsAccessContext = WRITE_CONTEXT): AttentionViewState {
  return resolveAttentionView({ organization: REVIEW_ORGANIZATION, context, source: src });
}

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function connectorTenantFile(dir: string, tenantId: string): string {
  return join(dir, `${Buffer.from(tenantId, "utf8").toString("base64url")}.json`);
}

function waitTenantFile(dir: string, tenantId: string): string {
  return join(dir, `${Buffer.from(tenantId, "utf8").toString("base64url")}.wait.jsonl`);
}

async function withServer(
  deps: Parameters<typeof createInternalOsHttpServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createInternalOsHttpServer(deps);
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
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

/** Real stores in two fresh directories, cleaned up afterwards. */
function withStores(
  run: (stores: {
    connectionDir: string;
    waitDir: string;
    connections: FileDurableConnectorConnectionStore;
    waits: FileDurableProtectedDecisionWaitStore;
  }) => Promise<void> | void,
): Promise<void> {
  const connectionDir = freshDir("c3a-connections-");
  const waitDir = freshDir("c3a-waits-");
  const cleanup = (): void => {
    rmSync(connectionDir, { recursive: true, force: true });
    rmSync(waitDir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() =>
      run({
        connectionDir,
        waitDir,
        connections: new FileDurableConnectorConnectionStore(connectionDir),
        waits: new FileDurableProtectedDecisionWaitStore(waitDir),
      }),
    )
    .finally(cleanup);
}

function saveConnectionInState(store: FileDurableConnectorConnectionStore, tenantId: string, id: string, state: "DEGRADED" | "REVOKED" | "VERIFIED"): void {
  const base = connectionInState(tenantId, id, "REQUESTED");
  const created = store.save(base);
  if (state === "REVOKED") {
    store.save(transitionConnectorConnection(created.instance, "REVOKED"), created.version);
    return;
  }
  const connected = store.save(transitionConnectorConnection(created.instance, "CONNECTED_UNVERIFIED"), created.version);
  const verified = store.save(verifyConnectorConnection(connected.instance, `evidence-${id}`), connected.version);
  if (state === "DEGRADED") {
    store.save(transitionConnectorConnection(verified.instance, "DEGRADED"), verified.version);
  }
}

// --- resolveAttentionView: states ---

test("C3A-V1: resolveAttentionView with no source is NOT_ACTIVE", () => {
  assert.deepEqual(resolve(undefined), { kind: "NOT_ACTIVE" });
});

test("C3A-V2: both sources read successfully with nothing in either family is EMPTY - including healthy connections and already-resumed waits", () => {
  assert.deepEqual(resolve(source([], [])), { kind: "EMPTY" });
  const resumed = waitRequest(OWN_TENANT, "wait-c3a-v2");
  const view = resolve(
    source(
      [
        stored(connectionInState(OWN_TENANT, "bind-c3a-verified", "VERIFIED")),
        stored(connectionInState(OWN_TENANT, "bind-c3a-requested", "REQUESTED")),
        stored(connectionInState(OWN_TENANT, "bind-c3a-unverified", "CONNECTED_UNVERIFIED")),
        stored(connectionInState(OWN_TENANT, "bind-c3a-handover", "HANDOVER_COMPLETE")),
      ],
      [{ request: resumed, resume: resumeFor(resumed) }],
    ),
  );
  assert.deepEqual(view, { kind: "EMPTY" });
});

test("C3A-V3: a throwing CONNECTIONS source becomes ERROR and the exception does NOT escape resolveAttentionView", () => {
  let connectionCalls = 0;
  let waitCalls = 0;
  const throwing: AttentionSource = {
    listConnections: () => {
      connectionCalls += 1;
      throw new Error("connections disk on fire");
    },
    listProtectedDecisionWaits: () => {
      waitCalls += 1;
      return [{ request: waitRequest(OWN_TENANT, "wait-c3a-v3") }];
    },
  };
  let view: AttentionViewState | undefined;
  // Called directly, with no surrounding try/catch in the test: the
  // function itself must contain the failure.
  assert.doesNotThrow(() => {
    view = resolve(throwing);
  });
  assert.deepEqual(view, { kind: "ERROR" }, "a pending wait from the healthy source must not turn a failed read into READY");
  assert.equal(connectionCalls, 1, "the connections source was really invoked (and really threw)");
  assert.ok(waitCalls <= 1);
  const throwsString: AttentionSource = {
    listConnections: () => {
      throw "not even an Error";
    },
    listProtectedDecisionWaits: () => [],
  };
  assert.deepEqual(resolve(throwsString), { kind: "ERROR" });
});

test("C3A-V4: a throwing PROTECTED-DECISION-WAIT source becomes ERROR and the exception does NOT escape resolveAttentionView, even when connections read fine", () => {
  let waitCalls = 0;
  const throwing: AttentionSource = {
    listConnections: () => [stored(connectionInState(OWN_TENANT, "bind-c3a-v4", "DEGRADED"))],
    listProtectedDecisionWaits: () => {
      waitCalls += 1;
      throw new Error("wait log disk on fire");
    },
  };
  let view: AttentionViewState | undefined;
  assert.doesNotThrow(() => {
    view = resolve(throwing);
  });
  assert.deepEqual(view, { kind: "ERROR" }, "a DEGRADED connection from the healthy source must not turn a failed read into READY");
  assert.equal(waitCalls, 1, "the wait source was really invoked (and really threw)");
  const throwsString: AttentionSource = {
    listConnections: () => [],
    listProtectedDecisionWaits: () => {
      throw "not even an Error";
    },
  };
  assert.deepEqual(resolve(throwsString), { kind: "ERROR" });
});

test("C3A-V5: READY carries exactly the allow-listed fields - no secretRef, no wait reason/fingerprint/run/attempt, no tenantId", () => {
  const pending = waitRequest(OWN_TENANT, "wait-c3a-pending");
  const resumed = waitRequest(OWN_TENANT, "wait-c3a-resumed");
  const view = resolve(
    source(
      [
        stored(connectionInState(OWN_TENANT, "bind-c3a-degraded", "DEGRADED"), 4),
        stored(connectionInState(OWN_TENANT, "bind-c3a-verified", "VERIFIED"), 3),
      ],
      [{ request: pending }, { request: resumed, resume: resumeFor(resumed) }],
    ),
  );
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") return;
  assert.deepEqual(view.credentialAccessProblems, [
    {
      connectionBindingId: "bind-c3a-degraded",
      connectorKind: "GITHUB",
      connectionState: "DEGRADED",
      customerId: "customer-c3a",
      projectId: "project-c3a",
    },
  ]);
  assert.deepEqual(view.customerApprovalsRequired, [
    {
      waitRequestId: "wait-c3a-pending",
      customerId: "customer-c3a",
      projectId: "project-c3a",
      jobId: "plan-c3a:v1:req-1",
      decisionRef: "decision:c3a-publish",
      effectRef: "effect:wait-c3a-pending",
      raisedAt: "2026-10-23T00:00:00.000Z",
    },
  ]);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /MUST-NOT-RENDER|vault:|secretRef|tenantId|run-c3a-internal|"attempt"/);
  assert.doesNotMatch(serialized, /wait-c3a-resumed/, "a resumed wait is not waiting for approval");
});

test("C3A-V6: a serviceRef on the connection ownership is carried through; one family may be empty while the other is READY", () => {
  const instance = connectionInState(OWN_TENANT, "bind-c3a-svc", "REVOKED");
  const withService: ConnectorConnectionInstance = {
    ...instance,
    binding: { ...instance.binding, ownership: { ...instance.binding.ownership, serviceRef: "svc:website" } },
  };
  const view = resolve(source([stored(withService)], []));
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") return;
  assert.equal(view.credentialAccessProblems[0]!.serviceRef, "svc:website");
  assert.deepEqual(view.customerApprovalsRequired, []);
  const waitsOnly = resolve(source([], [{ request: waitRequest(OWN_TENANT, "wait-c3a-only") }]));
  assert.equal(waitsOnly.kind, "READY");
  if (waitsOnly.kind !== "READY") return;
  assert.deepEqual(waitsOnly.credentialAccessProblems, []);
  assert.equal(waitsOnly.customerApprovalsRequired.length, 1);
});

// --- tenant isolation, both sources ---

test("C3A-V7: a foreign tenant's CONNECTION fails closed to ERROR, not silently dropped - even a healthy (non-attention) foreign connection", () => {
  const own = stored(connectionInState(OWN_TENANT, "bind-c3a-own", "DEGRADED"));
  const foreignDegraded = stored(connectionInState("tenant-c3a-foreign", "bind-c3a-foreign", "DEGRADED"));
  const foreignVerified = stored(connectionInState("tenant-c3a-foreign", "bind-c3a-foreign-ok", "VERIFIED"));
  assert.deepEqual(resolve(source([own, foreignDegraded], [])), { kind: "ERROR" });
  assert.deepEqual(resolve(source([foreignDegraded], [])), { kind: "ERROR" });
  assert.deepEqual(resolve(source([foreignVerified], [])), { kind: "ERROR" }, "must not become EMPTY");
});

test("C3A-V8: a foreign tenant's WAIT fails closed to ERROR, not silently dropped - even an already-resumed foreign wait", () => {
  const own = { request: waitRequest(OWN_TENANT, "wait-c3a-own") };
  const foreignRequest = waitRequest("tenant-c3a-foreign", "wait-c3a-foreign");
  assert.deepEqual(resolve(source([], [own, { request: foreignRequest }])), { kind: "ERROR" });
  assert.deepEqual(resolve(source([], [{ request: foreignRequest }])), { kind: "ERROR" });
  assert.deepEqual(
    resolve(source([], [{ request: foreignRequest, resume: resumeFor(foreignRequest) }])),
    { kind: "ERROR" },
    "must not become EMPTY",
  );
});

test("C3A-V9: a resume whose waitRequestId does not match its own wait request fails closed to ERROR", () => {
  const request = waitRequest(OWN_TENANT, "wait-c3a-v9");
  const other = waitRequest(OWN_TENANT, "wait-c3a-v9-other");
  assert.deepEqual(resolve(source([], [{ request, resume: resumeFor(other) }])), { kind: "ERROR" });
});

test("C3A-V10: ordering - REVOKED before DEGRADED then by id; longest-waiting first then by id; the source's own arrays are not mutated", () => {
  const connections = [
    stored(connectionInState(OWN_TENANT, "bind-b-degraded", "DEGRADED")),
    stored(connectionInState(OWN_TENANT, "bind-z-revoked", "REVOKED")),
    stored(connectionInState(OWN_TENANT, "bind-a-degraded", "DEGRADED")),
    stored(connectionInState(OWN_TENANT, "bind-a-revoked", "REVOKED")),
  ];
  const waits = [
    { request: waitRequest(OWN_TENANT, "wait-new", { raisedAt: "2026-10-23T00:00:00.000Z" }) },
    { request: waitRequest(OWN_TENANT, "wait-old-b", { raisedAt: "2026-10-01T00:00:00.000Z" }) },
    { request: waitRequest(OWN_TENANT, "wait-old-a", { raisedAt: "2026-10-01T00:00:00.000Z" }) },
  ];
  const view = resolve(source(connections, waits));
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") return;
  assert.deepEqual(view.credentialAccessProblems.map((item) => item.connectionBindingId), [
    "bind-a-revoked",
    "bind-z-revoked",
    "bind-a-degraded",
    "bind-b-degraded",
  ]);
  assert.deepEqual(view.customerApprovalsRequired.map((item) => item.waitRequestId), ["wait-old-a", "wait-old-b", "wait-new"]);
  assert.deepEqual(connections.map((record) => record.instance.binding.connectionBindingId), [
    "bind-b-degraded",
    "bind-z-revoked",
    "bind-a-degraded",
    "bind-a-revoked",
  ]);
  assert.deepEqual(waits.map((wait) => wait.request.waitRequestId), ["wait-new", "wait-old-b", "wait-old-a"]);
});

// --- access ---

test("C3A-A1: the items require WRITE on top of the destination gate - EXECUTE/protected-actions without WRITE gets NOT_ACTIVE and neither source is read", () => {
  let reads = 0;
  const counting: AttentionSource = {
    listConnections: () => {
      reads += 1;
      return [stored(connectionInState(OWN_TENANT, "bind-c3a-a1", "REVOKED"))];
    },
    listProtectedDecisionWaits: () => {
      reads += 1;
      return [{ request: waitRequest(OWN_TENANT, "wait-c3a-a1") }];
    },
  };
  for (const context of [accessContext(["READ", "EXECUTE"]), accessContext(["READ"], true), accessContext(["EXECUTE"], true)]) {
    assert.equal(isDestinationVisible("attention", context), true, "precondition: the destination itself is reachable");
    assert.deepEqual(resolve(counting, context), { kind: "NOT_ACTIVE" });
  }
  assert.equal(reads, 0);
  assert.equal(resolve(counting, accessContext(["WRITE", "EXECUTE"])).kind, "READY");
  assert.equal(reads, 2);
});

test("C3A-A2: isDestinationVisible('attention') is still exactly the pre-C3 EXECUTE-or-protected-actions gate", () => {
  assert.equal(isDestinationVisible("attention", accessContext(["READ"])), false);
  assert.equal(isDestinationVisible("attention", accessContext(["READ", "WRITE"])), false);
  assert.equal(isDestinationVisible("attention", accessContext(["READ", "EXECUTE"])), true);
  assert.equal(isDestinationVisible("attention", accessContext(["READ"], true)), true);
  const denied = {
    access: { decision: "DENIED", permissions: new Set(["READ", "WRITE", "EXECUTE"]), canPerformProtectedActions: true },
  } as unknown as InternalOsAccessContext;
  assert.equal(isDestinationVisible("attention", denied), false);
});

// --- attentionPageContent ---

test("C3A-R1: attentionPageContent NOT_ACTIVE is byte-identical to the pre-C3 notActiveDestinationPageContent('attention') page", () => {
  const before = renderInternalOsPage(notActiveDestinationPageContent(NAV_DESTINATIONS, "Org", "attention"));
  const after = renderInternalOsPage(attentionPageContent(NAV_DESTINATIONS, "Org", { kind: "NOT_ACTIVE" }));
  assert.deepEqual(after, before);
});

test("C3A-R2: attentionPageContent ERROR renders the OS ERROR page (500) with no data and no 'nothing needs attention' text", () => {
  const rendered = renderInternalOsPage(attentionPageContent(NAV_DESTINATIONS, "Org", { kind: "ERROR" }));
  assert.equal(rendered.status, 500);
  assert.match(rendered.html, /Something went wrong/);
  assert.doesNotMatch(rendered.html, /No connection has a credential/);
  assert.doesNotMatch(rendered.html, /no protected decision is waiting/i);
});

test("C3A-R3: attentionPageContent EMPTY says neither family has an item, states which families the page covers, and is not the NOT ACTIVE card", () => {
  const rendered = renderInternalOsPage(attentionPageContent(NAV_DESTINATIONS, "Org", { kind: "EMPTY" }));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /No connection has a credential or access problem, and no protected decision is waiting for approval/);
  assert.match(rendered.html, /Other kinds of attention are not tracked here yet/);
  assert.doesNotMatch(rendered.html, /NOT ACTIVE/);
  assert.match(rendered.html, /aria-current="page">Attention</);
});

test("C3A-R4: attentionPageContent READY renders every field of both families HTML-escaped, with no mutation control", () => {
  const view: AttentionViewState = {
    kind: "READY",
    credentialAccessProblems: [
      {
        connectionBindingId: "bind-<script>",
        connectorKind: "KIND-\"q\"",
        connectionState: "REVOKED",
        customerId: "cust-'r4'",
        projectId: "proj-r4&co",
        serviceRef: "svc-<b>",
      },
      { connectionBindingId: "bind-r4-degraded", connectorKind: "GITHUB", connectionState: "DEGRADED", customerId: "c", projectId: "p" },
    ],
    customerApprovalsRequired: [
      {
        waitRequestId: "wait-<i>",
        customerId: "wcust-&",
        projectId: "wproj-\"",
        jobId: "job-<j>",
        decisionRef: "decision-<d>",
        effectRef: "effect-'e'",
        raisedAt: "2026-10-23T<01>",
      },
    ],
  };
  const rendered = renderInternalOsPage(attentionPageContent(NAV_DESTINATIONS, "Org", view));
  const html = rendered.html;
  assert.equal(rendered.status, 200);
  assert.match(html, /bind-&lt;script&gt;/);
  assert.doesNotMatch(html, /bind-<script>/);
  assert.match(html, /KIND-&quot;q&quot;/);
  assert.match(html, /cust-&#39;r4&#39; \/ proj-r4&amp;co \/ svc-&lt;b&gt;/);
  assert.match(html, /<span class="status status-danger" role="status">REVOKED<\/span>/);
  assert.match(html, /<span class="status status-warning" role="status">DEGRADED<\/span>/);
  assert.match(html, /wait-&lt;i&gt;/);
  assert.match(html, /wcust-&amp; \/ wproj-&quot;/);
  assert.match(html, /job-&lt;j&gt;/);
  assert.match(html, /decision-&lt;d&gt;/);
  assert.match(html, /effect-&#39;e&#39;/);
  assert.match(html, /2026-10-23T&lt;01&gt;/);
  for (const raw of ["<i>", "<j>", "<d>", "<b>", "<01>", "'e'", "'r4'"]) {
    assert.equal(html.includes(raw), false, raw);
  }
  assert.match(html, /Credential or access problem/);
  assert.match(html, /Customer approval required/);
  assert.match(html, /Waiting since/);
  assert.match(html, /No state-change time is recorded for connections/);
  assert.doesNotMatch(html, /<button/i);
  assert.doesNotMatch(html, /<form/i);
});

test("C3A-R5: READY with one empty family says so for that family instead of rendering an empty table", () => {
  const rendered = renderInternalOsPage(
    attentionPageContent(NAV_DESTINATIONS, "Org", {
      kind: "READY",
      credentialAccessProblems: [],
      customerApprovalsRequired: [
        { waitRequestId: "w", customerId: "c", projectId: "p", jobId: "j", decisionRef: "d", effectRef: "e", raisedAt: "t" },
      ],
    }),
  );
  assert.match(rendered.html, /<p>No connection has a credential or access problem.<\/p>/);
  assert.doesNotMatch(rendered.html, /No protected decision is waiting for approval/);
});

// --- createDurableAttentionSource over the real stores ---

test("C3A-S1: createDurableAttentionSource returns this tenant's records from both real stores, and nothing from another tenant", async () => {
  await withStores(({ connections, waits }) => {
    saveConnectionInState(connections, OWN_TENANT, "bind-c3a-s1", "DEGRADED");
    saveConnectionInState(connections, "tenant-c3a-other", "bind-c3a-other", "REVOKED");
    waits.putIfAbsentWaitRequest(OWN_TENANT, "wait-c3a-s1", waitRequest(OWN_TENANT, "wait-c3a-s1"));
    const otherTenant = "tenant-c3a-other" as TenantScope["tenantId"];
    waits.putIfAbsentWaitRequest(otherTenant, "wait-c3a-other", waitRequest(otherTenant, "wait-c3a-other"));
    const src = createDurableAttentionSource(connections, waits);
    assert.deepEqual(src.listConnections(REVIEW_ORGANIZATION).map((record) => record.instance.binding.connectionBindingId), ["bind-c3a-s1"]);
    assert.deepEqual(src.listProtectedDecisionWaits(REVIEW_ORGANIZATION).map((wait) => wait.request.waitRequestId), ["wait-c3a-s1"]);
    const view = resolve(src);
    assert.equal(view.kind, "READY");
  });
});

test("C3A-S2: a corrupted CONNECTION tenant file propagates as a throw from the source (never an empty list), and resolveAttentionView contains it as ERROR", async () => {
  await withStores(({ connectionDir, connections, waits }) => {
    waits.putIfAbsentWaitRequest(OWN_TENANT, "wait-c3a-s2", waitRequest(OWN_TENANT, "wait-c3a-s2"));
    writeFileSync(connectorTenantFile(connectionDir, OWN_TENANT), "{ not json", "utf8");
    const src = createDurableAttentionSource(connections, waits);
    assert.throws(() => src.listConnections(REVIEW_ORGANIZATION));
    let view: AttentionViewState | undefined;
    assert.doesNotThrow(() => {
      view = resolve(src);
    });
    assert.deepEqual(view, { kind: "ERROR" });
  });
});

test("C3A-S3: a corrupted WAIT log propagates as a throw from the source (never an empty list), and resolveAttentionView contains it as ERROR", async () => {
  await withStores(({ waitDir, connections, waits }) => {
    saveConnectionInState(connections, OWN_TENANT, "bind-c3a-s3", "DEGRADED");
    writeFileSync(waitTenantFile(waitDir, OWN_TENANT), "{ not json\n", "utf8");
    const src = createDurableAttentionSource(connections, waits);
    assert.throws(() => src.listProtectedDecisionWaits(REVIEW_ORGANIZATION), { name: "CorruptedProtectedDecisionWaitLineError" });
    let view: AttentionViewState | undefined;
    assert.doesNotThrow(() => {
      view = resolve(src);
    });
    assert.deepEqual(view, { kind: "ERROR" });
  });
});

// --- the real /os/attention route ---

test("C3A-H1: /os/attention with no attentionSource wired renders exactly the pre-C3 NOT_ACTIVE page", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/attention`, { headers: founderHeaders });
    assert.equal(response.status, 200);
    const body = await response.text();
    const expected = renderInternalOsPage(
      notActiveDestinationPageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, "attention"),
    );
    assert.equal(body, expected.html);
  });
});

test("C3A-H2: /os/attention with a durable source renders both families through the real route; secretRef, wait reason and fingerprint never appear", async () => {
  await withStores(async ({ connections, waits }) => {
    saveConnectionInState(connections, OWN_TENANT, "bind-c3a-h2-degraded", "DEGRADED");
    saveConnectionInState(connections, OWN_TENANT, "bind-c3a-h2-revoked", "REVOKED");
    saveConnectionInState(connections, OWN_TENANT, "bind-c3a-h2-verified", "VERIFIED");
    waits.putIfAbsentWaitRequest(OWN_TENANT, "wait-c3a-h2-pending", waitRequest(OWN_TENANT, "wait-c3a-h2-pending"));
    const resumed = waitRequest(OWN_TENANT, "wait-c3a-h2-resumed");
    waits.putIfAbsentWaitRequest(OWN_TENANT, "wait-c3a-h2-resumed", resumed);
    waits.claimResume(OWN_TENANT, "wait-c3a-h2-resumed", resumeFor(resumed));
    await withServer({ ...devDeps, attentionSource: createDurableAttentionSource(connections, waits) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/attention`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /bind-c3a-h2-degraded/);
      assert.match(body, /bind-c3a-h2-revoked/);
      assert.doesNotMatch(body, /bind-c3a-h2-verified/);
      assert.match(body, /wait-c3a-h2-pending/);
      assert.doesNotMatch(body, /wait-c3a-h2-resumed/);
      assert.match(body, /decision:c3a-publish/);
      assert.match(body, /customer-c3a \/ project-c3a/);
      assert.doesNotMatch(body, /NOT ACTIVE/);
      assert.doesNotMatch(body, /MUST-NOT-RENDER|vault:/);
      assert.doesNotMatch(body, /<button/i);
      assert.doesNotMatch(body, /<form/i);
    });
  });
});

test("C3A-H3: /os/attention with durable sources and nothing to show renders EMPTY, not NOT_ACTIVE", async () => {
  await withStores(async ({ connections, waits }) => {
    saveConnectionInState(connections, OWN_TENANT, "bind-c3a-h3", "VERIFIED");
    await withServer({ ...devDeps, attentionSource: createDurableAttentionSource(connections, waits) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/attention`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /No connection has a credential or access problem, and no protected decision is waiting for approval/);
      assert.doesNotMatch(body, /NOT ACTIVE/);
    });
  });
});

test("C3A-H4: a corrupted file in EITHER store renders the themed OS ERROR page (500), not EMPTY, and the server keeps serving", async () => {
  for (const corrupt of ["connections", "waits"] as const) {
    await withStores(async ({ connectionDir, waitDir, connections, waits }) => {
      if (corrupt === "connections") {
        writeFileSync(connectorTenantFile(connectionDir, OWN_TENANT), "[]", "utf8");
      } else {
        writeFileSync(waitTenantFile(waitDir, OWN_TENANT), "[]\n", "utf8");
      }
      await withServer({ ...devDeps, attentionSource: createDurableAttentionSource(connections, waits) }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/os/attention`, { headers: founderHeaders });
        assert.equal(response.status, 500, corrupt);
        const body = await response.text();
        assert.match(body, /AKILTA OS/);
        assert.match(body, /Something went wrong/);
        assert.doesNotMatch(body, /No connection has a credential/);
        assert.doesNotMatch(body, /Corrupted|JSON object/);
        assert.equal((await fetch(`${baseUrl}/os/home`, { headers: founderHeaders })).status, 200);
      });
    });
  }
});

test("C3A-H5: access stays fail-closed before either source is read - unauthenticated is 401, and READ-only Member and Restricted are 403, with zero source reads", async () => {
  let reads = 0;
  const counting: AttentionSource = {
    listConnections: () => {
      reads += 1;
      return [stored(connectionInState(OWN_TENANT, "bind-c3a-h5", "REVOKED"))];
    },
    listProtectedDecisionWaits: () => {
      reads += 1;
      return [{ request: waitRequest(OWN_TENANT, "wait-c3a-h5") }];
    },
  };
  await withServer({ ...devDeps, attentionSource: counting }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/os/attention`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /bind-c3a-h5|wait-c3a-h5/);
    for (const fixture of [MEMBER_REVIEW_FIXTURE, RESTRICTED_REVIEW_FIXTURE]) {
      const response = await fetch(`${baseUrl}/os/attention`, {
        headers: { [STAFF_SESSION_TOKEN_HEADER]: fixture.sessionToken },
      });
      assert.equal(response.status, 403, fixture.sessionToken);
      assert.doesNotMatch(await response.text(), /bind-c3a-h5|wait-c3a-h5/);
    }
    assert.equal(reads, 0);
    const founder = await fetch(`${baseUrl}/os/attention`, { headers: founderHeaders });
    assert.equal(founder.status, 200);
    const body = await founder.text();
    assert.match(body, /bind-c3a-h5/);
    assert.match(body, /wait-c3a-h5/);
    assert.equal(reads, 2);
  });
});

test("C3A-H6: wiring attentionSource changes only /os/attention - ai-capabilities still renders NOT_ACTIVE and no other destination reads it", async () => {
  let reads = 0;
  const counting: AttentionSource = {
    listConnections: () => {
      reads += 1;
      return [stored(connectionInState(OWN_TENANT, "bind-c3a-h6", "REVOKED"))];
    },
    listProtectedDecisionWaits: () => {
      reads += 1;
      return [{ request: waitRequest(OWN_TENANT, "wait-c3a-h6") }];
    },
  };
  await withServer({ ...devDeps, attentionSource: counting }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/ai-capabilities`, { headers: founderHeaders });
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      renderInternalOsPage(notActiveDestinationPageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, "ai-capabilities")).html,
    );
    for (const path of ["/os/home", "/os/work", "/os/connections", "/os/knowledge", "/os/people", "/os/products", "/os/admin"]) {
      const page = await fetch(`${baseUrl}${path}`, { headers: founderHeaders });
      assert.equal(page.status, 200, path);
      assert.doesNotMatch(await page.text(), /bind-c3a-h6|wait-c3a-h6/, path);
    }
    assert.equal(reads, 0);
  });
});
