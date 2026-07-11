import assert from "node:assert/strict";
import { test } from "node:test";

import { loadEnvironmentText, validateRuntimeConfig } from "../scripts/runtime-config.mjs";

test("accepts the complete demo runtime configuration", () => {
  assert.doesNotThrow(() => validateRuntimeConfig({
    AUTH_MODE: "demo",
    SETTINGS_ENCRYPTION_KEY: "test-settings-key",
    TURSO_DATABASE_URL: "libsql://example.turso.io",
    TURSO_AUTH_TOKEN: "test-token",
  }));
});

test("rejects a demo configuration missing the settings encryption key", () => {
  assert.throws(
    () => validateRuntimeConfig({
      AUTH_MODE: "demo",
      TURSO_DATABASE_URL: "libsql://example.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
    }),
    /SETTINGS_ENCRYPTION_KEY/,
  );
});

test("rejects production configuration without an explicit Google allowlist", () => {
  assert.throws(
    () => validateRuntimeConfig({
      AUTH_MODE: "production",
      SETTINGS_ENCRYPTION_KEY: "test-settings-key",
      TURSO_DATABASE_URL: "libsql://example.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
    }),
    /ALLOWED_GOOGLE_EMAILS/,
  );
});

test("rejects a production allowlist that contains no email address", () => {
  assert.throws(
    () => validateRuntimeConfig({
      AUTH_MODE: "production",
      SETTINGS_ENCRYPTION_KEY: "test-settings-key",
      TURSO_DATABASE_URL: "libsql://example.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
      ALLOWED_GOOGLE_EMAILS: ", ,",
    }),
    /ALLOWED_GOOGLE_EMAILS/,
  );
});

test("rejects an invalid Turso database URL", () => {
  assert.throws(
    () => validateRuntimeConfig({
      AUTH_MODE: "demo",
      SETTINGS_ENCRYPTION_KEY: "test-settings-key",
      TURSO_DATABASE_URL: "not-a-url",
      TURSO_AUTH_TOKEN: "test-token",
    }),
    /TURSO_DATABASE_URL/,
  );
});

test("loads quoted environment values without retaining comments or quotes", () => {
  const env = {};
  loadEnvironmentText('TURSO_DATABASE_URL="libsql://example.turso.io" # local database\nAUTH_MODE=demo\n', env);

  assert.deepEqual(env, {
    TURSO_DATABASE_URL: "libsql://example.turso.io",
    AUTH_MODE: "demo",
  });
});
