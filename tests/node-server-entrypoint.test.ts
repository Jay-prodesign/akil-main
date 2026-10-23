import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import { createNodeRuntime, health } from "../src/runtime/node-server-entrypoint.js";
import { WEB_SHELL_DEV_SESSION_TOKEN } from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";
import { fileDurableRuntimeStoreDir } from "../src/runtime/file-durable-runtime-stores.js";

/**
 * C1: `createNodeRuntime` now roots real FILE stores at `DATA_DIR`, so
 * every test boots against its own fresh temp directory (never the
 * default `.akilta-data` in the working directory).
 */
function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "node-server-entrypoint-"));
}

function listenOnEphemeralPort(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo from an ephemeral-port listen");
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("N1: health(config) reports HEALTHY for a validly resolved config", () => {
  const config = resolveAppConfig({});
  const result = health(config);
  assert.equal(result.status, "HEALTHY");
});

test("N2: createNodeRuntime boots a real server that serves the existing shell end-to-end over an ephemeral local port", async () => {
  // C1: the runtime no longer injects the in-memory WEBSITE_BUILD_V1
  // fixture snapshot - the same project (and one job, so the snapshot is
  // not EMPTY) is written to the durable FILE stores the runtime reads.
  const dataDir = freshDataDir();
  const tenantScope = createTenantScope(WEBSITE_BUILD_V1_OWNERSHIP.tenantId);
  const customer = createCustomer({ tenantScope, customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId, displayName: "Reference Customer Co" });
  const project = createProject({ tenantScope, customer, projectId: WEBSITE_BUILD_V1_OWNERSHIP.projectId as string, ownerRef: "owner", state: "ACTIVE" });
  new FileDurableProjectStore(fileDurableRuntimeStoreDir(dataDir, "projects")).create(project);
  new FileDurableOutcomeJobStore(fileDurableRuntimeStoreDir(dataDir, "outcomeJobs")).putIfAbsent(
    createOutcomeJob({ tenantScope, customer, project, jobId: "job-n2", jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" }),
  );
  const config = resolveAppConfig({ DEPLOYMENT_ENV: "development", DATA_DIR: dataDir });
  const runtime = createNodeRuntime(config);
  const port = await listenOnEphemeralPort(runtime.server);
  try {
    const path = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "x-akilta-session-token": WEB_SHELL_DEV_SESSION_TOKEN },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.length > 0);
  } finally {
    await closeServer(runtime.server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("N4 (DEPLOY-003): GET /health on the booted runtime returns 200 with a HEALTHY JSON body, with no session token required", async () => {
  const dataDir = freshDataDir();
  const config = resolveAppConfig({ DEPLOYMENT_ENV: "development", DATA_DIR: dataDir });
  const runtime = createNodeRuntime(config);
  const port = await listenOnEphemeralPort(runtime.server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "HEALTHY");
  } finally {
    await closeServer(runtime.server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("N3: an unauthenticated request against the booted runtime is rejected, not silently served", async () => {
  const dataDir = freshDataDir();
  const config = resolveAppConfig({ DEPLOYMENT_ENV: "development", DATA_DIR: dataDir });
  const runtime = createNodeRuntime(config);
  const port = await listenOnEphemeralPort(runtime.server);
  try {
    const path = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.notEqual(response.status, 200);
  } finally {
    await closeServer(runtime.server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
