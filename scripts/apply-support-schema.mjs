import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import {
  supportAiDecisions,
  supportConfigurations,
  supportConversationTransitions,
  supportConversations,
  supportFaqs,
  supportMessages,
  supportWebhookEvents,
} from "../src/lib/db/schema.js";
import { isDirectExecution } from "./remove-legacy-platform-credentials.mjs";

const REQUIRED = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
const MIGRATIONS_TABLE = "__drizzle_migrations";
const SUPPORT_TABLES = Object.fromEntries([
  supportConfigurations,
  supportFaqs,
  supportConversations,
  supportMessages,
  supportAiDecisions,
  supportWebhookEvents,
  supportConversationTransitions,
].map((table) => {
  const config = getTableConfig(table);
  return [config.name, {
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toLowerCase(),
      notNull: column.notNull,
      primaryKey: column.primary,
      defaultValue: sqliteDefaultValue(column.default),
    })),
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columnsFrom: reference.columns.map((column) => column.name),
        tableTo: getTableName(reference.foreignTable),
        columnsTo: reference.foreignColumns.map((column) => column.name),
        onUpdate: String(foreignKey.onUpdate ?? "no action").toLowerCase(),
        onDelete: String(foreignKey.onDelete ?? "no action").toLowerCase(),
      };
    }),
  }];
}));
const SUPPORT_INDEXES = {
  support_configurations_connection_unique: {
    table: "support_configurations",
    unique: true,
    columns: ["platform_connection_id"],
  },
  support_configurations_webhook_key_unique: {
    table: "support_configurations",
    unique: true,
    columns: ["webhook_key_hash"],
  },
  support_faqs_owner_enabled_idx: {
    table: "support_faqs",
    unique: false,
    columns: ["owner_email", "enabled", "priority"],
  },
  support_conversations_owner_status_updated_idx: {
    table: "support_conversations",
    unique: false,
    columns: ["owner_email", "status", "updated_at"],
  },
  support_conversations_customer_unique: {
    table: "support_conversations",
    unique: true,
    columns: ["platform_connection_id", "customer_lookup_key"],
  },
  support_messages_conversation_created_idx: {
    table: "support_messages",
    unique: false,
    columns: ["conversation_id", "created_at"],
  },
  support_messages_idempotency_unique: {
    table: "support_messages",
    unique: true,
    columns: ["idempotency_key"],
  },
  support_webhook_events_connection_event_unique: {
    table: "support_webhook_events",
    unique: true,
    columns: ["platform_connection_id", "webhook_event_id"],
  },
  support_transitions_conversation_created_idx: {
    table: "support_conversation_transitions",
    unique: false,
    columns: ["conversation_id", "created_at"],
  },
};

export function validateSupportMigrationEnvironment(env) {
  if (String(env.SUPPORT_MIGRATION_BACKUP_CONFIRMED ?? "").trim() !== "YES") {
    throw new Error("A verified backup is required; set SUPPORT_MIGRATION_BACKUP_CONFIRMED=YES after completing the runbook prerequisite.");
  }
  for (const key of REQUIRED) {
    if (!String(env[key] ?? "").trim()) throw new Error(`${key} must be configured.`);
  }
}

export async function runSupportSchemaMigration({
  directExecution = isDirectExecution(import.meta.url, process.argv[1]),
  env = process.env,
  migrateSchema = migrateWithDrizzle,
} = {}) {
  if (!directExecution) return null;
  validateSupportMigrationEnvironment(env);
  return migrateSchema(env);
}

