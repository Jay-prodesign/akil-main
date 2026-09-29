import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderInternalOsPage,
  homePageContent,
  workPageContent,
  workProjectDetailPageContent,
  notActiveDestinationPageContent,
  peoplePageContent,
  productsPageContent,
  adminPageContent,
} from "../src/web/internal-os-render.js";
import { NAV_DESTINATIONS } from "../src/web/internal-os-view-state.js";
import type { HomeViewState, WorkViewState, PeopleViewState, ProductsViewState, AdminViewState } from "../src/web/internal-os-view-state.js";

const ORG_NAME = "AKILTA <Test> & \"Org\"";

test("UNAUTHENTICATED renders 401 with visible sign-in-required text, and empty nav", () => {
  const rendered = renderInternalOsPage({ kind: "UNAUTHENTICATED" });
  assert.equal(rendered.status, 401);
  assert.match(rendered.html, /Sign-in required/);
  assert.doesNotMatch(rendered.html, /class="nav-item"/);
});

test("FORBIDDEN renders 403 with visible access-denied text", () => {
  const rendered = renderInternalOsPage({ kind: "FORBIDDEN" });
  assert.equal(rendered.status, 403);
  assert.match(rendered.html, /Access denied/);
});

test("NOT_FOUND renders 404", () => {
  const rendered = renderInternalOsPage({ kind: "NOT_FOUND" });
  assert.equal(rendered.status, 404);
});

test("ERROR renders 500 without leaking any data", () => {
  const rendered = renderInternalOsPage({ kind: "ERROR", reason: "internal detail that must not leak" });
  assert.equal(rendered.status, 500);
  assert.doesNotMatch(rendered.html, /internal detail that must not leak/);
});

test("organization display name and destination titles are HTML-escaped, never raw-injected", () => {
  const view: HomeViewState = {
    kind: "READY",
    organization: { displayName: ORG_NAME, state: "ACTIVE" },
    access: { role: "MEMBER", permissions: ["READ"], canPerformProtectedActions: false },
    work: { kind: "NOT_ACTIVE" },
  };
  const rendered = renderInternalOsPage(homePageContent(NAV_DESTINATIONS, ORG_NAME, view));
  assert.equal(rendered.status, 200);
  assert.doesNotMatch(rendered.html, /<Test>/);
  assert.match(rendered.html, /&lt;Test&gt;/);
  assert.match(rendered.html, /&quot;Org&quot;/);
});

test("all 9 nav destinations render as links when access is fully granted, with the active one marked aria-current", () => {
  const view: HomeViewState = {
    kind: "READY",
    organization: { displayName: "Org", state: "ACTIVE" },
    access: { role: "MEMBER", permissions: ["READ"], canPerformProtectedActions: false },
    work: { kind: "NOT_ACTIVE" },
  };
  const rendered = renderInternalOsPage(homePageContent(NAV_DESTINATIONS, "Org", view));
  for (const destination of NAV_DESTINATIONS) {
    assert.match(rendered.html, new RegExp(`href="${destination.path}"`));
  }
  assert.match(rendered.html, /aria-current="page"[^>]*>Home<\/a>|Home<\/a>[^<]*aria-current/);
});

test("Work NOT_ACTIVE renders a truthful NOT ACTIVE status, never a fabricated project list", () => {
  const view: WorkViewState = { kind: "NOT_ACTIVE" };
  const rendered = renderInternalOsPage(workPageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /NOT ACTIVE/);
});

test("Work EMPTY renders a truthful no-assigned-projects message", () => {
  const view: WorkViewState = { kind: "EMPTY" };
  const rendered = renderInternalOsPage(workPageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /no assigned projects/i);
});

test("Work READY renders each project as a linked card with its job table", () => {
  const view: WorkViewState = {
    kind: "READY",
    projects: [
      {
        customerId: "cust-1",
        projectId: "proj-1",
        state: "active",
        jobs: { kind: "READY", jobs: [{ jobId: "job-1", jobFamily: "WEBSITE_BUILD", state: "EXECUTING" }] },
      },
    ],
  };
  const rendered = renderInternalOsPage(workPageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /href="\/os\/work\/cust-1\/proj-1"/);
  assert.match(rendered.html, /job-1/);
  assert.match(rendered.html, /EXECUTING/);
});

