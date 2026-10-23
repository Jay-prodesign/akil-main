import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationMembership,
  revokeOrganizationMembership,
  type OrganizationMembership,
  type OrganizationRole,
} from "../src/domain/organization-membership.js";
import { FileDurableOrganizationMembershipStore } from "../src/domain/durable-organization-membership-store.js";
import { createDurablePeopleDirectorySource } from "../src/web/people-directory-durable-source.js";
import {
  NAV_DESTINATIONS,
  isDestinationVisible,
  resolvePeopleView,
  type PeopleDirectorySource,
  type PeopleViewState,
} from "../src/web/internal-os-view-state.js";
import { renderInternalOsPage, peoplePageContent } from "../src/web/internal-os-render.js";
import { requireInternalOsAccess } from "../src/web/internal-os-access.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
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
  RESTRICTED_REVIEW_FIXTURE,
} from "../src/web/internal-os-review-fixtures.js";

/**
 * C3 People slice (gap scan 2026-10-23): the `/os/people` membership
 * roster, backed by `PeopleDirectorySource` /
 * `createDurablePeopleDirectorySource` over
 * `FileDurableOrganizationMembershipStore`, added next to (not instead of)
 * the viewer's own membership.
 */

const REVIEW_TENANT = createTenantScope(REVIEW_ORGANIZATION.tenantId);
const REVOKED_REASON = "c3-people-revoked-reason-MUST-NOT-RENDER";
const REVOKED_AT = "2026-10-20T12:34:56.000Z";

/** The exact pre-C3 People body (OS-V0-08 `renderPeopleBody`). */
function preC3PeopleBody(displayName: string, role: string, state: string): string {
  return `
  <section aria-labelledby="people-heading" class="card">
    <h2 id="people-heading">You</h2>
    <p>${displayName}</p>
    <p>Organization role: ${role}</p>
    <p>Membership state: ${state}</p>
  </section>
  <p>A full directory is not yet available in this build.</p>`;
}

function membership(
  membershipId: string,
  principalRef: string,
  role: OrganizationRole = "STAFF",
  tenantId: string = REVIEW_ORGANIZATION.tenantId,
): OrganizationMembership {
  return createOrganizationMembership({ membershipId, tenantScope: createTenantScope(tenantId), principalRef, role });
}

function revoked(active: OrganizationMembership): OrganizationMembership {
  return revokeOrganizationMembership({ membership: active, revokedAt: REVOKED_AT, revokedReason: REVOKED_REASON });
}

function founderContext() {
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: buildReviewStaffSessionFixtureMap(),
    isProduction: false,
  });
  return requireInternalOsAccess({
    provider,
    sessionToken: FOUNDER_REVIEW_FIXTURE.sessionToken,
    organization: REVIEW_ORGANIZATION,
    grants: buildReviewStaffAccessGrants(),
  });
}

function sourceOf(memberships: ReadonlyArray<OrganizationMembership>): PeopleDirectorySource {
  return { listMemberships: () => memberships };
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "c3-people-"));
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

const headersFor = (token: string) => ({ [STAFF_SESSION_TOKEN_HEADER]: token });

// --- resolvePeopleView ---

test("C3P-V1: resolvePeopleView without a directory is exactly the pre-C3 value - self only, no roster key", () => {
  const view = resolvePeopleView({ context: founderContext() });
  assert.deepEqual(view, {
    kind: "READY",
    self: { principalDisplayName: "Founder Review", organizationRole: "STAFF", membershipState: "ACTIVE" },
  });
  assert.equal("roster" in view, false);
});