export async function verifySupportSchema(client) {
  const objects = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const tableNames = new Set(objects.rows.map((row) => row.name));
  const invalidTables = [];
  for (const [name, expected] of Object.entries(SUPPORT_TABLES)) {
    if (!tableNames.has(name)) {
      invalidTables.push(name);
      continue;
    }
    const columns = await client.execute(`PRAGMA table_info('${name}')`);
    if (!columnsMatch(columns.rows, expected.columns)) {
      invalidTables.push(name);
      continue;
    }
    const foreignKeys = await client.execute(`PRAGMA foreign_key_list('${name}')`);
    if (!foreignKeysMatch(foreignKeys.rows, expected.foreignKeys)) {
      invalidTables.push(name);
    }
  }
  const invalidIndexes = [];
  for (const [name, expected] of Object.entries(SUPPORT_INDEXES)) {
    if (!tableNames.has(expected.table)) {
      invalidIndexes.push(name);
      continue;
    }
    const listed = await client.execute(`PRAGMA index_list('${expected.table}')`);
    const index = listed.rows.find((row) => row.name === name);
    if (!index || Boolean(index.unique) !== expected.unique || Boolean(index.partial)) {
      invalidIndexes.push(name);
      continue;
    }
    const info = await client.execute(`PRAGMA index_info('${name}')`);
    const columns = [...info.rows]
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => row.name);
    if (
      columns.length !== expected.columns.length
      || columns.some((column, indexPosition) => column !== expected.columns[indexPosition])
    ) {
      invalidIndexes.push(name);
    }
  }
  if (invalidTables.length || invalidIndexes.length) {
    throw new Error(
      `Support schema verification failed: missing or invalid ${[
        ...invalidTables,
        ...invalidIndexes,
      ].join(", ")}.`,
    );
  }

  const duplicates = await client.execute(`
    SELECT platform_connection_id, customer_lookup_key, COUNT(*) AS count
    FROM support_conversations
    WHERE status NOT IN ('resolved', 'blocked')
    GROUP BY platform_connection_id, customer_lookup_key
    HAVING COUNT(*) > 1
    LIMIT 1
  `);
  if (duplicates.rows.length) {
    throw new Error("Support active customer verification failed.");
  }
  return { schemaVerified: true };
}

export async function migrateSupportSchemaAtomically(client, {
  migrationsFolder = "drizzle",
  verificationStatements,
} = {}) {
  const { readMigrationFiles } = await import("drizzle-orm/migrator");
  const migrations = readMigrationFiles({ migrationsFolder });
  const journalExists = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${MIGRATIONS_TABLE}'`,
  );
  let lastMigration;
  if (journalExists.rows.length) {
    const existing = await client.execute(
      `SELECT hash, created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`,
    );
    lastMigration = existing.rows[0];
  }

  const statements = [`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `];
  for (const migration of migrations) {
    if (lastMigration && Number(lastMigration.created_at) >= migration.folderMillis) continue;
    statements.push(...migration.sql);
    statements.push({
      sql: `INSERT INTO "${MIGRATIONS_TABLE}" (hash, created_at) VALUES (?, ?)`,
      args: [migration.hash, migration.folderMillis],
    });
  }
  statements.push(...(
    verificationStatements ?? buildAtomicSupportVerificationStatements()
  ));
  await client.migrate(statements);
  return { schemaVerified: true };
}

async function migrateWithDrizzle(env) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
  try {
    return await migrateSupportSchemaAtomically(client);
  } finally {
    await client.close();
  }
}

function sqliteDefaultValue(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("Unsupported support schema default value.");
}

function columnsMatch(actualRows, expectedColumns) {
  if (actualRows.length !== expectedColumns.length) return false;
  const actualByName = new Map(actualRows.map((row) => [row.name, row]));
  return expectedColumns.every((expected) => {
    const actual = actualByName.get(expected.name);
    return actual
      && String(actual.type).toLowerCase() === expected.type
      && Boolean(actual.notnull) === expected.notNull
      && Boolean(actual.pk) === expected.primaryKey
      && (actual.dflt_value === null ? null : String(actual.dflt_value)) === expected.defaultValue;
  });
}

function foreignKeysMatch(actualRows, expectedForeignKeys) {
  const actual = groupedForeignKeys(actualRows).map(foreignKeyIdentity).sort();
  const expected = expectedForeignKeys.map(foreignKeyIdentity).sort();
  return actual.length === expected.length
    && actual.every((identity, index) => identity === expected[index]);
}

function groupedForeignKeys(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!groups.has(id)) {
      groups.set(id, {
        tableTo: row.table,
        columnsFrom: [],
        columnsTo: [],
        onUpdate: String(row.on_update).toLowerCase(),
        onDelete: String(row.on_delete).toLowerCase(),
      });
    }
    const group = groups.get(id);
    group.columnsFrom[Number(row.seq)] = row.from;
    group.columnsTo[Number(row.seq)] = row.to;
  }
  return [...groups.values()];
}

