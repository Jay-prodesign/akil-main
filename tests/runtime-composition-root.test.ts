import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { resolveAppConfig } from "../src/runtime/app-config.js";
import {
  createNodeRuntime,
  UnsupportedRuntimePersistenceDriverError,
  type NodeRuntimeOptions,
} from "../src/runtime/node-server-entrypoint.js";
import {
  FILE_DURABLE_RUNTIME_STORE_LAYOUT,
  fileDurableRuntimeStoreDir,
} from "../src/runtime/file-durable-runtime-stores.js";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject, type Project } from "../src/domain/project.js";
import { createOutcomeJob, transitionOutcomeJob } from "../src/domain/outcome-job.js";
import { FileDurableProjectStore } from "../src/domain/durable-project-store.js";
import { FileDurableOutcomeJobStore } from "../src/domain/durable-outcome-job-store.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";
import { FileDurableCustomerOffboardingRequestStore } from "../src/domain/durable-customer-offboarding-request-store.js";
import { requestCustomerOffboarding } from "../src/domain/customer-offboarding.js";
import { createAssignmentReference, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createAuthenticatedPrincipal, createSessionContext, type SessionContext } from "../src/web/session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import { selectInternalOsStaffSessionProvider } from "../src/web/staff-session-provider-selection.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { WEB_SHELL_DEV_SESSION_TOKEN } from "../src/fixtures/web-shell.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";

/**
 * C1 (runtime composition root, FILE driver): proves the deployable
 * runtime (`createNodeRuntime`) is one Node process that serves `/health`,
 * `/portal/*` and `/os/*` from real `FileDurable*` stores rooted at
 * `DATA_DIR`, not from in-memory fixtures. Every write in these tests goes
 * through a SEPARATELY CONSTRUCTED store instance pointed at the same
 * on-disk directory the runtime uses, so a passing read-back proves the
 * data crossed the filesystem. It was not shared through an in-memory
 * object.
 */

const SESSION_TOKEN_HEADER = "x-akilta-session-token";
const PORTAL_TOKEN = "dev-portal-token-c1";
const STAFF_TOKEN = "dev-staff-token-c1";
const OS_TENANT = "tenant-c1-os";
const OS_ORG = "org-c1-zero";
const OS_PRINCIPAL = "staff-c1-founder";

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "c1-runtime-data-"));
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

async function withRuntime(
  env: Record<string, string>,
  options: NodeRuntimeOptions,
  run: (baseUrl: string, dataDir: string) => Promise<void>,
): Promise<void> {
  const runtime = createNodeRuntime(resolveAppConfig(env), options);
  const port = await listen(runtime.server);
  try {
    await run(`http://127.0.0.1:${port}`, runtime.dataDir);
  } finally {
    await close(runtime.server);
  }
}

function seedProjectWithExecutingJob(dataDir: string, tenantScope: TenantScope, customerId: string, projectId: string, jobId: string): Project {
  const customer = createCustomer({ tenantScope, customerId, displayName: "C1 Customer" });
  const project = createProject({ tenantScope, customer, projectId, ownerRef: "owner-c1", state: "ACTIVE" });
  const job = transitionOutcomeJob(
    transitionOutcomeJob(
      transitionOutcomeJob(
        createOutcomeJob({ tenantScope, customer, project, jobId, jobFamily: "WEBSITE_BUILD", businessObjective: "Deliver" }),
        "QUALIFIED",
      ),
      "READY",
    ),
    "EXECUTING",
  );
  new FileDurableProjectStore(fileDurableRuntimeStoreDir(dataDir, "projects")).create(project);
  new FileDurableOutcomeJobStore(fileDurableRuntimeStoreDir(dataDir, "outcomeJobs")).putIfAbsent(job);
  return project;
}

function provisionOsOrganization(dataDir: string): OrganizationMembership {
  const store = new FileDurableControlledOrganizationProvisioningStore(
    fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"),
  );
  const outcome = store.provision({
    tenantScope: createTenantScope(OS_TENANT),
    organizationId: OS_ORG,
    displayName: "AKILTA Zero (C1)",
    founderMembershipId: "membership-c1-founder",
    founderPrincipalRef: OS_PRINCIPAL,
    idempotencyKey: "c1-provision-1",
    occurredAt: "2026-10-23T00:00:00.000Z",
  });
  assert.ok(outcome.mintedFounderMembership !== undefined);
  return outcome.mintedFounderMembership;
}