test("C3P-V2: resolvePeopleView with a directory keeps the self-section and adds every membership, allow-listed and sorted", () => {
  const source = sourceOf([
    membership("m-zed", "principal-zed", "CLIENT_ASSOCIATE"),
    revoked(membership("m-gone", "principal-gone", "JUNIOR")),
    membership("m-amy", "principal-amy", "STUDENT"),
  ]);
  const view = resolvePeopleView({ context: founderContext(), directory: { organization: REVIEW_ORGANIZATION, source } });
  assert.deepEqual(view.self, { principalDisplayName: "Founder Review", organizationRole: "STAFF", membershipState: "ACTIVE" });
  assert.deepEqual(view.roster, {
    kind: "READY",
    members: [
      { principalRef: "principal-amy", organizationRole: "STUDENT", membershipState: "ACTIVE" },
      { principalRef: "principal-gone", organizationRole: "JUNIOR", membershipState: "REVOKED" },
      { principalRef: "principal-zed", organizationRole: "CLIENT_ASSOCIATE", membershipState: "ACTIVE" },
    ],
  });
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /MUST-NOT-RENDER|revokedReason|revokedAt|2026-10-20/);
  assert.doesNotMatch(json, /m-zed|m-gone|m-amy|membershipId|tenantId/);
});

test("C3P-V3: resolvePeopleView passes the page's own Organization to the source", () => {
  const seen: string[] = [];
  const source: PeopleDirectorySource = {
    listMemberships: (organization) => {
      seen.push(organization.organizationId);
      return [];
    },
  };
  resolvePeopleView({ context: founderContext(), directory: { organization: REVIEW_ORGANIZATION, source } });
  assert.deepEqual(seen, [REVIEW_ORGANIZATION.organizationId]);
});

test("C3P-V4: a source that returns no memberships is a READY, empty roster - not absent and not ERROR", () => {
  const view = resolvePeopleView({ context: founderContext(), directory: { organization: REVIEW_ORGANIZATION, source: sourceOf([]) } });
  assert.deepEqual(view.roster, { kind: "READY", members: [] });
});

test("C3P-V5: a throwing source is a roster ERROR - a read failure is never relabeled as an empty roster", () => {
  const source: PeopleDirectorySource = {
    listMemberships: () => {
      throw new Error("disk on fire");
    },
  };
  const view = resolvePeopleView({ context: founderContext(), directory: { organization: REVIEW_ORGANIZATION, source } });
  assert.deepEqual(view.roster, { kind: "ERROR" });
  assert.equal(view.self.principalDisplayName, "Founder Review");
});

test("C3P-V6: a foreign tenant's membership fails the roster closed to ERROR, never a silently filtered (or empty) list", () => {
  const own = membership("m-own", "principal-own");
  const foreign = membership("m-foreign", "principal-foreign", "STAFF", "tenant-c3-people-foreign");
  for (const memberships of [[own, foreign], [foreign]]) {
    const view = resolvePeopleView({
      context: founderContext(),
      directory: { organization: REVIEW_ORGANIZATION, source: sourceOf(memberships) },
    });
    assert.deepEqual(view.roster, { kind: "ERROR" });
  }
});

// --- peoplePageContent ---

test("C3P-R1: no roster renders the pre-C3 People body byte for byte (self-section regression)", () => {
  const view: PeopleViewState = { kind: "READY", self: { principalDisplayName: "Jane Staff", organizationRole: "STAFF", membershipState: "ACTIVE" } };
  const rendered = renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", view));
  assert.equal(rendered.status, 200);
  assert.ok(rendered.html.includes(preC3PeopleBody("Jane Staff", "STAFF", "ACTIVE")));
  assert.doesNotMatch(rendered.html, /people-directory-heading/);
});

test("C3P-R2: a roster ERROR renders the OS ERROR page (500) with no self data and no roster", () => {
  const view: PeopleViewState = {
    kind: "READY",
    self: { principalDisplayName: "Jane Staff", organizationRole: "STAFF", membershipState: "ACTIVE" },
    roster: { kind: "ERROR" },
  };
  const rendered = renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", view));
  assert.equal(rendered.status, 500);
  assert.match(rendered.html, /Something went wrong/);
  assert.doesNotMatch(rendered.html, /Jane Staff|No memberships are recorded|Directory/);
});

