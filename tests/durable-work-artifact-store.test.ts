import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createWorkArtifact, workArtifactLocator, InvalidWorkArtifactError } from "../src/domain/work-artifact.js";
import {
  FileDurableWorkArtifactStore,
  WorkArtifactConflictError,
  CorruptedWorkArtifactFileError,
  InvalidWorkArtifactStoreError,
  type DurableWorkArtifactStore,
} from "../src/domain/durable-work-artifact-store.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "work-artifact-store-"));
}

function withStore(run: (store: DurableWorkArtifactStore, dir: string) => void): void {
  const dir = freshStoreDir();
  try {
    run(new FileDurableWorkArtifactStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TENANT_A = createTenantScope("tenant-work-artifact-a");
const TENANT_B = createTenantScope("tenant-work-artifact-b");

function jobFor(tenantScope = TENANT_A) {
  const customer = createCustomer({ tenantScope, customerId: "cust-wa", displayName: "WA Customer" });
  const project = createProject({ tenantScope, customer, projectId: "proj-wa", ownerRef: "owner-wa", state: "active" });
  return createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-wa-1",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Produce website copy",
  });
}

function artifactFor(job = jobFor(), overrides: Partial<Parameters<typeof createWorkArtifact>[0]> = {}) {
  return createWorkArtifact({
    job,
    artifactId: "artifact-1",
    artifactType: "WEBSITE_CONTENT_DRAFT",
    content: "Welcome to Reference Customer Co.\n",
    producedByConnectorKind: "ANTHROPIC",
    producedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  });
}

// --- domain constructor ---

test("createWorkArtifact: builds a valid artifact from a job, and workArtifactLocator points at it", () => {
  const job = jobFor();
  const artifact = artifactFor(job);
  assert.equal(artifact.tenantId, job.tenantId);
  assert.equal(artifact.customerId, job.customerId);
  assert.equal(artifact.projectId, job.projectId);
  assert.equal(artifact.jobId, job.jobId);
  assert.equal(workArtifactLocator(artifact), `artifact://${job.tenantId}/artifact-1`);
});

test("createWorkArtifact: content only requires non-empty-after-trim, interior/trailing whitespace preserved verbatim", () => {
  const artifact = artifactFor(jobFor(), { content: "  Line one.\nLine two.\n\n" });
  assert.equal(artifact.content, "  Line one.\nLine two.\n\n");
});

test("createWorkArtifact: rejects empty/whitespace-only content and empty identifier fields", () => {
  const job = jobFor();
  assert.throws(() => artifactFor(job, { content: "   " }), InvalidWorkArtifactError);
  assert.throws(() => artifactFor(job, { artifactId: "" }), InvalidWorkArtifactError);
  assert.throws(() => artifactFor(job, { artifactType: " padded " }), InvalidWorkArtifactError);
  assert.throws(() => artifactFor(job, { producedByConnectorKind: "" }), InvalidWorkArtifactError);
});

// --- store: round-trip / idempotent replay / conflict ---

test("record + get: round-trips exactly, including verbatim content whitespace", () => {
  withStore((store) => {
    const artifact = artifactFor(jobFor(), { content: "Para one.\n\nPara two.\n" });
    store.record(artifact);
    const stored = store.get(TENANT_A.tenantId, artifact.artifactId);
    assert.ok(stored !== undefined);
    assert.deepEqual(stored!.artifact, artifact);
  });
});

test("record: idempotent on exact replay (safe no-op), conflicts on a differing record under the same artifactId", () => {
  withStore((store) => {
    const artifact = artifactFor();
    store.record(artifact);
    assert.deepEqual(store.record(artifact), { artifact });

    const differing = artifactFor(jobFor(), { content: "A different draft entirely.\n" });
    assert.throws(() => store.record(differing), WorkArtifactConflictError);
  });
});

test("record: rejects a structurally invalid artifact before touching disk", () => {
  withStore((store, dir) => {
    assert.throws(
      () => store.record({ ...artifactFor(), content: "" }),
      InvalidWorkArtifactStoreError,
    );
    const files = (() => {
      try {
        return readFileSync(join(dir, Buffer.from(TENANT_A.tenantId, "utf8").toString("base64url") + ".json"), "utf8");
      } catch {
        return undefined;
      }
    })();
    assert.equal(files, undefined, "a rejected record must commit zero bytes");
  });
});

test("listByTenant: returns every recorded artifact for that tenant, empty array when none recorded", () => {
  withStore((store) => {
    assert.deepEqual(store.listByTenant(TENANT_A.tenantId), []);
    const job = jobFor();
    const first = artifactFor(job, { artifactId: "artifact-1" });
    const second = artifactFor(job, { artifactId: "artifact-2", content: "Second draft.\n" });
    store.record(first);
    store.record(second);
    const all = store.listByTenant(TENANT_A.tenantId).map((s) => s.artifact.artifactId).sort();
    assert.deepEqual(all, ["artifact-1", "artifact-2"]);
  });
});

test("cross-tenant isolation: a tenant's own file never contains another tenant's records, listing/get never cross tenant boundaries", () => {
  withStore((store) => {
    store.record(artifactFor(jobFor(TENANT_A)));
    store.record(artifactFor(jobFor(TENANT_B), { artifactId: "artifact-b-1" }));

    assert.deepEqual(store.listByTenant(TENANT_A.tenantId).map((s) => s.artifact.artifactId), ["artifact-1"]);
    assert.deepEqual(store.listByTenant(TENANT_B.tenantId).map((s) => s.artifact.artifactId), ["artifact-b-1"]);
    assert.equal(store.get(TENANT_A.tenantId, "artifact-b-1" as never), undefined);
    assert.equal(store.get(TENANT_B.tenantId, "artifact-1" as never), undefined);
  });
});

test("restart-safety: a fresh store instance over the same baseDir reconstructs every previously recorded artifact", () => {
  const dir = freshStoreDir();
  try {
    const first = new FileDurableWorkArtifactStore(dir);
    const artifact = artifactFor();
    first.record(artifact);

    const second = new FileDurableWorkArtifactStore(dir);
    const stored = second.get(TENANT_A.tenantId, artifact.artifactId);
    assert.deepEqual(stored, { artifact });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- adversarial corrupted-file sweep ---

const CORRUPTED_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ["not an object", ["array", "not", "object"]],
  ["null", null],
  ["missing artifact key", {}],
  ["artifact not an object", { artifact: "nope" }],
  ["missing artifactId", { artifact: { tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: "x", producedByConnectorKind: "ANTHROPIC", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["artifactId mismatches stored key", { artifact: { artifactId: "wrong-key", tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: "x", producedByConnectorKind: "ANTHROPIC", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["tenantId mismatches tenant file", { artifact: { artifactId: "artifact-1", tenantId: "someone-elses-tenant", customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: "x", producedByConnectorKind: "ANTHROPIC", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["content not a string", { artifact: { artifactId: "artifact-1", tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: 12345, producedByConnectorKind: "ANTHROPIC", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["content whitespace-only", { artifact: { artifactId: "artifact-1", tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: "   ", producedByConnectorKind: "ANTHROPIC", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["artifactType untrimmed", { artifact: { artifactId: "artifact-1", tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: " padded ", content: "x", producedByConnectorKind: "ANTHROPIC", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["producedByConnectorKind empty", { artifact: { artifactId: "artifact-1", tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: "x", producedByConnectorKind: "", producedAt: "2026-01-01T00:00:00.000Z" } }],
  ["producedAt missing", { artifact: { artifactId: "artifact-1", tenantId: TENANT_A.tenantId, customerId: "c", projectId: "p", jobId: "j", artifactType: "t", content: "x", producedByConnectorKind: "ANTHROPIC" } }],
];

test("adversarial corrupted-line sweep: every malformed persisted shape fails closed with CorruptedWorkArtifactFileError", () => {
  for (const [label, badFile] of CORRUPTED_CASES) {
    const dir = freshStoreDir();
    try {
      const filePath = join(dir, Buffer.from(TENANT_A.tenantId, "utf8").toString("base64url") + ".json");
      writeFileSync(filePath, JSON.stringify({ "artifact-1": badFile }), "utf8");
      const store = new FileDurableWorkArtifactStore(dir);
      assert.throws(() => store.listByTenant(TENANT_A.tenantId), CorruptedWorkArtifactFileError, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("poisoned file isolation: a corrupted file for one tenant never affects reads for another tenant", () => {
  const dir = freshStoreDir();
  try {
    const poisonedPath = join(dir, Buffer.from(TENANT_A.tenantId, "utf8").toString("base64url") + ".json");
    writeFileSync(poisonedPath, "{not valid json", "utf8");
    const store = new FileDurableWorkArtifactStore(dir);
    assert.throws(() => store.listByTenant(TENANT_A.tenantId), CorruptedWorkArtifactFileError);
    assert.deepEqual(store.listByTenant(TENANT_B.tenantId), []);
    store.record(artifactFor(jobFor(TENANT_B), { artifactId: "artifact-b-ok" }));
    assert.equal(store.listByTenant(TENANT_B.tenantId).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- stale lock reclaim ---

function plantLock(dir: string, tenantId: string, ageMs: number): void {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  const lockPath = join(dir, ".locks", `${safeKey}.lock`);
  mkdirSync(join(dir, ".locks"), { recursive: true });
  writeFileSync(lockPath, "99999999", "utf8");
  const past = new Date(Date.now() - ageMs);
  utimesSync(lockPath, past, past);
}

test("stale lock reclaim: a lock file abandoned by a crashed process is reclaimed quickly rather than stalling for the full timeout", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableWorkArtifactStore(dir);
    plantLock(dir, TENANT_A.tenantId, 31_000);
    const startedAt = Date.now();
    const result = store.listByTenant(TENANT_A.tenantId);
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, []);
    assert.ok(elapsedMs < 2000, `expected the stale lock to be reclaimed quickly, took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