function staffOptions(
  membership: OrganizationMembership,
  assignedProject?: Project,
  permissions: ReadonlyArray<"READ" | "WRITE" | "EXECUTE"> = ["READ"],
): NodeRuntimeOptions {
  const session: StaffSessionContext = {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "C1 Founder" }),
    issuedAt: "2026-10-23T00:00:00.000Z",
  };
  const grant: StaffAccessGrant = {
    membership,
    authority: createAuthorityContext({
      tenantScope: createTenantScope(OS_TENANT),
      permissions,
      canPerformProtectedActions: false,
    }),
    assignments:
      assignedProject !== undefined
        ? [
            createAssignmentReference({
              assignmentId: "assignment-c1",
              membership,
              customerId: assignedProject.customerId,
              projectId: assignedProject.projectId,
            }),
          ]
        : [],
  };
  return {
    devStaffSessionFixtures: new Map([[STAFF_TOKEN, session]]),
    staffAccessGrants: [grant],
  };
}

function portalSessionFor(tenantId: string, customerId: string, projectId: string): ReadonlyMap<string, SessionContext> {
  return new Map([
    [
      PORTAL_TOKEN,
      createSessionContext({
        principal: createAuthenticatedPrincipal({ principalId: "customer-c1", tenantId, customerId, displayName: "C1 Contact" }),
        projectId,
        issuedAt: "2026-10-23T00:00:00.000Z",
      }),
    ],
  ]);
}

const OS_ENV = { INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG };

