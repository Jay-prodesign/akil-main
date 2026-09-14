import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ServiceCatalogAdmission from "../src/domain/service-catalog-admission.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SVC_ADM_FILE = "src/domain/service-catalog-admission.ts";

test("SVC-ADM-001: imports only sibling domain modules by type - no filesystem, network, or new catalog/orchestration coupling", () => {
  const content = readFileSync(join(REPO_ROOT, SVC_ADM_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { CommercialOrder, ServiceCatalogEntry, DeclaredServiceLookupResult } from "./commercial-order.js";',
    'import type { OfferBlueprintVersion } from "./offer-blueprint.js";',
    'import type { DeliveryRecipe } from "./delivery-recipe.js";',
    'import type { AdmittedWorker } from "./worker-routing-policy.js";',
  ]);
});

test("SVC-ADM-001: never calls Date.now(), fetch, or a node: builtin - every timestamp/evidence is caller-supplied", () => {
  const content = readFileSync(join(REPO_ROOT, SVC_ADM_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("SVC-ADM-001: does not redefine CommercialOrder, ServiceCatalogEntry, DeclaredServiceLookupResult, or AdmittedWorker - composes commercial-order.ts and worker-routing-policy.ts unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, SVC_ADM_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+CommercialOrder\b/);
  assert.doesNotMatch(content, /interface\s+ServiceCatalogEntry\b/);
  assert.doesNotMatch(content, /type\s+DeclaredServiceLookupResult\b/);
  assert.doesNotMatch(content, /interface\s+AdmittedWorker\b/);
});

test("Rev102 F2: admitServiceCatalogEntry gates on both trustStatus ADMITTED and authorityLevel ELEVATED - an unproven caller label cannot silently become trusted authority", () => {
  const content = readFileSync(join(REPO_ROOT, SVC_ADM_FILE), "utf8");
  assert.match(content, /authorizingWorker\.trustStatus !== "ADMITTED"/);
  assert.match(content, /authorizingWorker\.authorityLevel !== "ELEVATED"/);
});

test("SVC-ADM-001: NOT_ADMITTED is a first-class disposition distinct from RESOLVED - the gap-behavior contract Family 1 requires", () => {
  const content = readFileSync(join(REPO_ROOT, SVC_ADM_FILE), "utf8");
  assert.match(content, /"NOT_ADMITTED"/);
  assert.match(content, /"RESOLVED"/);
});

test("SVC-ADM-001: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(ServiceCatalogAdmission).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidServiceCatalogAdmissionError",
    "InvalidServiceCatalogAdmissionTransitionError",
    "admitServiceCatalogEntry",
    "resolveTrustedServiceForOrder",
    "revokeServiceCatalogAdmission",
  ]);
});

test("SVC-ADM-001: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@types/node", "typescript"],
  );
});
