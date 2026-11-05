import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvSecretResolver, MissingEnvSecretError } from "../src/domain/connector-secret-resolver-env.js";

const TEST_VAR = "AKILTA_TEST_ENV_SECRET_RESOLVER_VAR";

test("resolve: returns the environment variable's value when set and non-empty", () => {
  process.env[TEST_VAR] = "a-real-secret-value";
  try {
    const resolver = new EnvSecretResolver();
    assert.equal(resolver.resolve(TEST_VAR), "a-real-secret-value");
  } finally {
    delete process.env[TEST_VAR];
  }
});

test("resolve: throws MissingEnvSecretError when the variable is unset, and never includes any value in the message", () => {
  delete process.env[TEST_VAR];
  const resolver = new EnvSecretResolver();
  assert.throws(() => resolver.resolve(TEST_VAR), MissingEnvSecretError);
  try {
    resolver.resolve(TEST_VAR);
    assert.fail("expected resolve to throw");
  } catch (error) {
    assert.ok((error as Error).message.includes(TEST_VAR));
  }
});

test("resolve: throws when the variable is set to an empty string", () => {
  process.env[TEST_VAR] = "";
  try {
    const resolver = new EnvSecretResolver();
    assert.throws(() => resolver.resolve(TEST_VAR), MissingEnvSecretError);
  } finally {
    delete process.env[TEST_VAR];
  }
});
