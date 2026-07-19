import { isDirectExecution } from "./remove-legacy-platform-credentials.mjs";

const REQUIRED = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
const SUPPORT_TABLES = [
  "support_configurations",
  "support_faqs",
  "support_conversations",
  "support_messages",
  "support_ai_decisions",
  "support_webhook_events",
  "support_conversation_transitions",
];
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
  const missingTables = SUPPORT_TABLES.filter((name) => !tableNames.has(name));
  const invalidIndexes = [];
  for (const [name, expected] of Object.entries(SUPPORT_INDEXES)) {
    if (!tableNames.has(expected.table)) {
      invalidIndexes.push(name);
      continue;
    }
    const listed = await client.execute(`PRAGMA index_list('${expected.table}')`);
    const index = listed.rows.find((row) => row.name === name);
    if (!index || Boolean(index.unique) !== expected.unique) {
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
  if (missingTables.length || invalidIndexes.length) {
    throw new Error(
      `Support schema verification failed: missing or invalid ${[
        ...missingTables,
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

async function migrateWithDrizzle(env) {
  const [{ createClient }, { drizzle }, { migrate }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("drizzle-orm/libsql/migrator"),
  ]);
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "drizzle" });
    return await verifySupportSchema(client);
  } finally {
    await client.close();
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runSupportSchemaMigration({ directExecution: true })
    .then(() => console.log("LINE support schema migration and verification complete."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
