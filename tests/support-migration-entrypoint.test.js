import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

const migrationModuleUrl = new URL("../scripts/apply-support-schema.mjs", import.meta.url);

test("support schema migration is backup-gated before opening a database", async () => {
  const {
    runSupportSchemaMigration,
    validateSupportMigrationEnvironment,
  } = await import(migrationModuleUrl);
  let migrationCalls = 0;
  const migrateSchema = async () => {
    migrationCalls += 1;
    return { schemaVerified: true };
  };

  assert.throws(() => validateSupportMigrationEnvironment({}), /backup/i);
  await assert.rejects(
    runSupportSchemaMigration({ directExecution: true, env: {}, migrateSchema }),
    /backup/i,
  );
  assert.equal(migrationCalls, 0);
  assert.equal(
    await runSupportSchemaMigration({ directExecution: false, env: {}, migrateSchema }),
    null,
  );
  assert.equal(migrationCalls, 0);
});

test("support schema migration validates configuration and delegates after acknowledgement", async () => {
  const {
    runSupportSchemaMigration,
    validateSupportMigrationEnvironment,
  } = await import(migrationModuleUrl);
  const env = {
    SUPPORT_MIGRATION_BACKUP_CONFIRMED: "YES",
    TURSO_DATABASE_URL: "libsql://example.invalid",
    TURSO_AUTH_TOKEN: "token",
  };
  assert.throws(
    () => validateSupportMigrationEnvironment({
      SUPPORT_MIGRATION_BACKUP_CONFIRMED: "YES",
    }),
    /TURSO_DATABASE_URL/,
  );
  assert.doesNotThrow(() => validateSupportMigrationEnvironment(env));

  const calls = [];
  const result = await runSupportSchemaMigration({
    directExecution: true,
    env,
    migrateSchema: async (receivedEnv) => {
      calls.push(receivedEnv);
      return { schemaVerified: true };
    },
  });
  assert.deepEqual(calls, [env]);
  assert.deepEqual(result, { schemaVerified: true });
});

test("support schema migration runs Drizzle and verifies a local database before closing it", async () => {
  const { runSupportSchemaMigration } = await import(migrationModuleUrl);
  const result = await runSupportSchemaMigration({
    directExecution: true,
    env: {
      SUPPORT_MIGRATION_BACKUP_CONFIRMED: "YES",
      TURSO_DATABASE_URL: ":memory:",
      TURSO_AUTH_TOKEN: "local-test-token",
    },
  });
  assert.deepEqual(result, { schemaVerified: true });
});

test("support schema verifier checks all tables, named indexes, and duplicate active customers locally", async () => {
  const { verifySupportSchema } = await import(migrationModuleUrl);
  const migrationSql = await readFile(
    new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url),
    "utf8",
  );
  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`
      CREATE TABLE platform_connections (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO platform_connections (id) VALUES ('line-1');
      ${migrationSql.replaceAll("--> statement-breakpoint", "")}
    `);
    assert.deepEqual(await verifySupportSchema(client), { schemaVerified: true });

    await client.execute("DROP INDEX support_messages_idempotency_unique");
    await client.execute(
      "CREATE INDEX support_messages_idempotency_unique ON support_messages (idempotency_key)",
    );
    await assert.rejects(verifySupportSchema(client), /verification failed/i);
    await client.execute("DROP INDEX support_messages_idempotency_unique");
    await client.execute(
      "CREATE UNIQUE INDEX support_messages_idempotency_unique ON support_messages (idempotency_key)",
    );

    await client.execute("DROP INDEX support_conversations_customer_unique");
    await client.execute(
      "CREATE INDEX support_conversations_customer_unique ON support_conversations (platform_connection_id, customer_lookup_key)",
    );
    const row = (id) => ({
      id,
      owner_email: "owner@example.com",
      platform_connection_id: "line-1",
      platform: "line",
      customer_lookup_key: "same-customer",
      encrypted_customer_external_id: "encrypted",
      status: "ai_active",
      created_at: 1,
      updated_at: 1,
    });
    const insert = `INSERT INTO support_conversations (
      id, owner_email, platform_connection_id, platform, customer_lookup_key,
      encrypted_customer_external_id, status, created_at, updated_at
    ) VALUES (
      :id, :owner_email, :platform_connection_id, :platform,
      :customer_lookup_key, :encrypted_customer_external_id, :status,
      :created_at, :updated_at
    )`;
    await client.execute({ sql: insert, args: row("duplicate-1") });
    await client.execute({ sql: insert, args: row("duplicate-2") });
    await assert.rejects(verifySupportSchema(client), /verification failed/i);
  } finally {
    await client.close();
  }
});

test("support migration package command is explicit and direct execution fails closed", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["migrate:support-schema"], "node scripts/apply-support-schema.mjs");
  for (const name of ["dev", "build", "start", "predev", "prebuild", "prestart", "test"]) {
    assert.equal(/support-schema/.test(pkg.scripts[name]), false, `${name} must not run the support migration`);
  }

  const result = spawnSync(process.execPath, [fileURLToPath(migrationModuleUrl)], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup/i);
});
