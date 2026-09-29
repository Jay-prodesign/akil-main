import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  buildReviewWorkProjectSource,
  buildReviewWorkJobSource,
  FOUNDER_REVIEW_FIXTURE,
  RESTRICTED_REVIEW_FIXTURE,
  REVIEW_PROJECT_ALPHA,
} from "../src/web/internal-os-review-fixtures.js";

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

test("the internal OS shell starts on an ephemeral local port and serves a real HTTP request end-to-end", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/home`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Organization/);
    assert.match(body, /Company OS/);
  });
});

test("a real HTTP request with no staff session token is rejected end-to-end with 401", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/home`);
    assert.equal(response.status, 401);
  });
});

test("a production-mode server never admits a dev staff fixture token, even when supplied as devStaffFixtures", async () => {
  await withServer({ ...devDeps, isProduction: true }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/home`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 401);
  });
});

test("a restricted fixture (zero project assignments) receives 403 when requesting an assigned-only project's detail page", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/work/${REVIEW_PROJECT_ALPHA.customerId}/${REVIEW_PROJECT_ALPHA.projectId}`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: RESTRICTED_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /do not have access/);
  });
});

test("an unknown /os/... path returns 404 end-to-end", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/does-not-exist`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 404);
  });
});

test("a non-GET request to the internal OS is rejected end-to-end with 501 (unsupported)", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/home`, {
      method: "POST",
      headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 501);
  });
});
