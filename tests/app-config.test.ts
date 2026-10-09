import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppConfig, InvalidAppConfigError } from "../src/runtime/app-config.js";

test("C1: defaults produce a valid development/FILE config with no DATABASE_URL", () => {
  const config = resolveAppConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.deploymentEnv, "development");
  assert.equal(config.persistenceDriver, "FILE");
  assert.equal(config.databaseUrl, undefined);
});

test("C2: explicit valid overrides are honored", () => {
  const config = resolveAppConfig({
    PORT: "3000",
    DEPLOYMENT_ENV: "production",
    PERSISTENCE_DRIVER: "POSTGRES",
    DATABASE_URL: "postgres://example/db",
  });
  assert.equal(config.port, 3000);
  assert.equal(config.deploymentEnv, "production");
  assert.equal(config.persistenceDriver, "POSTGRES");
  assert.equal(config.databaseUrl, "postgres://example/db");
});

test("C3: non-numeric PORT fails closed", () => {
  assert.throws(() => resolveAppConfig({ PORT: "not-a-number" }), InvalidAppConfigError);
});

test("C4: out-of-range PORT fails closed", () => {
  assert.throws(() => resolveAppConfig({ PORT: "0" }), InvalidAppConfigError);
  assert.throws(() => resolveAppConfig({ PORT: "70000" }), InvalidAppConfigError);
});

test("C5: unrecognized DEPLOYMENT_ENV fails closed", () => {
  assert.throws(() => resolveAppConfig({ DEPLOYMENT_ENV: "sandbox" }), InvalidAppConfigError);
});

test("C6: unrecognized PERSISTENCE_DRIVER fails closed", () => {
  assert.throws(() => resolveAppConfig({ PERSISTENCE_DRIVER: "SQLITE" }), InvalidAppConfigError);
});

test("C7: PERSISTENCE_DRIVER=POSTGRES with no DATABASE_URL fails closed", () => {
  assert.throws(() => resolveAppConfig({ PERSISTENCE_DRIVER: "POSTGRES" }), InvalidAppConfigError);
});

test("C8: PERSISTENCE_DRIVER=POSTGRES with a whitespace-only DATABASE_URL fails closed", () => {
  assert.throws(
    () => resolveAppConfig({ PERSISTENCE_DRIVER: "POSTGRES", DATABASE_URL: "   " }),
    InvalidAppConfigError,
  );
});

test("C9: PERSISTENCE_DRIVER=FILE never requires DATABASE_URL even if absent", () => {
  const config = resolveAppConfig({ PERSISTENCE_DRIVER: "FILE" });
  assert.equal(config.databaseUrl, undefined);
});
