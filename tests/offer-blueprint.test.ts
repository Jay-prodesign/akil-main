import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOfferBlueprintVersion,
  InvalidOfferBlueprintError,
} from "../src/domain/offer-blueprint.js";

test("creates an OfferBlueprintVersion with REQUIRED and CONDITIONAL requirements", () => {
  const blueprint = createOfferBlueprintVersion({
    blueprintId: "bp-1",
    version: "1.0.0",
    requirements: [
      { requirementId: "a", description: "Requirement A", necessity: "REQUIRED", dependsOn: [] },
      { requirementId: "b", description: "Requirement B", necessity: "CONDITIONAL", dependsOn: ["a"] },
    ],
  });
  assert.equal(blueprint.blueprintId, "bp-1");
  assert.equal(blueprint.requirements.length, 2);
  assert.equal(blueprint.requirements[1]?.dependsOn[0], "a");
});

test("rejects an empty requirements array", () => {
  assert.throws(
    () => createOfferBlueprintVersion({ blueprintId: "bp-1", version: "1.0.0", requirements: [] }),
    InvalidOfferBlueprintError,
  );
});

test("rejects an invalid necessity value", () => {
  assert.throws(
    () =>
      createOfferBlueprintVersion({
        blueprintId: "bp-1",
        version: "1.0.0",
        requirements: [
          { requirementId: "a", description: "A", necessity: "SOMETIMES", dependsOn: [] },
        ],
      }),
    InvalidOfferBlueprintError,
  );
});

test("rejects a duplicate requirementId", () => {
  assert.throws(
    () =>
      createOfferBlueprintVersion({
        blueprintId: "bp-1",
        version: "1.0.0",
        requirements: [
          { requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: [] },
          { requirementId: "a", description: "A again", necessity: "REQUIRED", dependsOn: [] },
        ],
      }),
    InvalidOfferBlueprintError,
  );
});

test("T5: rejects a dangling dependsOn reference", () => {
  assert.throws(
    () =>
      createOfferBlueprintVersion({
        blueprintId: "bp-1",
        version: "1.0.0",
        requirements: [
          { requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: ["does-not-exist"] },
        ],
      }),
    InvalidOfferBlueprintError,
  );
});

test("T5: rejects a two-node dependency cycle", () => {
  assert.throws(
    () =>
      createOfferBlueprintVersion({
        blueprintId: "bp-1",
        version: "1.0.0",
        requirements: [
          { requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: ["b"] },
          { requirementId: "b", description: "B", necessity: "REQUIRED", dependsOn: ["a"] },
        ],
      }),
    InvalidOfferBlueprintError,
  );
});

test("T5: rejects a self-referencing dependency", () => {
  assert.throws(
    () =>
      createOfferBlueprintVersion({
        blueprintId: "bp-1",
        version: "1.0.0",
        requirements: [
          { requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: ["a"] },
        ],
      }),
    InvalidOfferBlueprintError,
  );
});

test("T5: rejects a longer dependency cycle (a -> b -> c -> a)", () => {
  assert.throws(
    () =>
      createOfferBlueprintVersion({
        blueprintId: "bp-1",
        version: "1.0.0",
        requirements: [
          { requirementId: "a", description: "A", necessity: "REQUIRED", dependsOn: ["b"] },
          { requirementId: "b", description: "B", necessity: "REQUIRED", dependsOn: ["c"] },
          { requirementId: "c", description: "C", necessity: "REQUIRED", dependsOn: ["a"] },
        ],
      }),
    InvalidOfferBlueprintError,
  );
});