test("workProjectDetailPageContent NOT_FOUND/FORBIDDEN/NOT_ACTIVE each render distinct, truthful text", () => {
  const notFound = renderInternalOsPage(workProjectDetailPageContent(NAV_DESTINATIONS, "Org", { kind: "NOT_FOUND" }));
  assert.match(notFound.html, /could not find this project/);
  const forbidden = renderInternalOsPage(workProjectDetailPageContent(NAV_DESTINATIONS, "Org", { kind: "FORBIDDEN" }));
  assert.match(forbidden.html, /do not have access/);
  const notActive = renderInternalOsPage(workProjectDetailPageContent(NAV_DESTINATIONS, "Org", { kind: "NOT_ACTIVE" }));
  assert.match(notActive.html, /NOT ACTIVE/);
});

test("attention/ai-capabilities/connections/knowledge all render a truthful NOT ACTIVE state with their own label", () => {
  for (const key of ["attention", "ai-capabilities", "connections", "knowledge"] as const) {
    const rendered = renderInternalOsPage(notActiveDestinationPageContent(NAV_DESTINATIONS, "Org", key));
    assert.match(rendered.html, /NOT ACTIVE/);
  }
});

test("People renders only the current viewer's own membership fields", () => {
  const view: PeopleViewState = { kind: "READY", self: { principalDisplayName: "Jane Staff", organizationRole: "STAFF", membershipState: "ACTIVE" } };
  const rendered = renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /Jane Staff/);
  assert.match(rendered.html, /directory is not yet available/i);
});

test("Products marks only this shell ACTIVE and everything else NOT_ACTIVE, with visible (not color-only) status text", () => {
  const view: ProductsViewState = {
    kind: "READY",
    products: [
      { name: "AKILTA OS (this internal shell)", status: "ACTIVE" },
      { name: "AKILTA Commerce", status: "NOT_ACTIVE" },
    ],
  };
  const rendered = renderInternalOsPage(productsPageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /ACTIVE/);
  assert.match(rendered.html, /NOT ACTIVE/);
});

test("Admin renders the organization/access it was given plus every NOT_ACTIVE concept as visible text", () => {
  const view: AdminViewState = {
    kind: "READY",
    organization: { displayName: "Org", state: "ACTIVE" },
    access: { role: "ADMIN", permissions: ["READ"], canPerformProtectedActions: false },
    notActiveConcepts: ["Workers", "Connections", "Policies"],
  };
  const rendered = renderInternalOsPage(adminPageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /Workers/);
  assert.match(rendered.html, /Connections/);
  assert.match(rendered.html, /Policies/);
  assert.match(rendered.html, /NOT ACTIVE/);
});

test("every rendered page carries a skip link and semantic header/nav/main landmarks", () => {
  const view: HomeViewState = {
    kind: "READY",
    organization: { displayName: "Org", state: "ACTIVE" },
    access: { role: "MEMBER", permissions: ["READ"], canPerformProtectedActions: false },
    work: { kind: "NOT_ACTIVE" },
  };
  const rendered = renderInternalOsPage(homePageContent(NAV_DESTINATIONS, "Org", view));
  assert.match(rendered.html, /class="skip-link" href="#main-content"/);
  assert.match(rendered.html, /<header/);
  assert.match(rendered.html, /<nav /);
  assert.match(rendered.html, /id="main-content"/);
});

test("no rendered page across any content kind ever contains a mutating form or button - Phase A exposes zero write/execute affordances", () => {
  const homeView: HomeViewState = {
    kind: "READY",
    organization: { displayName: "Org", state: "ACTIVE" },
    access: { role: "OWNER", permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true },
    work: {
      kind: "READY",
      projects: [{ customerId: "c1", projectId: "p1", state: "active", jobs: { kind: "READY", jobs: [] } }],
    },
  };
  const pages = [
    renderInternalOsPage(homePageContent(NAV_DESTINATIONS, "Org", homeView)),
    renderInternalOsPage(workPageContent(NAV_DESTINATIONS, "Org", homeView.work)),
    renderInternalOsPage(peoplePageContent(NAV_DESTINATIONS, "Org", { kind: "READY", self: { principalDisplayName: "X", organizationRole: "STAFF", membershipState: "ACTIVE" } })),
    renderInternalOsPage(productsPageContent(NAV_DESTINATIONS, "Org", { kind: "READY", products: [{ name: "X", status: "ACTIVE" }] })),
    renderInternalOsPage(adminPageContent(NAV_DESTINATIONS, "Org", { kind: "READY", organization: { displayName: "Org", state: "ACTIVE" }, access: { role: "OWNER", permissions: ["READ", "WRITE", "EXECUTE"], canPerformProtectedActions: true }, notActiveConcepts: ["Workers"] })),
  ];
  for (const page of pages) {
    assert.doesNotMatch(page.html, /<button/i);
    assert.doesNotMatch(page.html, /<form/i);
  }
});