function foreignKeyIdentity(foreignKey) {
  return JSON.stringify([
    foreignKey.columnsFrom,
    foreignKey.tableTo,
    foreignKey.columnsTo,
    foreignKey.onUpdate,
    foreignKey.onDelete,
  ]);
}

function buildAtomicSupportVerificationStatements() {
  const guardTable = "__support_schema_verification_guard";
  const statements = [
    `DROP TABLE IF EXISTS temp.${guardTable}`,
    `CREATE TEMP TABLE ${guardTable} (valid INTEGER NOT NULL CHECK (valid = 1))`,
  ];
  const guard = (condition) => (
    `INSERT INTO ${guardTable} (valid) SELECT CASE WHEN (${condition}) THEN 1 ELSE 0 END`
  );

  for (const [tableName, expected] of Object.entries(SUPPORT_TABLES)) {
    const table = sqlLiteral(tableName);
    statements.push(guard(`
      EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table})
      AND (SELECT COUNT(*) FROM pragma_table_info(${table})) = ${expected.columns.length}
    `));
    for (const column of expected.columns) {
      const defaultCondition = column.defaultValue === null
        ? "dflt_value IS NULL"
        : `dflt_value = ${sqlLiteral(column.defaultValue)}`;
      statements.push(guard(`
        EXISTS (
          SELECT 1 FROM pragma_table_info(${table})
          WHERE name = ${sqlLiteral(column.name)}
            AND lower(type) = ${sqlLiteral(column.type)}
            AND "notnull" = ${column.notNull ? 1 : 0}
            AND pk = ${column.primaryKey ? 1 : 0}
            AND ${defaultCondition}
        )
      `));
    }
    statements.push(guard(`
      (SELECT COUNT(*) FROM pragma_foreign_key_list(${table}))
        = ${expected.foreignKeys.reduce((count, foreignKey) => count + foreignKey.columnsFrom.length, 0)}
    `));
    for (const foreignKey of expected.foreignKeys) {
      foreignKey.columnsFrom.forEach((columnFrom, index) => {
        statements.push(guard(`
          EXISTS (
            SELECT 1 FROM pragma_foreign_key_list(${table})
            WHERE "from" = ${sqlLiteral(columnFrom)}
              AND "table" = ${sqlLiteral(foreignKey.tableTo)}
              AND "to" = ${sqlLiteral(foreignKey.columnsTo[index])}
              AND lower(on_update) = ${sqlLiteral(foreignKey.onUpdate)}
              AND lower(on_delete) = ${sqlLiteral(foreignKey.onDelete)}
          )
        `));
      });
    }
  }

  for (const [indexName, expected] of Object.entries(SUPPORT_INDEXES)) {
    const table = sqlLiteral(expected.table);
    const index = sqlLiteral(indexName);
    statements.push(guard(`
      EXISTS (
        SELECT 1 FROM pragma_index_list(${table})
        WHERE name = ${index}
          AND "unique" = ${expected.unique ? 1 : 0}
          AND partial = 0
      )
      AND (SELECT COUNT(*) FROM pragma_index_info(${index})) = ${expected.columns.length}
    `));
    expected.columns.forEach((column, position) => {
      statements.push(guard(`
        EXISTS (
          SELECT 1 FROM pragma_index_info(${index})
          WHERE seqno = ${position} AND name = ${sqlLiteral(column)}
        )
      `));
    });
  }

  statements.push(guard(`
    NOT EXISTS (
      SELECT platform_connection_id, customer_lookup_key
      FROM support_conversations
      WHERE status NOT IN ('resolved', 'blocked')
      GROUP BY platform_connection_id, customer_lookup_key
      HAVING COUNT(*) > 1
    )
  `));
  statements.push(`DROP TABLE ${guardTable}`);
  return statements;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runSupportSchemaMigration({ directExecution: true })
    .then(() => console.log("LINE support schema migration and verification complete."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
