import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { runPlatformConnectionMigration } from "../scripts/migrate-platform-connections.mjs";
import { validatePlatformMigrationEnvironment } from "../scripts/apply-platform-schema.mjs";

test("platform migration orchestrates schema verification before legacy cleanup", async () => {
  const calls = [];
  const result = await runPlatformConnectionMigration({
    directExecution: true,
    env: { PLATFORM_MIGRATION_BACKUP_CONFIRMED: "YES" },
    applySchema: async () => { calls.push("schema"); return { schemaVerified: true }; },
    cleanupLegacy: async () => { calls.push("cleanup"); return { cleanedSettings: 2, failedTargets: 3 }; },
  });
  assert.deepEqual(calls, ["schema", "cleanup"]);
  assert.deepEqual(result, { schemaVerified: true, cleanedSettings: 2, failedTargets: 3 });
});

test("schema migration requires explicit backup acknowledgement and database configuration", () => {
  assert.throws(() => validatePlatformMigrationEnvironment({}), /backup/i);
  assert.throws(() => validatePlatformMigrationEnvironment({ PLATFORM_MIGRATION_BACKUP_CONFIRMED: "YES" }), /TURSO_DATABASE_URL/);
  assert.doesNotThrow(() => validatePlatformMigrationEnvironment({
    PLATFORM_MIGRATION_BACKUP_CONFIRMED: "YES", TURSO_DATABASE_URL: "libsql://example.invalid", TURSO_AUTH_TOKEN: "token",
  }));
});

test("package commands are explicit and never wired into runtime lifecycle scripts", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["migrate:platform-connections"], "node scripts/migrate-platform-connections.mjs");
  assert.equal(pkg.scripts["migrate:platform-schema"], "node scripts/apply-platform-schema.mjs");
  assert.equal(pkg.scripts["cleanup:legacy-platform-credentials"], "node scripts/remove-legacy-platform-credentials.mjs");
  for (const name of ["dev", "build", "start", "predev", "prebuild", "prestart", "test"]) {
    assert.equal(/migrate|cleanup/.test(pkg.scripts[name]), false, `${name} must not run migrations`);
  }
});
