import assert from "node:assert/strict";
import { test } from "node:test";

import { REQUIRED_RUNTIME_CONFIG_KEYS, loadEnvironmentText, validateRuntimeConfig } from "../scripts/runtime-config.mjs";

test("accepts the complete demo runtime configuration", () => {
  assert.doesNotThrow(() => validateRuntimeConfig({
      AUTH_MODE: "demo",
      SETTINGS_ENCRYPTION_KEY: "test-settings-key",
      TURSO_DATABASE_URL: "libsql://example.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
      BLOB_READ_WRITE_TOKEN: "test-blob-token",
  }));
});

test("runtime configuration does not require shared platform tokens or Meta OAuth settings", () => {
  assert.doesNotThrow(() => validateRuntimeConfig({
    AUTH_MODE: "demo",
    SETTINGS_ENCRYPTION_KEY: "test-settings-key",
    TURSO_DATABASE_URL: "libsql://example.turso.io",
    TURSO_AUTH_TOKEN: "test-token",
    BLOB_READ_WRITE_TOKEN: "test-blob-token",
  }));
  assert.deepEqual(REQUIRED_RUNTIME_CONFIG_KEYS, [
    "SETTINGS_ENCRYPTION_KEY",
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "BLOB_READ_WRITE_TOKEN",
  ]);
});

test("environment example contains server-only Meta OAuth settings and no shared publishing credentials", async () => {
  const example = await import("node:fs/promises").then(({ readFile }) => readFile(".env.example", "utf8"));

  for (const key of ["META_APP_ID", "META_APP_SECRET", "META_OAUTH_REDIRECT_URI"]) {
    assert.match(example, new RegExp(`^${key}=`, "m"));
    assert.doesNotMatch(example, new RegExp(`^NEXT_PUBLIC_${key}=`, "m"));
  }
  for (const key of ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN", "LINE_CHANNEL_ACCESS_TOKEN"]) {
    assert.doesNotMatch(example, new RegExp(`^${key}=`, "m"));
  }
});

test("rejects a configuration missing the Blob upload token", () => {
  assert.throws(
    () => validateRuntimeConfig({
      AUTH_MODE: "demo",
      SETTINGS_ENCRYPTION_KEY: "test-settings-key",
      TURSO_DATABASE_URL: "libsql://example.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
    }),
    /BLOB_READ_WRITE_TOKEN/,
  );
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
      BLOB_READ_WRITE_TOKEN: "test-blob-token",
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
      BLOB_READ_WRITE_TOKEN: "test-blob-token",
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
      BLOB_READ_WRITE_TOKEN: "test-blob-token",
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
