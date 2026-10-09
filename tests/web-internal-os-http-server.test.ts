import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInternalOsHttpServer } from "../src/web/internal-os-http-server.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";
import type { OrganizationResourceBindingSource } from "../src/web/internal-os-view-state.js";
import {
  REVIEW_ORGANIZATION,
  buildReviewStaffSessionFixtureMap,
  buildReviewStaffAccessGrants,
  buildReviewWorkProjectSource,
  buildReviewWorkJobSource,
  FOUNDER_REVIEW_FIXTURE,
  MEMBER_REVIEW_FIXTURE,
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

test("Rev170 F1: a restricted fixture (zero project assignments) is fail-closed with 403 when deep-linking a project detail page, since Work itself is hidden by nav policy for a fixture with no assignment evidence", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/work/${REVIEW_PROJECT_ALPHA.customerId}/${REVIEW_PROJECT_ALPHA.projectId}`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: RESTRICTED_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, /Access denied/);
  });
});

test("Rev170 F1: a member fixture (one real assignment) CAN reach its own assigned project's detail page - Work is visible for it, unlike the restricted fixture", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/work/${REVIEW_PROJECT_ALPHA.customerId}/${REVIEW_PROJECT_ALPHA.projectId}`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 200);
  });
});

test("Rev170 F1: the Founder/high-access fixture sees all 9 nav links end-to-end; the Member fixture sees only 4; the Restricted fixture sees only 3 - materially different navigation, not a static constant", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const founderResponse = await fetch(`${baseUrl}/os/home`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    const founderBody = await founderResponse.text();
    for (const path of ["/os/home", "/os/work", "/os/attention", "/os/ai-capabilities", "/os/connections", "/os/knowledge", "/os/people", "/os/products", "/os/admin"]) {
      assert.match(founderBody, new RegExp(`href="${path}"`));
    }

    const memberResponse = await fetch(`${baseUrl}/os/home`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken } });
    const memberBody = await memberResponse.text();
    for (const path of ["/os/home", "/os/work", "/os/people", "/os/products"]) {
      assert.match(memberBody, new RegExp(`href="${path}"`));
    }
    for (const path of ["/os/attention", "/os/ai-capabilities", "/os/connections", "/os/knowledge", "/os/admin"]) {
      assert.doesNotMatch(memberBody, new RegExp(`href="${path}"`));
    }

    const restrictedResponse = await fetch(`${baseUrl}/os/home`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: RESTRICTED_REVIEW_FIXTURE.sessionToken } });
    const restrictedBody = await restrictedResponse.text();
    for (const path of ["/os/home", "/os/people", "/os/products"]) {
      assert.match(restrictedBody, new RegExp(`href="${path}"`));
    }
    for (const path of ["/os/work", "/os/attention", "/os/ai-capabilities", "/os/connections", "/os/knowledge", "/os/admin"]) {
      assert.doesNotMatch(restrictedBody, new RegExp(`href="${path}"`));
    }
  });
});

test("Rev170 F1: a member fixture (no WRITE) deep-linking /os/admin directly is fail-closed with 403, even though it never sees that link in its own nav", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(response.status, 403);
  });
});

test("Rev170 F1: a restricted fixture (no assignment) deep-linking /os/work directly is fail-closed with 403", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/work`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: RESTRICTED_REVIEW_FIXTURE.sessionToken } });
    assert.equal(response.status, 403);
  });
});

test("Rev170 F1: the Founder/high-access fixture (WRITE present) CAN still reach /os/admin", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(response.status, 200);
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

// --- Rev184 F3-residual: the real /os/admin route must actually thread resourceBindingSource, not just define it ---

test("Rev184 F3-residual: /os/admin with no resourceBindingSource wired renders the honest NOT_ACTIVE posture through the real production-shaped route", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Resource binding/);
    assert.match(body, /NOT ACTIVE/);
  });
});

test("Rev184 F3-residual: /os/admin with a resourceBindingSource resolving no binding renders NOT_BOUND through the real route, distinct from NOT_ACTIVE", async () => {
  const source: OrganizationResourceBindingSource = { resolveStatus: () => undefined };
  await withServer({ ...devDeps, resourceBindingSource: source }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /NOT BOUND/);
  });
});

test("Rev184 F3-residual: /os/admin with a BLOCKED current status renders the exact blocker/next-actor through the real route, not fabricated NOT_ACTIVE", async () => {
  const source: OrganizationResourceBindingSource = {
    resolveStatus: () => ({
      tenantId: REVIEW_ORGANIZATION.tenantId,
      organizationId: REVIEW_ORGANIZATION.organizationId,
      state: "BLOCKED",
      nextRequiredActor: "HUMAN_REVIEW",
      nextRequiredAction: {
        code: "NO_ACTIVE_BOUND_MEMBERSHIP",
        reason: "none of this binding's own membershipRefs currently resolve to an active, coherent, tenant-correct membership",
      },
      unresolvedGates: ["NO_ACTIVE_BOUND_MEMBERSHIP"],
    }),
  };
  await withServer({ ...devDeps, resourceBindingSource: source }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    const body = await response.text();
    assert.match(body, /BLOCKED/);
    assert.match(body, /HUMAN_REVIEW/);
    assert.match(body, /NO_ACTIVE_BOUND_MEMBERSHIP/);
  });
});

test("Rev184 F3-residual: /os/admin with a READY current status renders READY through the real route", async () => {
  const source: OrganizationResourceBindingSource = {
    resolveStatus: () => ({
      tenantId: REVIEW_ORGANIZATION.tenantId,
      organizationId: REVIEW_ORGANIZATION.organizationId,
      state: "READY",
      nextRequiredActor: "NONE",
      unresolvedGates: [],
    }),
  };
  await withServer({ ...devDeps, resourceBindingSource: source }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`, { headers: { [STAFF_SESSION_TOKEN_HEADER]: FOUNDER_REVIEW_FIXTURE.sessionToken } });
    const body = await response.text();
    assert.match(body, /READY/);
  });
});