test("C3P-R3: an empty READY roster says no memberships are recorded, and keeps the self-section", () => {
  const view: PeopleViewState = {
    kind: "READY",
    self: { principalDisplayName: "Jane Staff", organizationRole: "STAFF", membershipState: "ACTIVE" },
    roster: { kind: "READY", members: [] },
  };
  const rendered = renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", view));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /Jane Staff/);
  assert.match(rendered.html, /No memberships are recorded for this organization/);
  assert.doesNotMatch(rendered.html, /directory is not yet available/);
});

test("C3P-R4: a READY roster renders every field HTML-escaped, with a visible state label and no mutation control", () => {
  const view: PeopleViewState = {
    kind: "READY",
    self: { principalDisplayName: "Self <b>me</b>", organizationRole: "STAFF", membershipState: "ACTIVE" },
    roster: {
      kind: "READY",
      members: [
        { principalRef: "principal-<script>alert(1)</script>", organizationRole: "STAFF", membershipState: "ACTIVE" },
        { principalRef: "principal-\"quoted\"&amp", organizationRole: "JUNIOR", membershipState: "REVOKED" },
      ],
    },
  };
  const rendered = renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", view));
  assert.equal(rendered.status, 200);
  assert.match(rendered.html, /Self &lt;b&gt;me&lt;\/b&gt;/);
  assert.match(rendered.html, /principal-&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered.html, /<script>alert/);
  assert.match(rendered.html, /principal-&quot;quoted&quot;&amp;amp/);
  assert.match(rendered.html, /<td>JUNIOR<\/td>/);
  assert.match(rendered.html, /<span class="status status-neutral" role="status">ACTIVE<\/span>/);
  assert.match(rendered.html, /<span class="status status-danger" role="status">REVOKED<\/span>/);
  assert.match(rendered.html, /aria-current="page">People</);
  assert.doesNotMatch(rendered.html, /directory is not yet available/);
  assert.doesNotMatch(rendered.html, /<button/i);
  assert.doesNotMatch(rendered.html, /<form/i);
});

test("C3P-R5: a revoked membership's reason, timestamp and internal ids never reach the rendered page", () => {
  const source = sourceOf([revoked(membership("m-secret-id-c3", "principal-revoked")), membership("m-other-id-c3", "principal-active")]);
  const view = resolvePeopleView({ context: founderContext(), directory: { organization: REVIEW_ORGANIZATION, source } });
  const html = renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", view)).html;
  assert.match(html, /principal-revoked/);
  assert.match(html, /principal-active/);
  assert.doesNotMatch(html, /MUST-NOT-RENDER|2026-10-20|m-secret-id-c3|m-other-id-c3|tenant-os-v0-08-review/);
});

// --- createDurablePeopleDirectorySource over the real store ---

