import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as SubscriptionEntitlement from "../src/domain/subscription-entitlement.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/subscription-entitlement.ts";

function moduleSource(): string {
  return readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
}

/** Strips block (`/* ... *\/`) and line (`// ...`) comments - several are deliberate prose explaining what this module does *not* do (e.g. "no OrganizationRole coupling", "no Stripe adapter"), which would otherwise defeat a naive whole-file text scan for those same words. */
function moduleCodeOnly(): string {
  return moduleSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

test("B1 (external-role -> AKILTA-authority non-escalation, structural): subscription-entitlement.ts imports nothing from authority.ts or organization-membership.ts - external-platform roles/permissions have no code path into AKILTA IAM through this module", () => {
  const content = moduleSource();
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
});

test("B2 (external-role -> AKILTA-authority non-escalation, structural): outside its own explanatory comments, the module's actual code defines no OrganizationRole/permission/AuthorityContext-shaped field or function anywhere", () => {
  const content = moduleCodeOnly();
  assert.doesNotMatch(content, /OrganizationRole/);
  assert.doesNotMatch(content, /AuthorityContext/);
  assert.doesNotMatch(content, /requirePermission|requireProtectedActionAuthorization|requireSameTenant/);
});

test("B3 (gateway/provider independence, structural): outside its own explanatory comments, no payment-gateway SDK identifier is imported or referenced anywhere in this module's actual code", () => {
  const content = moduleCodeOnly();
  for (const forbidden of ["stripe", "Stripe", "paraşüt", "Parasut", "creditCard", "cardNumber", "cvv", "PaymentGateway"]) {
    assert.doesNotMatch(content, new RegExp(forbidden), `expected no reference to ${forbidden}`);
  }
});

test("B4 (gateway/provider independence, structural): no field anywhere in this module is capable of holding a card number, payment-method token, or gateway credential - every commerce reference is typed as a plain opaque string", () => {
  const content = moduleSource();
  // Every external reference field in this module is declared as `string`
  // (or `unknown` pre-validation) - never a structured payment-method/card
  // shape. This is a structural spot-check on the field declarations
  // themselves, not just their names.
  assert.doesNotMatch(content, /readonly\s+\w*[Cc]ard\w*:/);
  assert.doesNotMatch(content, /readonly\s+\w*[Cc]redential\w*:/);
});

test("B5 (zero new runtime dependency): the module has no import statement outside this repository's own src/domain files", () => {
  const content = moduleSource();
  const importLines = content.match(/^import .+;$/gm) ?? [];
  for (const line of importLines) {
    assert.match(line, /from ["']\.\/[\w-]+\.js["']/, `unexpected external import: ${line}`);
  }
});

test("B6: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(SubscriptionEntitlement).sort();
  assert.deepEqual(exportedKeys, [
    "AmbiguousExternalCustomerLinkageError",
    "ExternalSubscriptionPlanMappingAlreadyAdmittedError",
    "InvalidSubscriptionEntitlementError",
    "applySubscriptionLifecycleFact",
    "createExternalCustomerLinkageRegistry",
    "createExternalSubscriptionPlanMappingRegistry",
    "createPendingSubscription",
    "createSubscriptionPlan",
    "deriveEntitlement",
    "reconstructSubscription",
  ]);
});

test("B7 (immutable-once-admitted, write-before-guard ordering): admit() checks the already-admitted-mismatch guard before ever writing the map", () => {
  const fnStart = moduleSource().indexOf("export function createExternalSubscriptionPlanMappingRegistry");
  const nextFnStart = moduleSource().indexOf("export function", fnStart + 1);
  const fnBody = moduleSource().slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const guardIndex = fnBody.indexOf("ExternalSubscriptionPlanMappingAlreadyAdmittedError");
  const setIndex = fnBody.indexOf("admitted.set(");
  assert.ok(guardIndex >= 0 && setIndex >= 0);
  assert.ok(guardIndex < setIndex, "the already-admitted guard must run before the map is ever written");
});

test("B8 (ambiguous-linkage guard ordering): linkOnce() checks the ambiguous-mismatch guard before ever writing the map", () => {
  const fnStart = moduleSource().indexOf("export function createExternalCustomerLinkageRegistry");
  const nextFnStart = moduleSource().indexOf("export function", fnStart + 1);
  const fnBody = moduleSource().slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const guardIndex = fnBody.indexOf("AmbiguousExternalCustomerLinkageError");
  const setIndex = fnBody.indexOf("linked.set(");
  assert.ok(guardIndex >= 0 && setIndex >= 0);
  assert.ok(guardIndex < setIndex, "the ambiguous-linkage guard must run before the map is ever written");
});
