import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as InternalOsAccess from "../src/web/internal-os-access.js";
import * as InternalOsViewState from "../src/web/internal-os-view-state.js";
import * as InternalOsRender from "../src/web/internal-os-render.js";
import * as InternalOsRequestHandler from "../src/web/internal-os-request-handler.js";
import * as InternalOsHttpServer from "../src/web/internal-os-http-server.js";
import * as InternalOsReviewFixtures from "../src/web/internal-os-review-fixtures.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const OS_V0_08_SOURCE_FILES = [
  "src/web/internal-os-access.ts",
  "src/web/internal-os-view-state.ts",
  "src/web/internal-os-render.ts",
  "src/web/internal-os-request-handler.ts",
  "src/web/internal-os-http-server.ts",
  "src/web/internal-os-review-fixtures.ts",
  "src/web/internal-os-dev-main.ts",
];

function readModule(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

test("OS-V0-08: only internal-os-http-server.ts imports node:http within this package's own surface - every other module is transport-agnostic", () => {
  const nonServerFiles = OS_V0_08_SOURCE_FILES.filter((path) => path !== "src/web/internal-os-http-server.ts");
  const violations: string[] = [];
  for (const relativePath of nonServerFiles) {
    const content = readModule(relativePath);
    if (/from ["']node:http["']/.test(content)) {
      violations.push(relativePath);
    }
  }
  assert.deepEqual(violations, []);
});

test("OS-V0-08: no source file in this package's surface introduces a new frontend framework, router library, templating engine, or raw secret/credential field", () => {
  const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "React/Vite/Next/frontend framework", pattern: /\b(react|vite|next\/|express|koa|fastify|hapi)\b/i },
    { label: "templating engine", pattern: /\b(handlebars|ejs|pug|nunjucks|mustache)\b/i },
    { label: "raw secret/credential field", pattern: /\b(apiKey|api_key|clientSecret|client_secret|privateKey|private_key|accessToken|access_token)\b/ },
    { label: "network/HTTP client other than node:http", pattern: /\b(axios|node-fetch|got\()\b/ },
  ];
  for (const relativePath of OS_V0_08_SOURCE_FILES) {
    const content = readModule(relativePath);
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${relativePath}`);
    }
  }
});

test("OS-V0-08: internal-os-access.ts never imports the Client Portal's customer session-context.ts/session-provider.ts/route-guard.ts - staff and customer identity domains never mix", () => {
  const content = readModule("src/web/internal-os-access.ts");
  assert.doesNotMatch(content, /from ["']\.\/session-context\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/session-provider\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/route-guard\.js["']/);
});

test("OS-V0-08: internal-os-request-handler.ts never imports the Client Portal's request-handler internals beyond the shared transport-agnostic types", () => {
  const content = readModule("src/web/internal-os-request-handler.ts");
  const requestHandlerImportLine = content.split("\n").find((line) => line.includes('from "./request-handler.js"'));
  assert.ok(requestHandlerImportLine !== undefined, "expected an import from request-handler.js for the shared transport types");
  assert.match(requestHandlerImportLine!, /^import type /, "the only import from request-handler.js must be type-only (IncomingRequestLike/OutgoingResponseLike)");
  assert.doesNotMatch(content, /from ["']\.\/snapshot-view-state\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/shell-render\.js["']/);
});

test("OS-V0-08: internal-os-review-fixtures.ts is never imported by internal-os-http-server.ts's production path composition - only internal-os-dev-main.ts (the dev-only entrypoint) wires it", () => {
  const serverContent = readModule("src/web/internal-os-http-server.ts");
  assert.doesNotMatch(serverContent, /internal-os-review-fixtures/);
  const devMainContent = readModule("src/web/internal-os-dev-main.ts");
  assert.match(devMainContent, /internal-os-review-fixtures/);
});

test("OS-V0-08: internal-os-dev-main.ts always passes isProduction: false and never reads a value that could flip it to true", () => {
  const content = readModule("src/web/internal-os-dev-main.ts");
  assert.match(content, /isProduction:\s*false/);
  assert.doesNotMatch(content, /isProduction:\s*process\.env/);
});

test("OS-V0-08: each module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(InternalOsAccess).sort(), [
    "InternalOsAccessDeniedError",
    "requireInternalOsAccess",
    "requireInternalOsProjectAccess",
  ]);
  assert.deepEqual(Object.keys(InternalOsViewState).sort(), [
    "NAV_DESTINATIONS",
    "isDestinationVisible",
    "resolveAdminView",
    "resolveHomeView",
    "resolveNavVisibility",
    "resolveNotActiveView",
    "resolvePeopleView",
    "resolveProductsView",
    "resolveWorkProjectDetailView",
    "resolveWorkView",
    "summarizeAccess",
    "summarizeOrganization",
  ]);
  assert.deepEqual(Object.keys(InternalOsRender).sort(), [
    "adminPageContent",
    "homePageContent",
    "notActiveDestinationPageContent",
    "peoplePageContent",
    "productsPageContent",
    "renderInternalOsPage",
    "workPageContent",
    "workProjectDetailPageContent",
  ]);
  assert.deepEqual(Object.keys(InternalOsRequestHandler).sort(), [
    "STAFF_SESSION_TOKEN_HEADER",
    "createInternalOsRequestHandler",
  ]);
  assert.deepEqual(Object.keys(InternalOsHttpServer).sort(), ["createInternalOsHttpServer"]);
  assert.deepEqual(Object.keys(InternalOsReviewFixtures).sort(), [
    "ALL_STAFF_REVIEW_FIXTURES",
    "FOUNDER_REVIEW_FIXTURE",
    "MEMBER_REVIEW_FIXTURE",
    "NEGATIVE_CUSTOMER_SESSION",
    "NEGATIVE_SERVICE_PRINCIPAL",
    "RESTRICTED_REVIEW_FIXTURE",
    "REVIEW_ORGANIZATION",
    "REVIEW_PROJECT_ALPHA",
    "REVIEW_PROJECT_BETA",
    "buildReviewStaffAccessGrants",
    "buildReviewStaffSessionFixtureMap",
    "buildReviewWorkJobSource",
    "buildReviewWorkProjectSource",
  ]);
});

test("OS-V0-08: package.json declares no new runtime dependency and no new devDependency", () => {
  const packageJson = JSON.parse(readModule("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
  assert.ok(packageJson.scripts?.["start:os-dev"] !== undefined, "expected a start:os-dev script for the local dogfood bootstrap");
});

test("OS-V0-08: no source file across this package's surface renders a raw <button> or <form> anywhere in its own template-literal text - Phase A exposes zero write/execute affordances", () => {
  const content = readModule("src/web/internal-os-render.ts");
  assert.doesNotMatch(content, /<button/i);
  assert.doesNotMatch(content, /<form\b/i);
});

test("OS-V0-08: the Client Portal's own boundary-scan-relevant files are untouched - V2-APP-001's shell/http-server/request-handler stay unmodified by this package", () => {
  // A weak but meaningful proof within a pure boundary-scan test (no git
  // diff access here): the Client Portal's own SESSION_TOKEN_HEADER constant
  // and portal path prefix must still be exactly what V2-APP-001 defined -
  // this package uses a DIFFERENT header/prefix (STAFF_SESSION_TOKEN_HEADER,
  // "/os/...") specifically so the two families can never collide.
  const clientHandler = readModule("src/web/request-handler.ts");
  assert.match(clientHandler, /x-akilta-session-token/);
  assert.doesNotMatch(clientHandler, /x-akilta-staff-session-token/);
  const internalHandler = readModule("src/web/internal-os-request-handler.ts");
  assert.match(internalHandler, /x-akilta-staff-session-token/);
});
