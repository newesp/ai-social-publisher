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

test("atomic support migration rolls back schema and journal when verification fails", async () => {
  const { migrateSupportSchemaAtomically } = await import(migrationModuleUrl);
  const client = createClient({ url: ":memory:" });
  try {
    await assert.rejects(
      migrateSupportSchemaAtomically(client, {
        verificationStatements: [
          "CREATE TEMP TABLE __forced_support_verification (valid INTEGER NOT NULL CHECK (valid = 1))",
          "INSERT INTO __forced_support_verification (valid) VALUES (0)",
        ],
      }),
      /constraint/i,
    );
    const supportTables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'support_%'",
    );
    assert.deepEqual(supportTables.rows, []);
    const migrationJournal = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    );
    assert.deepEqual(migrationJournal.rows, []);
  } finally {
    await client.close();
  }
});

test("support schema verifier checks all tables, named indexes, and duplicate active customers locally", async () => {
  const { verifySupportSchema } = await import(migrationModuleUrl);
  const migrationSql = await readFile(
    new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url),
    "utf8",
  );
  const outboxSql = await readFile(
    new URL("../drizzle/0005_line_outbound_delivery_outbox.sql", import.meta.url),
    "utf8",
  );
  const retentionSql = await readFile(
    new URL("../drizzle/0006_support_retention_indexes.sql", import.meta.url),
    "utf8",
  );
  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`
      CREATE TABLE platform_connections (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO platform_connections (id) VALUES ('line-1');
      ${migrationSql.replaceAll("--> statement-breakpoint", "")}
      ${outboxSql.replaceAll("--> statement-breakpoint", "")}
      ${retentionSql.replaceAll("--> statement-breakpoint", "")}
    `);
    assert.deepEqual(await verifySupportSchema(client), { schemaVerified: true });

    const retentionIndexes = await client.execute(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'support_messages_retention_created_idx',
        'support_webhook_events_retention_reply_token_idx',
        'support_outbound_deliveries_retention_status_created_idx'
      )
      ORDER BY name
    `);
    assert.deepEqual(retentionIndexes.rows.map((row) => row.name), [
      "support_messages_retention_created_idx",
      "support_outbound_deliveries_retention_status_created_idx",
      "support_webhook_events_retention_reply_token_idx",
    ]);
    const retentionSqlByName = new Map(retentionIndexes.rows.map((row) => [row.name, row.sql]));
    assert.match(retentionSqlByName.get("support_messages_retention_created_idx"), /\(created_at, id\)\s*WHERE text_content IS NOT NULL/i);
    assert.match(retentionSqlByName.get("support_webhook_events_retention_reply_token_idx"), /\(reply_token_expires_at, id\)\s*WHERE encrypted_reply_token IS NOT NULL/i);
    assert.match(retentionSqlByName.get("support_outbound_deliveries_retention_status_created_idx"), /\(delivery_status, created_at, id\)\s*WHERE encrypted_canonical_body <> ''/i);

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
    await client.execute(`
      CREATE UNIQUE INDEX support_conversations_customer_unique
      ON support_conversations (platform_connection_id, customer_lookup_key)
      WHERE status = 'ai_active'
    `);
    await assert.rejects(verifySupportSchema(client), /verification failed/i);
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

    for (const query of [
      "SELECT id FROM support_messages WHERE created_at < 100 AND text_content IS NOT NULL ORDER BY created_at, id LIMIT 100",
      "SELECT id FROM support_webhook_events WHERE reply_token_expires_at <= 100 AND encrypted_reply_token IS NOT NULL ORDER BY reply_token_expires_at, id LIMIT 100",
      "SELECT id FROM support_outbound_deliveries WHERE created_at < 100 AND delivery_status = 'sent' AND encrypted_canonical_body <> '' ORDER BY created_at, id LIMIT 100",
      "SELECT id FROM support_outbound_deliveries WHERE created_at < 100 AND delivery_status = 'failed' AND encrypted_canonical_body <> '' ORDER BY created_at, id LIMIT 100",
      "SELECT id FROM support_outbound_deliveries WHERE created_at < 100 AND delivery_status = 'human_review' AND encrypted_canonical_body <> '' ORDER BY created_at, id LIMIT 100",
    ]) {
      const plan = await client.execute(`EXPLAIN QUERY PLAN ${query}`);
      assert.doesNotMatch(JSON.stringify(plan.rows), /TEMP B-TREE/i);
    }
  } finally {
    await client.close();
  }
});

test("support schema verifier rejects malformed columns and missing foreign keys", async () => {
  const { verifySupportSchema } = await import(migrationModuleUrl);
  const migrationSql = await readFile(
    new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url),
    "utf8",
  );
  const outboxSql = await readFile(
    new URL("../drizzle/0005_line_outbound_delivery_outbox.sql", import.meta.url),
    "utf8",
  );
  const retentionSql = await readFile(
    new URL("../drizzle/0006_support_retention_indexes.sql", import.meta.url),
    "utf8",
  );

  const malformedColumnsClient = createClient({ url: ":memory:" });
  try {
    await malformedColumnsClient.executeMultiple(`
      CREATE TABLE platform_connections (id TEXT PRIMARY KEY NOT NULL);
      ${migrationSql.replaceAll("--> statement-breakpoint", "")}
      ${outboxSql.replaceAll("--> statement-breakpoint", "")}
      ${retentionSql.replaceAll("--> statement-breakpoint", "")}
      PRAGMA foreign_keys=OFF;
      DROP TABLE support_ai_decisions;
      CREATE TABLE support_ai_decisions (id TEXT PRIMARY KEY NOT NULL);
    `);
    await assert.rejects(verifySupportSchema(malformedColumnsClient), /verification failed/i);
  } finally {
    await malformedColumnsClient.close();
  }

  const missingForeignKeyClient = createClient({ url: ":memory:" });
  try {
    await missingForeignKeyClient.executeMultiple(`
      CREATE TABLE platform_connections (id TEXT PRIMARY KEY NOT NULL);
      ${migrationSql.replaceAll("--> statement-breakpoint", "")}
      ${outboxSql.replaceAll("--> statement-breakpoint", "")}
      ${retentionSql.replaceAll("--> statement-breakpoint", "")}
      PRAGMA foreign_keys=OFF;
      DROP TABLE support_conversation_transitions;
      CREATE TABLE support_conversation_transitions (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        requested_action TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        requested_by_owner_email TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        requested_at INTEGER NOT NULL,
        effective_at INTEGER NOT NULL,
        cancelled_at INTEGER,
        committed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX support_transitions_conversation_created_idx
        ON support_conversation_transitions (conversation_id, created_at);
    `);
    await assert.rejects(verifySupportSchema(missingForeignKeyClient), /verification failed/i);
  } finally {
    await missingForeignKeyClient.close();
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
