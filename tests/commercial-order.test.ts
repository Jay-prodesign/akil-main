import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import {
  createCommercialOrder,
  resolveCanonicalServiceFromOrder,
  InvalidCommercialOrderError,
  type ServiceCatalogEntry,
} from "../src/domain/commercial-order.js";
import {
  buildWebsiteBuildV1CommercialOrderFixture,
  WEBSITE_BUILD_V1_SERVICE_CATALOG,
} from "../src/fixtures/website-build-v1-commercial-order.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import type { OfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import type { DeliveryRecipe } from "../src/domain/delivery-recipe.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });

test("creates a CommercialOrder bound to the given tenant/customer", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:x",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(order.tenantId, "tenant-a");
  assert.equal(order.customerId, "cust-1");
  assert.equal(order.orderId, "order-1");
  assert.equal(order.serviceRef, "service:x");
  assert.equal(order.placedAt, "2026-01-01T00:00:00.000Z");
});

test("a CommercialOrder carries no price/discount/payout/commission field", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:x",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  const keys = Object.keys(order).sort();
  assert.deepEqual(keys, ["customerId", "orderId", "placedAt", "serviceRef", "tenantId"]);
});

test("rejects a customer that does not belong to the given tenantScope", () => {
  const otherTenantScope = createTenantScope("tenant-b");
  assert.throws(
    () =>
      createCommercialOrder({
        tenantScope: otherTenantScope,
        customer,
        orderId: "order-1",
        serviceRef: "service:x",
        placedAt: "2026-01-01T00:00:00.000Z",
      }),
    InvalidCommercialOrderError,
  );
});

test("rejects an empty/whitespace-only orderId", () => {
  assert.throws(
    () =>
      createCommercialOrder({
        tenantScope,
        customer,
        orderId: "   ",
        serviceRef: "service:x",
        placedAt: "2026-01-01T00:00:00.000Z",
      }),
    InvalidCommercialOrderError,
  );
});

test("rejects an empty serviceRef", () => {
  assert.throws(
    () =>
      createCommercialOrder({
        tenantScope,
        customer,
        orderId: "order-1",
        serviceRef: "",
        placedAt: "2026-01-01T00:00:00.000Z",
      }),
    InvalidCommercialOrderError,
  );
});

test("resolveCanonicalServiceFromOrder resolves a serviceRef present in the catalog", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:known",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  const catalog: ServiceCatalogEntry[] = [
    {
      serviceRef: "service:known",
      blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
      blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
      recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    },
  ];
  const resolution = resolveCanonicalServiceFromOrder(order, catalog);
  assert.equal(resolution.status, "RESOLVED");
  assert.deepEqual(resolution, {
    status: "RESOLVED",
    blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
    blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
    recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
  });
});

test("resolveCanonicalServiceFromOrder returns UNRESOLVED_SERVICE, never a fabricated closest match, for an unknown serviceRef", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:unknown",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  const catalog: ServiceCatalogEntry[] = [
    {
      serviceRef: "service:known",
      blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
      blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
      recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    },
  ];
  const resolution = resolveCanonicalServiceFromOrder(order, catalog);
  assert.equal(resolution.status, "UNRESOLVED_SERVICE");
  if (resolution.status === "UNRESOLVED_SERVICE") {
    assert.match(resolution.reason, /service:unknown/);
  }
});

test("resolveCanonicalServiceFromOrder returns UNRESOLVED_SERVICE against an empty catalog", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:x",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  const resolution = resolveCanonicalServiceFromOrder(order, []);
  assert.equal(resolution.status, "UNRESOLVED_SERVICE");
});

test("resolveCanonicalServiceFromOrder throws (never guesses) on an ambiguous catalog with a duplicate serviceRef", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:dup",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  const catalog: ServiceCatalogEntry[] = [
    {
      serviceRef: "service:dup",
      blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
      blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
      recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    },
    {
      serviceRef: "service:dup",
      blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
      blueprintVersion: "2.0.0",
      recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    },
  ];
  assert.throws(
    () => resolveCanonicalServiceFromOrder(order, catalog),
    InvalidCommercialOrderError,
  );
});

