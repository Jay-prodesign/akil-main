import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCALE, isRecognizedLocale, resolveRequestLocale } from "../src/web/locale.js";

test("I1: DEFAULT_LOCALE is Turkish - the Türkiye-launch primary/default", () => {
  assert.equal(DEFAULT_LOCALE, "tr");
});

test("I2: isRecognizedLocale accepts only the two closed operator locales", () => {
  assert.equal(isRecognizedLocale("tr"), true);
  assert.equal(isRecognizedLocale("en"), true);
  assert.equal(isRecognizedLocale("fr"), false);
  assert.equal(isRecognizedLocale(""), false);
  assert.equal(isRecognizedLocale(undefined), false);
  assert.equal(isRecognizedLocale(null), false);
  assert.equal(isRecognizedLocale(42), false);
});

test("I2b: isRecognizedLocale cannot be defeated by an Object.prototype-shaped value (no bracket-indexing lookup)", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    assert.equal(isRecognizedLocale(key), false, `expected ${key} to be rejected`);
  }
});

test("I3: a missing Accept-Language header resolves to the Turkish default fallback", () => {
  assert.equal(resolveRequestLocale({}), "tr");
});

test("I4: an empty/whitespace-only Accept-Language header resolves to the Turkish default fallback", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "" }), "tr");
  assert.equal(resolveRequestLocale({ "accept-language": "   " }), "tr");
});

test("I5: a plain 'en' Accept-Language selects English", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "en" }), "en");
});

test("I6: a real browser-shaped Accept-Language ('en-US,en;q=0.9') selects English via its primary subtag", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "en-US,en;q=0.9" }), "en");
});

test("I7: a real browser-shaped Turkish Accept-Language ('tr-TR,tr;q=0.9,en;q=0.8') selects Turkish", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" }), "tr");
});

test("I8 (deterministic unsupported-locale fallback): a wholly unsupported Accept-Language ('fr-FR,fr;q=0.9') falls back to the Turkish default, never to en or an exception", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "fr-FR,fr;q=0.9" }), "tr");
});

test("I9: an unsupported primary preference followed by a recognized secondary one ('fr-FR,fr;q=0.9,en;q=0.5') still selects the first recognized locale, never the unrecognized one", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" }), "en");
});

test("I10: locale matching is case-insensitive ('EN-US' selects English)", () => {
  assert.equal(resolveRequestLocale({ "accept-language": "EN-US" }), "en");
});

test("I11: a malformed/garbage Accept-Language value resolves to the Turkish default fallback rather than throwing", () => {
  assert.doesNotThrow(() => resolveRequestLocale({ "accept-language": ",,,;;;===" }));
  assert.equal(resolveRequestLocale({ "accept-language": ",,,;;;===" }), "tr");
});