test("C1-R1: one runtime process serves /health, /portal/* and /os/* from the same port, all backed by the durable FILE stores", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    const tenantScope = createTenantScope(OS_TENANT);
    const project = seedProjectWithExecutingJob(dataDir, tenantScope, "customer-c1", "project-c1", "job-c1-1");
    await withRuntime(
      { DATA_DIR: dataDir, ...OS_ENV },
      { ...staffOptions(membership, project), devSessionFixtures: portalSessionFor(OS_TENANT, "customer-c1", "project-c1") },
      async (baseUrl) => {
        const healthResponse = await fetch(`${baseUrl}/health`);
        assert.equal(healthResponse.status, 200);
        const health = (await healthResponse.json()) as { status: string; probes: Array<{ name: string; healthy: boolean }> };
        assert.equal(health.status, "HEALTHY");
        for (const subdir of Object.values(FILE_DURABLE_RUNTIME_STORE_LAYOUT)) {
          assert.ok(health.probes.some((probe) => probe.name === `file-store:${subdir}` && probe.healthy));
        }

        const portalResponse = await fetch(`${baseUrl}/portal/${OS_TENANT}/customer-c1/project-c1`, {
          headers: { [SESSION_TOKEN_HEADER]: PORTAL_TOKEN },
        });
        assert.equal(portalResponse.status, 200);
        const portalBody = await portalResponse.text();
        assert.match(portalBody, /Project: project-c1/);
        assert.match(portalBody, /IN_PROGRESS/);

        const osResponse = await fetch(`${baseUrl}/os/home`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
        assert.equal(osResponse.status, 200);
        const osBody = await osResponse.text();
        assert.match(osBody, /AKILTA Zero \(C1\)/);
        assert.match(osBody, /AKILTA OS/);
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R2: a project written through a separately-constructed durable store after boot is read back through the running /portal route (no caching, no fixture)", async () => {
  const dataDir = freshDataDir();
  try {
    const tenantScope = createTenantScope("tenant-c1-portal");
    await withRuntime(
      { DATA_DIR: dataDir },
      { devSessionFixtures: portalSessionFor("tenant-c1-portal", "customer-c1p", "project-c1p") },
      async (baseUrl) => {
        const path = `${baseUrl}/portal/tenant-c1-portal/customer-c1p/project-c1p`;
        const before = await fetch(path, { headers: { [SESSION_TOKEN_HEADER]: PORTAL_TOKEN } });
        assert.equal(before.status, 404);

        seedProjectWithExecutingJob(dataDir, tenantScope, "customer-c1p", "project-c1p", "job-c1p-1");

        const after = await fetch(path, { headers: { [SESSION_TOKEN_HEADER]: PORTAL_TOKEN } });
        assert.equal(after.status, 200);
        const body = await after.text();
        assert.match(body, /Project: project-c1p/);
        assert.match(body, /IN_PROGRESS/);
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R3: the fixture snapshot source is no longer injected - the long-standing dev token's WEBSITE_BUILD_V1 portal path is NOT_FOUND against an empty data root", async () => {
  const dataDir = freshDataDir();
  try {
    await withRuntime({ DATA_DIR: dataDir }, {}, async (baseUrl) => {
      const path = `/portal/${WEBSITE_BUILD_V1_OWNERSHIP.tenantId}/${WEBSITE_BUILD_V1_OWNERSHIP.customerId}/${WEBSITE_BUILD_V1_OWNERSHIP.projectId}`;
      const response = await fetch(`${baseUrl}${path}`, { headers: { [SESSION_TOKEN_HEADER]: WEB_SHELL_DEV_SESSION_TOKEN } });
      assert.equal(response.status, 404);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R4: /os/work/{customer}/{project} renders the durable project and its durable OutcomeJob through the composed server", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    const project = seedProjectWithExecutingJob(dataDir, createTenantScope(OS_TENANT), "customer-c1w", "project-c1w", "job-c1w-durable");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, project), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/work/customer-c1w/project-c1w`, {
        headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /project-c1w/);
      assert.match(body, /job-c1w-durable/);
      assert.match(body, /EXECUTING/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R5: the /os Organization is re-read from the durable provisioning ledger per request - a suspension recorded after boot is visible on the next request", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership), async (baseUrl) => {
      const headers = { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN };
      const before = await (await fetch(`${baseUrl}/os/home`, { headers })).text();
      assert.match(before, /Status: ACTIVE/);

      new FileDurableControlledOrganizationProvisioningStore(
        fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning"),
      ).suspend({
        tenantScope: createTenantScope(OS_TENANT),
        organizationId: OS_ORG,
        suspendedAt: "2026-10-23T01:00:00.000Z",
        idempotencyKey: "c1-suspend-1",
      });

      const after = await (await fetch(`${baseUrl}/os/home`, { headers })).text();
      assert.match(after, /Status: SUSPENDED/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R6: /os/admin's pending-offboarding queue is the durable CustomerOffboardingRequest store, written after boot", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    // `/os/admin` is nav-gated on WRITE (Rev170 F1) - READ alone is 403.
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, undefined, ["READ", "WRITE"]), async (baseUrl) => {
      const tenantScope = createTenantScope(OS_TENANT);
      const customer = createCustomer({ tenantScope, customerId: "customer-c1-offboard", displayName: "Leaving Co" });
      new FileDurableCustomerOffboardingRequestStore(
        fileDurableRuntimeStoreDir(dataDir, "customerOffboardingRequests"),
      ).createRequested(
        requestCustomerOffboarding({
          requestId: "offboard-request-c1",
          customer,
          requestedByRef: "customer-contact-c1",
          requestedAt: "2026-10-23T02:00:00.000Z",
        }),
      );
      const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN } });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /customer-c1-offboard: <span[^>]*>REQUESTED<\/span> by customer-contact-c1/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R7: /os/* is always dispatched to the staff surface - with no INTERNAL_OS_* configured, or a configured but never-provisioned organization, it renders the OS NOT_FOUND page (not the portal's)", async () => {
  const dataDir = freshDataDir();
  try {
    await withRuntime({ DATA_DIR: dataDir }, {}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/home`);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /AKILTA OS/);
    });
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, {}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/home`);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /AKILTA OS/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R8: a corrupted provisioning ledger renders the OS ERROR page (500), never NOT_FOUND, and never crashes the process", async () => {
  const dataDir = freshDataDir();
  try {
    provisionOsOrganization(dataDir);
    const ledgerDir = fileDurableRuntimeStoreDir(dataDir, "controlledOrganizationProvisioning");
    const [ledgerFile] = readdirSync(ledgerDir).filter((name) => name.endsWith(".jsonl"));
    assert.ok(ledgerFile !== undefined);
    writeFileSync(join(ledgerDir, ledgerFile), "{ this is not json\n", "utf8");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, {}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/home`);
      assert.equal(response.status, 500);
      const body = await response.text();
      // The staff surface's own ERROR page - not the transport's generic
      // last-resort 500 - so this proves the organization-source catch itself.
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /not json|jsonl/);
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R9: production stays fail-closed on BOTH surfaces even with seeded durable data and dev fixture maps supplied - no identity verifier, no staff provider override", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    const project = seedProjectWithExecutingJob(dataDir, createTenantScope(OS_TENANT), "customer-c1", "project-c1", "job-c1-1");
    await withRuntime(
      { DATA_DIR: dataDir, DEPLOYMENT_ENV: "production", ...OS_ENV },
      { ...staffOptions(membership, project), devSessionFixtures: portalSessionFor(OS_TENANT, "customer-c1", "project-c1") },
      async (baseUrl) => {
        const portal = await fetch(`${baseUrl}/portal/${OS_TENANT}/customer-c1/project-c1`, {
          headers: { [SESSION_TOKEN_HEADER]: PORTAL_TOKEN },
        });
        assert.equal(portal.status, 401);
        assert.doesNotMatch(await portal.text(), /project-c1|IN_PROGRESS/);

        const os = await fetch(`${baseUrl}/os/work/customer-c1/project-c1`, {
          headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN },
        });
        assert.equal(os.status, 401);
        assert.doesNotMatch(await os.text(), /job-c1-1|AKILTA Zero/);

        assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R10: /health fails closed (503 UNHEALTHY) once a store directory stops being readable after boot, naming the store but never the filesystem path", async () => {
  const dataDir = freshDataDir();
  try {
    await withRuntime({ DATA_DIR: dataDir }, {}, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);

      rmSync(fileDurableRuntimeStoreDir(dataDir, "projects"), { recursive: true, force: true });
      const removed = await fetch(`${baseUrl}/health`);
      assert.equal(removed.status, 503);
      const removedText = await removed.text();
      assert.ok(!removedText.includes(dataDir));
      const removedBody = JSON.parse(removedText) as { status: string; probes: Array<{ name: string; healthy: boolean; detail: string }> };
      assert.equal(removedBody.status, "UNHEALTHY");
      const failed = removedBody.probes.filter((probe) => !probe.healthy);
      assert.deepEqual(failed.map((probe) => probe.name), ["file-store:projects"]);
      assert.match(failed[0]?.detail ?? "", /ENOENT/);

      writeFileSync(fileDurableRuntimeStoreDir(dataDir, "projects"), "not a directory", "utf8");
      const replaced = await fetch(`${baseUrl}/health`);
      assert.equal(replaced.status, 503);
      assert.match(await replaced.text(), /ENOTDIR/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R11: a store exception that escapes a handler (corrupted project file on /os work detail) becomes one generic 500 - the process keeps serving", async () => {
  const dataDir = freshDataDir();
  try {
    const membership = provisionOsOrganization(dataDir);
    const project = seedProjectWithExecutingJob(dataDir, createTenantScope(OS_TENANT), "customer-c1x", "project-c1x", "job-c1x-1");
    const projectsDir = fileDurableRuntimeStoreDir(dataDir, "projects");
    const safeKey = Buffer.from(OS_TENANT, "utf8").toString("base64url");
    writeFileSync(join(projectsDir, `${safeKey}.json`), "{ corrupted", "utf8");
    await withRuntime({ DATA_DIR: dataDir, ...OS_ENV }, staffOptions(membership, project), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/work/customer-c1x/project-c1x`, {
        headers: { [STAFF_SESSION_TOKEN_HEADER]: STAFF_TOKEN },
      });
      assert.equal(response.status, 500);
      assert.equal(await response.text(), "Internal Server Error");
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R12: PERSISTENCE_DRIVER=POSTGRES fails closed at runtime construction instead of silently serving FILE data", () => {
  const dataDir = freshDataDir();
  try {
    assert.throws(
      () =>
        createNodeRuntime(
          resolveAppConfig({ DATA_DIR: dataDir, PERSISTENCE_DRIVER: "POSTGRES", DATABASE_URL: "postgres://example/db" }),
        ),
      UnsupportedRuntimePersistenceDriverError,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R13: a malformed configured INTERNAL_OS_TENANT_ID fails closed at boot, not on the first request", () => {
  const dataDir = freshDataDir();
  try {
    assert.throws(() =>
      createNodeRuntime(
        resolveAppConfig({ DATA_DIR: dataDir, INTERNAL_OS_TENANT_ID: " padded ", INTERNAL_OS_ORGANIZATION_ID: OS_ORG }),
      ),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R14: selectInternalOsStaffSessionProvider (shared by the runtime and createInternalOsHttpServer) ignores dev staff fixtures entirely in production", () => {
  const session: StaffSessionContext = {
    principal: createAuthenticatedStaffPrincipal({ principalId: OS_PRINCIPAL, displayName: "C1 Founder" }),
    issuedAt: "2026-10-23T00:00:00.000Z",
  };
  const fixtures = new Map([[STAFF_TOKEN, session]]);
  const production = selectInternalOsStaffSessionProvider({ isProduction: true, devStaffFixtures: fixtures });
  assert.equal(production.resolveStaffSession(STAFF_TOKEN), undefined);
  const development = selectInternalOsStaffSessionProvider({ isProduction: false, devStaffFixtures: fixtures });
  assert.equal(development.resolveStaffSession(STAFF_TOKEN)?.principal.principalId, OS_PRINCIPAL);
});

test("C1-R15: boot warns on stderr when INTERNAL_OS_TENANT_ID/INTERNAL_OS_ORGANIZATION_ID are both unset, since the entire /os surface will silently 404 with no other signal", () => {
  const dataDir = freshDataDir();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    createNodeRuntime(resolveAppConfig({ DATA_DIR: dataDir }));
    assert.ok(
      warnings.some((message) => message.includes("INTERNAL_OS_TENANT_ID") && message.includes("/os")),
      `expected a boot warning naming INTERNAL_OS_TENANT_ID and /os, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C1-R16: boot stays silent on this warning when INTERNAL_OS_TENANT_ID/INTERNAL_OS_ORGANIZATION_ID are both set", () => {
  const dataDir = freshDataDir();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    createNodeRuntime(resolveAppConfig({ DATA_DIR: dataDir, INTERNAL_OS_TENANT_ID: OS_TENANT, INTERNAL_OS_ORGANIZATION_ID: OS_ORG }));
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
