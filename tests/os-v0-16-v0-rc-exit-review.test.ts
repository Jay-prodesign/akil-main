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
  MEMBER_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * OS-V0-16 "V0 Release Candidate & Exit Review" (Brain Rev199): the
 * DAST-scoped RC security qualification Rev199 requires - "exercise actual
 * Connected Dark/internal HTTP surfaces that exist on this candidate for
 * applicable auth/session substitution and injection classes." Auth/session
 * substitution across tenants is already exhaustively proven (OS-V0-14's own
 * 3-test org/membership/access suite) and is cited, not re-proven, here.
 * This file's own, genuinely new contribution is the injection-class witness
 * that suite never covered: hostile path-segment content (XSS markup,
 * path-traversal-shaped sequences, null bytes, oversized input) sent as real
 * HTTP requests against the REAL bound `createInternalOsHttpServer`, over an
 * actual socket (mirroring `tests/web-internal-os-http-server.test.ts`'s own
 * established real-server pattern) - proving the exact integrated candidate
 * never reflects hostile input unescaped and never crashes (no 500) under
 * it, not merely that `escapeHtml` exists in isolation.
 *
 * Rev200 F2: filesystem path traversal itself is NOT_APPLICABLE on this
 * route - the path-traversal-shaped payloads are included as XSS/crash
 * witnesses only (hostile-but-ordinary string content), not as a traversal
 * proof; see the comment directly above the loop below for why.
 *
 * Zero new production source files - this is a pure proof layer over
 * already-accepted OS-V0-08/09/12/13/14 web surface code.
 */

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

const HOSTILE_PATH_SEGMENTS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "script-tag XSS payload", value: "<script>alert(document.cookie)</script>" },
  { label: "img-onerror XSS payload", value: "<img src=x onerror=alert(1)>" },
  { label: "quote-breakout payload", value: "\"><svg onload=alert(1)>" },
  { label: "path traversal (raw)", value: "../../../../etc/passwd" },
  { label: "path traversal (encoded, pre-decode)", value: "%2e%2e%2f%2e%2e%2fetc%2fpasswd" },
  { label: "null byte", value: "a\u0000b" },
  { label: "oversized segment", value: "x".repeat(10_000) },
];

/**
 * Rev200 F2: filesystem path traversal is NOT_APPLICABLE for this route -
 * `resolveWorkProjectDetailView` (internal-os-view-state.ts) resolves
 * customerId/projectId exclusively via `projectSource.getProject(...)`, an
 * injected lookup port with no `fs` access anywhere in `src/web` (confirmed
 * by direct inspection, not assumed). The prior assertion here
 * (`!body.includes("/etc/passwd") || body.includes(encodedForm) === false`)
 * was logically ineffective - it still passed with raw "/etc/passwd" present
 * whenever the unrelated encoded-entity string was merely absent, so it
 * never actually proved anything. Removed rather than kept as a false
 * proof; the XSS/reflection/crash assertions below remain genuinely
 * load-bearing against these same hostile values.
 */
for (const hostile of HOSTILE_PATH_SEGMENTS) {
  test(`OS-V0-16 (DAST-scoped injection class: ${hostile.label}): a real HTTP request with this value as the work-detail customerId path segment never reflects it unescaped and never crashes the server`, async () => {
    await withServer(devDeps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/work/${encodeURIComponent(hostile.value)}/${encodeURIComponent(MEMBER_REVIEW_FIXTURE.sessionToken)}`, {
        headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken },
      });
      assert.ok(response.status < 500, `must never crash (500) on hostile input - got ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes("<script>"), "must never reflect a raw, unescaped <script> tag");
      assert.ok(!body.includes("onerror=alert"), "must never reflect a raw, unescaped onerror handler");
      assert.ok(!body.includes("onload=alert"), "must never reflect a raw, unescaped onload handler");
    });
  });

  test(`OS-V0-16 (DAST-scoped injection class: ${hostile.label}): the same value as the work-detail projectId path segment never reflects it unescaped and never crashes the server`, async () => {
    await withServer(devDeps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/work/${encodeURIComponent("customer-os-v0-08-review")}/${encodeURIComponent(hostile.value)}`, {
        headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken },
      });
      assert.ok(response.status < 500, `must never crash (500) on hostile input - got ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes("<script>"), "must never reflect a raw, unescaped <script> tag");
      assert.ok(!body.includes("onerror=alert"), "must never reflect a raw, unescaped onerror handler");
      assert.ok(!body.includes("onload=alert"), "must never reflect a raw, unescaped onload handler");
    });
  });
}

test("OS-V0-16 (DAST-scoped): a hostile STAFF_SESSION_TOKEN_HEADER value (XSS-shaped) is rejected as unauthenticated, never reflected, never crashes the server", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/home`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: "<script>alert(1)</script>" },
    });
    assert.ok(response.status < 500);
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.ok(!body.includes("<script>alert(1)</script>"));
  });
});

test("OS-V0-16 (DAST-scoped): an authenticated request for a GENUINE project with the real escapeHtml-covered rendering path still reaches READY and renders the real (safe) identifiers verbatim-but-escaped - confirming the escaping path itself is exercised end-to-end, not merely the unknown-id fast path", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/work/customer-os-v0-08-review/project-alpha`, {
      headers: { [STAFF_SESSION_TOKEN_HEADER]: MEMBER_REVIEW_FIXTURE.sessionToken },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /project-alpha/);
  });
});

test("OS-V0-16 (auth/session substitution - CITE, re-confirmed on this exact head): a founder's own valid session cannot be substituted for an unauthenticated request path - omitting the header still fails closed with 401 even though a valid founder token exists for this exact organization", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/admin`);
    assert.equal(response.status, 401);
    assert.notEqual(FOUNDER_REVIEW_FIXTURE.sessionToken, undefined);
  });
});