test("C3P-S1: createDurablePeopleDirectorySource returns the tenant's stored memberships from the real store, and nothing from another tenant", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOrganizationMembershipStore(dir);
    store.create(membership("m-s1-a", "principal-s1-a"));
    const b = store.create(membership("m-s1-b", "principal-s1-b", "JUNIOR"));
    store.revoke({
      tenantId: REVIEW_TENANT.tenantId,
      membershipId: b.membership.membershipId,
      expectedVersion: b.version,
      revokedAt: REVOKED_AT,
      revokedReason: REVOKED_REASON,
    });
    store.create(membership("m-s1-foreign", "principal-s1-foreign", "STAFF", "tenant-c3-people-other"));
    const listed = createDurablePeopleDirectorySource(store).listMemberships(REVIEW_ORGANIZATION);
    assert.deepEqual(
      listed.map((m) => [m.principalRef, m.state]).sort(),
      [
        ["principal-s1-a", "ACTIVE"],
        ["principal-s1-b", "REVOKED"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3P-S2: createDurablePeopleDirectorySource propagates a corrupted tenant file as a throw (never an empty list)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOrganizationMembershipStore(dir);
    writeFileSync(tenantFilePath(dir, REVIEW_ORGANIZATION.tenantId), "{ not json", "utf8");
    const source = createDurablePeopleDirectorySource(store);
    assert.throws(() => source.listMemberships(REVIEW_ORGANIZATION), { name: "CorruptedOrganizationMembershipFileError" });
    const view = resolvePeopleView({ context: founderContext(), directory: { organization: REVIEW_ORGANIZATION, source } });
    assert.deepEqual(view.roster, { kind: "ERROR" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the real /os/people route ---

test("C3P-H1: /os/people with no peopleDirectorySource wired renders the pre-C3 self-only page", async () => {
  await withServer(devDeps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/os/people`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
    assert.equal(response.status, 200);
    const body = await response.text();
    const expected = renderInternalOsPage(
      peoplePageContent(NAV_DESTINATIONS, REVIEW_ORGANIZATION.displayName, resolvePeopleView({ context: founderContext() })),
    );
    assert.equal(body, expected.html);
    assert.ok(body.includes(preC3PeopleBody("Founder Review", "STAFF", "ACTIVE")));
  });
});

test("C3P-H2: /os/people with a durable source renders the full roster through the real route, next to an unchanged self-section", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOrganizationMembershipStore(dir);
    store.create(membership("membership-founder", "staff-founder"));
    store.create(membership("membership-h2-junior", "staff-h2-junior", "JUNIOR"));
    const leaver = store.create(membership("membership-h2-leaver", "staff-h2-leaver", "STUDENT"));
    store.revoke({
      tenantId: REVIEW_TENANT.tenantId,
      membershipId: leaver.membership.membershipId,
      expectedVersion: leaver.version,
      revokedAt: REVOKED_AT,
      revokedReason: REVOKED_REASON,
    });
    store.create(membership("membership-h2-foreign", "staff-h2-foreign", "STAFF", "tenant-c3-people-h2-foreign"));
    await withServer({ ...devDeps, peopleDirectorySource: createDurablePeopleDirectorySource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/people`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
      assert.equal(response.status, 200);
      const body = await response.text();
      // Self-section unchanged.
      assert.ok(
        body.includes(`
  <section aria-labelledby="people-heading" class="card">
    <h2 id="people-heading">You</h2>
    <p>Founder Review</p>
    <p>Organization role: STAFF</p>
    <p>Membership state: ACTIVE</p>
  </section>`),
      );
      assert.match(body, /<td>staff-founder<\/td><td>STAFF<\/td>/);
      assert.match(body, /<td>staff-h2-junior<\/td><td>JUNIOR<\/td>/);
      assert.match(body, /<td>staff-h2-leaver<\/td><td>STUDENT<\/td><td><span class="status status-danger" role="status">REVOKED<\/span>/);
      assert.doesNotMatch(body, /staff-h2-foreign/);
      assert.doesNotMatch(body, /MUST-NOT-RENDER|2026-10-20|membership-h2-/);
      assert.doesNotMatch(body, /directory is not yet available/);
      assert.doesNotMatch(body, /<button/i);
      assert.doesNotMatch(body, /<form/i);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3P-H3: /os/people over a corrupted store file renders the OS ERROR page (500), not an empty roster, and the server keeps serving", async () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableOrganizationMembershipStore(dir);
    writeFileSync(tenantFilePath(dir, REVIEW_ORGANIZATION.tenantId), "[]", "utf8");
    await withServer({ ...devDeps, peopleDirectorySource: createDurablePeopleDirectorySource(store) }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/os/people`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /AKILTA OS/);
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /No memberships are recorded|Founder Review/);
      assert.doesNotMatch(body, /Corrupted|JSON object/);
      const home = await fetch(`${baseUrl}/os/home`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
      assert.equal(home.status, 200);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3P-H4: access is unchanged and fail-closed before the source is ever read - unauthenticated is 401 and a session with no membership is 403, with zero source reads", async () => {
  let reads = 0;
  const source: PeopleDirectorySource = {
    listMemberships: () => {
      reads += 1;
      return [membership("m-h4", "principal-h4-MUST-NOT-RENDER")];
    },
  };
  // The Member fixture's session still authenticates, but its grant is removed.
  const grantsWithoutMember = buildReviewStaffAccessGrants().filter(
    (grant) => grant.membership.membershipId !== MEMBER_REVIEW_FIXTURE.grant.membership.membershipId,
  );
  await withServer({ ...devDeps, grants: grantsWithoutMember, peopleDirectorySource: source }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/os/people`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /principal-h4/);
    const noMembership = await fetch(`${baseUrl}/os/people`, { headers: headersFor(MEMBER_REVIEW_FIXTURE.sessionToken) });
    assert.equal(noMembership.status, 403);
    assert.doesNotMatch(await noMembership.text(), /principal-h4/);
    assert.equal(reads, 0);
  });
});

test("C3P-H5: the people DESTINATION gate is unchanged (every GRANTED fixture still reaches it), but the ROSTER additionally requires WRITE - a READ-only fixture gets the unchanged self-only page, never a 403", async () => {
  for (const fixture of [MEMBER_REVIEW_FIXTURE, RESTRICTED_REVIEW_FIXTURE]) {
    assert.equal(fixture.grant.authority.permissions.has("WRITE"), false, "precondition: READ-only fixture");
  }
  assert.equal(FOUNDER_REVIEW_FIXTURE.grant.authority.permissions.has("WRITE"), true, "precondition: WRITE-capable fixture");
  const source = sourceOf([membership("m-h5", "principal-h5")]);
  await withServer({ ...devDeps, peopleDirectorySource: source }, async (baseUrl) => {
    for (const fixture of [MEMBER_REVIEW_FIXTURE, RESTRICTED_REVIEW_FIXTURE]) {
      const response = await fetch(`${baseUrl}/os/people`, { headers: headersFor(fixture.sessionToken) });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /href="\/os\/people"/);
      assert.ok(body.includes(`<p>${fixture.session.principal.displayName}</p>`));
      // READ-only: destination reached, but no roster - exactly the pre-C3 page.
      assert.doesNotMatch(body, /principal-h5/);
      assert.match(body, /directory is not yet available/);
    }
    // WRITE-capable: destination reached AND the roster is included.
    const founder = await fetch(`${baseUrl}/os/people`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
    assert.equal(founder.status, 200);
    assert.match(await founder.text(), /principal-h5/);
  });
  // The destination policy function itself still answers `true` for every GRANTED context, READ or WRITE.
  assert.equal(isDestinationVisible("people", founderContext()), true);
});

test("C3P-H6: the source is read only on /os/people - every other destination is unaffected and never reads it", async () => {
  let reads = 0;
  const source: PeopleDirectorySource = {
    listMemberships: () => {
      reads += 1;
      return [membership("m-h6", "principal-h6-only-on-people")];
    },
  };
  await withServer({ ...devDeps, peopleDirectorySource: source }, async (baseUrl) => {
    for (const path of ["/os/home", "/os/work", "/os/attention", "/os/ai-capabilities", "/os/connections", "/os/knowledge", "/os/products", "/os/admin"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
      assert.equal(response.status, 200, path);
      assert.doesNotMatch(await response.text(), /principal-h6/, path);
    }
    assert.equal(reads, 0);
    const people = await fetch(`${baseUrl}/os/people`, { headers: headersFor(FOUNDER_REVIEW_FIXTURE.sessionToken) });
    assert.match(await people.text(), /principal-h6-only-on-people/);
    assert.equal(reads, 1);
  });
});
