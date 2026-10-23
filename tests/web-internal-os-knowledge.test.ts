import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { EvidenceReference } from "../src/domain/evidence.js";
import { FileDurableEvidenceReferenceStore } from "../src/domain/durable-evidence-reference-store.js";
import { createDurableKnowledgeSource } from "../src/web/knowledge-durable-source.js";
import {
  NAV_DESTINATIONS,
  isDestinationVisible,
  resolveKnowledgeView,
  type KnowledgeSource,
  type KnowledgeViewState,
} from "../src/web/internal-os-view-state.js";
import {
  renderInternalOsPage,
  knowledgePageContent,
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
 * C3 Knowledge slice (gap scan 2026-10-23): the dedicated `/os/knowledge`
 * destination, backed by `KnowledgeSource` / `createDurableKnowledgeSource`
 * over `FileDurableEvidenceReferenceStore`, with an explicit field
 * allow-list that leaves out `sourceLocator`.
 */

const SOURCE_LOCATOR = "https://storage.example/bucket/object?signature=c3k-locator-MUST-NOT-RENDER";

function evidence(
  tenantId: string,
  evidenceId: string,
  overrides: Partial<Omit<EvidenceReference, "evidenceId" | "tenantId">> = {},
): EvidenceReference {
  return {
    evidenceId: evidenceId as EvidenceReference["evidenceId"],
    tenantId: tenantId as EvidenceReference["tenantId"],
    customerId: "customer-c3k" as EvidenceReference["customerId"],
    projectId: "project-c3k" as EvidenceReference["projectId"],
    jobId: "plan-c3k:v1:req-1" as EvidenceReference["jobId"],
    evidenceType: "DISCOVERY_NOTE",
    sourceLocator: SOURCE_LOCATOR,
    capturedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "c3-knowledge-"));
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

// --- resolveKnowledgeView ---

test("C3K-V1: resolveKnowledgeView with no source is NOT_ACTIVE", () => {
  assert.deepEqual(resolveKnowledgeView(REVIEW_ORGANIZATION, undefined), { kind: "NOT_ACTIVE" });
});

test("C3K-V2: resolveKnowledgeView with a source that returns no records is EMPTY, distinct from NOT_ACTIVE", () => {
  const source: KnowledgeSource = { listEvidenceReferences: () => [] };
  assert.deepEqual(resolveKnowledgeView(REVIEW_ORGANIZATION, source), { kind: "EMPTY" });
});

test("C3K-V3: a throwing source becomes ERROR and the exception does NOT escape resolveKnowledgeView", () => {
  let calls = 0;
  const source: KnowledgeSource = {
    listEvidenceReferences: () => {
      calls += 1;
      throw new Error("disk on fire");
    },
  };
  let view: KnowledgeViewState | undefined;
  // Called directly, with no surrounding try/catch in the test: the
  // function itself must contain the failure.
  assert.doesNotThrow(() => {
    view = resolveKnowledgeView(REVIEW_ORGANIZATION, source);
  });
  assert.deepEqual(view, { kind: "ERROR" });
  assert.equal(calls, 1, "the source was really invoked (and really threw)");
  // A non-Error throw value is contained too.
  const throwsString: KnowledgeSource = {
    listEvidenceReferences: () => {
      throw "not even an Error";
    },
  };
  assert.deepEqual(resolveKnowledgeView(REVIEW_ORGANIZATION, throwsString), { kind: "ERROR" });
});

test("C3K-V4: resolveKnowledgeView READY carries only the allow-listed fields - sourceLocator and tenantId never reach the view", () => {
  const record = evidence(REVIEW_ORGANIZATION.tenantId, "ev-c3k-v4");
  const view = resolveKnowledgeView(REVIEW_ORGANIZATION, { listEvidenceReferences: () => [record] });
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") return;
  assert.deepEqual(view.evidence, [
    {
      evidenceId: "ev-c3k-v4",
      evidenceType: "DISCOVERY_NOTE",
      customerId: "customer-c3k",
      projectId: "project-c3k",
      jobId: "plan-c3k:v1:req-1",
      capturedAt: "2026-10-23T00:00:00.000Z",
    },
  ]);
  assert.equal("sourceLocator" in view.evidence[0]!, false);
  assert.equal("tenantId" in view.evidence[0]!, false);
  assert.doesNotMatch(JSON.stringify(view), /MUST-NOT-RENDER|signature=|sourceLocator/);
});

test("C3K-V5: resolveKnowledgeView fails closed to ERROR (not a silently filtered list) when the source returns a foreign tenant's record", () => {
  const own = evidence(REVIEW_ORGANIZATION.tenantId, "ev-c3k-own");
  const foreign = evidence("tenant-c3k-foreign", "ev-c3k-foreign");
  assert.deepEqual(resolveKnowledgeView(REVIEW_ORGANIZATION, { listEvidenceReferences: () => [own, foreign] }), { kind: "ERROR" });
  // Only-foreign must not become EMPTY either.
  assert.deepEqual(resolveKnowledgeView(REVIEW_ORGANIZATION, { listEvidenceReferences: () => [foreign] }), { kind: "ERROR" });
});

test("C3K-V6: resolveKnowledgeView orders most recently captured first, then by evidenceId, independent of source order", () => {
  const tenant = REVIEW_ORGANIZATION.tenantId;
  const records = [
    evidence(tenant, "ev-b", { capturedAt: "2026-10-01T00:00:00.000Z" }),
    evidence(tenant, "ev-z", { capturedAt: "2026-10-20T00:00:00.000Z" }),
    evidence(tenant, "ev-a", { capturedAt: "2026-10-01T00:00:00.000Z" }),
  ];
  const view = resolveKnowledgeView(REVIEW_ORGANIZATION, { listEvidenceReferences: () => records });
  assert.equal(view.kind, "READY");
  if (view.kind !== "READY") return;
  assert.deepEqual(view.evidence.map((entry) => entry.evidenceId), ["ev-z", "ev-a", "ev-b"]);
  assert.deepEqual(records.map((record) => record.evidenceId), ["ev-b", "ev-z", "ev-a"], "the source's own array is not mutated");
});

// --- access control is unchanged ---

test("C3K-A1: isDestinationVisible('knowledge') is still exactly the pre-C3 WRITE gate - READ-only is hidden, WRITE is visible, EXECUTE/protected-actions alone does not unlock it", () => {
  const base = {} as Omit<InternalOsAccessContext, "access">;
  const context = (permissions: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">, canPerformProtectedActions = false): InternalOsAccessContext =>
    ({
      ...base,
      access: { decision: "GRANTED", permissions: new Set(permissions), canPerformProtectedActions },
    }) as unknown as InternalOsAccessContext;
  assert.equal(isDestinationVisible("knowledge", context(["READ"])), false);
  assert.equal(isDestinationVisible("knowledge", context(["READ", "EXECUTE"], true)), false);
  assert.equal(isDestinationVisible("knowledge", context(["READ", "WRITE"])), true);
  assert.equal(isDestinationVisible("knowledge", context(["WRITE"])), true);
  const denied = {
    ...base,
    access: { decision: "DENIED", permissions: new Set(["READ", "WRITE"]), canPerformProtectedActions: true },
  } as unknown as InternalOsAccessContext;
  assert.equal(isDestinationVisible("knowledge", denied), false);
});

// --- knowledgePageContent ---

test("C3K-R1: knowledgePageContent NOT_ACTIVE is byte-identical to the pre-C3 notActiveDestinationPageContent('knowledge') page", () => {
  const before = renderInternalOsPage(notActiveDestinationPageContent(NAV_DESTINATIONS, "Org", "knowledge"));
  const after = renderInternalOsPage(knowledgePageContent(NAV_DESTINATIONS, "Org", { kind: "NOT_ACTIVE" }));
  assert.deepEqual(after, before);
});

test("C3K-R2: knowledgePageContent ERROR renders the OS ERROR page (500) with no data", () => {
  const rendered = renderInternalOsPage(knowledgePageContent(NAV_DESTINATIONS, "Org", { kind: "ERROR" }));
  assert.equal(rendered.status, 500);
  assert.match(rendered.html, /Something went wrong/);
  assert.doesNotMatch(rendered.html, /No evidence references/);
});

test("C3K-R3: knowledgePageContent EMPTY says no evidence is recorded, and is not the NOT ACTIVE card", () => {
  const rendered = renderInternalOsPage(knowledgePageContent(NAV_DESTINATIONS, "Org", { kind: "EMPTY" }));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /No evidence references have been recorded for this organization yet/);
  assert.doesNotMatch(rendered.html, /NOT ACTIVE/);
});

test("C3K-R4: knowledgePageContent READY renders every allow-listed field HTML-escaped, with no mutation control", () => {
  const view: KnowledgeViewState = {
    kind: "READY",
    evidence: [
      {
        evidenceId: "ev-<script>",
        evidenceType: "TYPE-\"quoted\"",
        customerId: "cust-r4",
        projectId: "proj-r4",
        jobId: "job-r4&co",
        capturedAt: "2026-10-23T01:02:03.000Z",
      },
    ],
  };
  const rendered = renderInternalOsPage(knowledgePageContent(NAV_DESTINATIONS, "Org", view));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /ev-&lt;script&gt;/);
  assert.doesNotMatch(rendered.html, /ev-<script>/);
  assert.match(rendered.html, /TYPE-&quot;quoted&quot;/);
  assert.match(rendered.html, /cust-r4 \/ proj-r4/);
  assert.match(rendered.html, /job-r4&amp;co/);
  assert.match(rendered.html, /2026-10-23T01:02:03.000Z/);
  assert.match(rendered.html, /aria-current="page">Knowledge</);
  assert.doesNotMatch(rendered.html, /<button/i);
  assert.doesNotMatch(rendered.html, /<form/i);
});

