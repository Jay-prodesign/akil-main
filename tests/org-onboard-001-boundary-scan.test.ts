import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OrganizationOnboarding from "../src/domain/organization-onboarding.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/domain/organization-onboarding.ts";

function moduleSource(): string {
  return readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
}

function moduleCodeOnly(): string {
  return moduleSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

test("B1 (no second Organization-construction path): the module never redefines organization.ts's Organization shape - it imports createOrganization/activateOrganization and nothing else from organization.js", () => {
  const content = moduleSource();
  assert.match(content, /from ["']\.\/organization\.js["']/);
  assert.doesNotMatch(moduleCodeOnly(), /function createOrganization|function activateOrganization/);
});

test("B2 (no second IAM primitive): outside its own explanatory comments, the module defines no AuthorityContext/permission-function shape, and never imports authority.ts", () => {
  const content = moduleCodeOnly();
  assert.doesNotMatch(content, /AuthorityContext/);
  assert.doesNotMatch(content, /requirePermission|requireProtectedActionAuthorization|requireSameTenant/);
  assert.doesNotMatch(moduleSource(), /from ["']\.\/authority\.js["']/);
});

test("B3 (self-admission guard ordering): admitOrganizationOnboardingRequest checks the self-admission guard before constructing any Organization/membership", () => {
  const fnStart = moduleSource().indexOf("export function admitOrganizationOnboardingRequest");
  const nextFnStart = moduleSource().indexOf("export function", fnStart + 1);
  const fnBody = moduleSource().slice(fnStart, nextFnStart >= 0 ? nextFnStart : undefined);
  const guardIndex = fnBody.indexOf("admittingAuthorityPrincipalRef === request.requestedByRef");
  const constructIndex = fnBody.indexOf("createOrganization(");
  assert.ok(guardIndex >= 0 && constructIndex >= 0);
  assert.ok(guardIndex < constructIndex, "the self-admission guard must run before any Organization is constructed");
});

test("B4 (status guard ordering): admitOrganizationOnboardingRequest and rejectOrganizationOnboardingRequest both check request.status before any other validation or construction", () => {
  const admitStart = moduleSource().indexOf("export function admitOrganizationOnboardingRequest");
  const admitNext = moduleSource().indexOf("export function", admitStart + 1);
  const admitBody = moduleSource().slice(admitStart, admitNext >= 0 ? admitNext : undefined);
  assert.ok(admitBody.indexOf('request.status !== "SUBMITTED"') < admitBody.indexOf("createOrganization("));

  const rejectStart = moduleSource().indexOf("export function rejectOrganizationOnboardingRequest");
  const rejectBody = moduleSource().slice(rejectStart);
  const statusGuardIndex = rejectBody.indexOf('request.status !== "SUBMITTED"');
  const nextValidationIndex = rejectBody.indexOf("input.rejectingAuthorityPrincipalRef");
  assert.ok(statusGuardIndex >= 0 && nextValidationIndex >= 0);
  assert.ok(statusGuardIndex < nextValidationIndex, "the status guard must run before any further field validation");
});

test("B5 (zero new runtime dependency): no import statement outside this repository's own src/domain files", () => {
  const content = moduleSource();
  const importLines = content.match(/^import .+;$/gm) ?? [];
  for (const line of importLines) {
    assert.match(line, /from ["']\.\/[\w-]+\.js["']/, `unexpected external import: ${line}`);
  }
});

test("B6: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(OrganizationOnboarding).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidOrganizationOnboardingError",
    "OrganizationOnboardingAdmissionError",
    "admitOrganizationOnboardingRequest",
    "rejectOrganizationOnboardingRequest",
    "submitOrganizationOnboardingRequest",
  ]);
});

test("B7 (no live IdP/identity validation anywhere): requestedByRef and admittingAuthorityPrincipalRef are never checked against any external identity-provider shape - both are plain opaque strings throughout", () => {
  const content = moduleSource();
  assert.doesNotMatch(content, /oauth|OAuth|jwt|JWT|saml|SAML/);
});
