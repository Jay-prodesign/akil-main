import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readModule(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

test("WEBSITE-BUILD-DARK-ROUTE: src/web/http-server.ts never imports website-build-dark-route.ts", () => {
  const content = readModule("src/web/http-server.ts");
  assert.doesNotMatch(content, /website-build-dark-route/);
});

test("WEBSITE-BUILD-DARK-ROUTE: src/runtime/node-server-entrypoint.ts never imports website-build-dark-route.ts", () => {
  const content = readModule("src/runtime/node-server-entrypoint.ts");
  assert.doesNotMatch(content, /website-build-dark-route/);
});

test("WEBSITE-BUILD-DARK-ROUTE: the dark route module itself never imports node:http directly - it stays on the same transport-agnostic IncomingRequestLike/OutgoingResponseLike shapes as request-handler.ts", () => {
  const content = readModule("src/web/website-build-dark-route.ts");
  assert.doesNotMatch(content, /from ["']node:http["']/);
  assert.match(content, /from ["']\.\/request-handler\.js["']/);
});

test("WEBSITE-BUILD-DARK-ROUTE: the module exports exactly the expected surface", async () => {
  const mod = await import("../src/web/website-build-dark-route.js");
  assert.deepEqual(Object.keys(mod).sort(), [
    "WEBSITE_BUILD_DARK_APPROVE_PATH",
    "WEBSITE_BUILD_DARK_EXECUTE_PATH",
    "createWebsiteBuildDarkRequestHandler",
  ]);
});