// --- createDurableKnowledgeSource over the real store ---

test("C3K-S1: createDurableKnowledgeSource returns the tenant's recorded evidence from the real FileDurableEvidenceReferenceStore, and nothing from another tenant", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEvidenceReferenceStore(dir);
    store.record(evidence(REVIEW_ORGANIZATION.tenantId, "ev-c3k-s1"));
    store.record(evidence("tenant-c3k-other", "ev-c3k-other"));
    const listed = createDurableKnowledgeSource(store).listEvidenceReferences(REVIEW_ORGANIZATION);
    assert.deepEqual(listed.map((record) => record.evidenceId), ["ev-c3k-s1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3K-S2: createDurableKnowledgeSource propagates a corrupted tenant file as a throw (never an empty list), and resolveKnowledgeView contains it as ERROR", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEvidenceReferenceStore(dir);
    writeFileSync(tenantFilePath(dir, REVIEW_ORGANIZATION.tenantId), "{ not json", "utf8");
    const source = createDurableKnowledgeSource(store);
    assert.throws(() => source.listEvidenceReferences(REVIEW_ORGANIZATION), { name: "CorruptedEvidenceReferenceFileError" });
    let view: KnowledgeViewState | undefined;
    assert.doesNotThrow(() => {
      view = resolveKnowledgeView(REVIEW_ORGANIZATION, source);
    });
    assert.deepEqual(view, { kind: "ERROR" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the real /os/knowledge route ---

test("C3K-H1: /os/knowledge with no knowledgeSource wired renders exactly the pre-C3 NOT_ACTIVE page", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/knowledge`, { headers: founderHeaders });
    assert.equal(response.status, 200);
    const body = await response.text();
    const expected = renderInternalOsPage(
      notActiveDestinationPageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, "knowledge"),
    );
    assert.equal(body, expected.html);
    assert.match(body, /NOT ACTIVE/);
  });
});

test("C3K-H2: /os/knowledge with a durable source renders real evidence through the real route, and the stored sourceLocator never appears in the HTML", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEvidenceReferenceStore(dir);
    store.record(evidence(REVIEW_ORGANIZATION.tenantId, "ev-c3k-h2", { evidenceType: "BRAND_GUIDELINES" }));
    await withServer({ ...devDeps, knowledgeSource: createDurableKnowledgeSource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /ev-c3k-h2/);
      assert.match(body, /BRAND_GUIDELINES/);
      assert.match(body, /customer-c3k \/ project-c3k/);
      assert.match(body, /plan-c3k:v1:req-1/);
      assert.doesNotMatch(body, /NOT ACTIVE/);
      assert.doesNotMatch(body, /MUST-NOT-RENDER|signature=|storage\.example/);
      assert.doesNotMatch(body, /<button/i);
      assert.doesNotMatch(body, /<form/i);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3K-H3: /os/knowledge with a durable source and no recorded evidence renders EMPTY, not NOT_ACTIVE", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEvidenceReferenceStore(dir);
    await withServer({ ...devDeps, knowledgeSource: createDurableKnowledgeSource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /No evidence references have been recorded for this organization yet/);
      assert.doesNotMatch(body, /NOT ACTIVE/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3K-H4: /os/knowledge over a corrupted store file renders the themed OS ERROR page (500), not EMPTY, and the server keeps serving", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEvidenceReferenceStore(dir);
    writeFileSync(tenantFilePath(dir, REVIEW_ORGANIZATION.tenantId), "[]", "utf8");
    await withServer({ ...devDeps, knowledgeSource: createDurableKnowledgeSource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/knowledge`, { headers: founderHeaders });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No evidence references have been recorded/);
      assert.doesNotMatch(body, /Corrupted|JSON object/);
      const home = await fetch(`${baseUrl}/os/home`, { headers: founderHeaders });
      assert.equal(home.status, 200);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3K-H5: access stays fail-closed before the source is ever read - unauthenticated is 401, and READ-only Member and Restricted are 403, with zero source reads", async () => {
  let reads = 0;
  const source: KnowledgeSource = {
    listEvidenceReferences: () => {
      reads += 1;
      return [evidence(REVIEW_ORGANIZATION.tenantId, "ev-c3k-h5")];
    },
  };
  await withServer({ ...devDeps, knowledgeSource: source }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/os/knowledge`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /ev-c3k-h5/);
    for (const fixture of [MEMBER_REVIEW_FIXTURE, RESTRICTED_REVIEW_FIXTURE]) {
      const response = await fetch(`${baseUrl}/os/knowledge`, {
        headers: { [STAFF_SESSION_TOKEN_HEADER]: fixture.sessionToken },
      });
      assert.equal(response.status, 403, fixture.sessionToken);
      assert.doesNotMatch(await response.text(), /ev-c3k-h5/);
    }
    assert.equal(reads, 0);
    const founder = await fetch(`${baseUrl}/os/knowledge`, { headers: founderHeaders });
    assert.equal(founder.status, 200);
    assert.match(await founder.text(), /ev-c3k-h5/);
    assert.equal(reads, 1);
  });
});

test("C3K-H6: wiring knowledgeSource changes only /os/knowledge - attention and ai-capabilities still render NOT_ACTIVE and no other destination reads it", async () => {
  let reads = 0;
  const source: KnowledgeSource = {
    listEvidenceReferences: () => {
      reads += 1;
      return [evidence(REVIEW_ORGANIZATION.tenantId, "ev-c3k-h6")];
    },
  };
  await withServer({ ...devDeps, knowledgeSource: source }, async (baseUrl) => {
    for (const key of ["attention", "ai-capabilities"] as const) {
      const response = await fetch(`${baseUrl}/os/${key}`, { headers: founderHeaders });
      assert.equal(response.status, 200);
      const body = await response.text();
      const expected = renderInternalOsPage(
        notActiveDestinationPageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, key),
      );
      assert.equal(body, expected.html);
    }
    for (const path of ["/os/home", "/os/work", "/os/connections", "/os/people", "/os/products", "/os/admin"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: founderHeaders });
      assert.equal(response.status, 200, path);
      assert.doesNotMatch(await response.text(), /ev-c3k-h6/, path);
    }
    assert.equal(reads, 0);
  });
});