test("resolveCanonicalServiceFromOrder never substitutes a different serviceRef's catalog entry", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef: "service:a",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  const catalog: ServiceCatalogEntry[] = [
    {
      serviceRef: "service:b",
      blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
      blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
      recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    },
  ];
  const resolution = resolveCanonicalServiceFromOrder(order, catalog);
  assert.equal(resolution.status, "UNRESOLVED_SERVICE");
});

test("Rev74 F1 (honest boundary disclosure): resolveCanonicalServiceFromOrder has no admission/provenance/authority binding - a caller-fabricated catalog entry for a serviceRef resolves exactly like a real, admitted one, so canonical-resolution provenance remains an explicitly OPEN audit gap, not something this function proves", () => {
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-forged-catalog",
    serviceRef: "service:never-admitted-anywhere",
    placedAt: "2026-01-01T00:00:00.000Z",
  });
  // A caller can construct any serviceRef -> blueprint/version/recipe
  // mapping it likes - nothing in this module checks it against any
  // admitted/trusted source, because this repository has no such source.
  const forgedCatalog: ServiceCatalogEntry[] = [
    {
      serviceRef: "service:never-admitted-anywhere",
      blueprintId: "forged-blueprint-id" as OfferBlueprintVersion["blueprintId"],
      blueprintVersion: "forged-version" as OfferBlueprintVersion["version"],
      recipeId: "forged-recipe-id" as DeliveryRecipe["recipeId"],
    },
  ];
  const resolution = resolveCanonicalServiceFromOrder(order, forgedCatalog);
  // This is the honestly-disclosed boundary, not a defect this test is
  // asserting should be fixed here: RESOLVED proves only that the caller's
  // own catalog declares exactly one entry for this serviceRef.
  assert.equal(resolution.status, "RESOLVED");
  if (resolution.status === "RESOLVED") {
    assert.equal(resolution.blueprintId, "forged-blueprint-id");
  }
});

test("WEBSITE_BUILD_v1 zero-history commercial order fixture resolves RESOLVED against the canonical blueprint/recipe", () => {
  const fixture = buildWebsiteBuildV1CommercialOrderFixture();
  assert.equal(fixture.resolution.status, "RESOLVED");
  if (fixture.resolution.status === "RESOLVED") {
    assert.equal(fixture.resolution.blueprintId, WEBSITE_BUILD_V1_BLUEPRINT.blueprintId);
    assert.equal(fixture.resolution.blueprintVersion, WEBSITE_BUILD_V1_BLUEPRINT.version);
    assert.equal(fixture.resolution.recipeId, WEBSITE_BUILD_V1_RECIPE.recipeId);
  }
});

test("WEBSITE_BUILD_v1 commercial order fixture carries no Project/SoldScope - a genuine zero-history order", () => {
  const fixture = buildWebsiteBuildV1CommercialOrderFixture();
  const keys = Object.keys(fixture).sort();
  assert.deepEqual(keys, ["customer", "order", "resolution", "tenantScope"]);
});

test("WEBSITE_BUILD_V1_SERVICE_CATALOG declares exactly one entry, reusing the canonical blueprint/recipe identifiers verbatim", () => {
  assert.equal(WEBSITE_BUILD_V1_SERVICE_CATALOG.length, 1);
  const [entry] = WEBSITE_BUILD_V1_SERVICE_CATALOG;
  assert.ok(entry !== undefined);
  assert.equal(entry.blueprintId, WEBSITE_BUILD_V1_BLUEPRINT.blueprintId);
  assert.equal(entry.recipeId, WEBSITE_BUILD_V1_RECIPE.recipeId);
});
