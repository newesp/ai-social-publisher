import { isDirectExecution } from "./remove-legacy-platform-credentials.mjs";

const REQUIRED = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];

export function validatePlatformMigrationEnvironment(env) {
  if (String(env.PLATFORM_MIGRATION_BACKUP_CONFIRMED ?? "").trim() !== "YES") {
    throw new Error("A verified backup is required; set PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES after completing the runbook prerequisite.");
  }
  for (const key of REQUIRED) if (!String(env[key] ?? "").trim()) throw new Error(`${key} must be configured.`);
}

export async function runPlatformSchemaMigration({ directExecution = isDirectExecution(import.meta.url, process.argv[1]), env = process.env, migrateSchema = migrateWithDrizzle } = {}) {
  if (!directExecution) return null;
  validatePlatformMigrationEnvironment(env);
  return migrateSchema(env);
}

async function migrateWithDrizzle(env) {
  const [{ createClient }, { drizzle }, { migrate }] = await Promise.all([
    import("@libsql/client"), import("drizzle-orm/libsql"), import("drizzle-orm/libsql/migrator"),
  ]);
  const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "drizzle" });
    const columns = await client.execute("PRAGMA table_info('platform_connections')");
    const indexes = await client.execute("PRAGMA index_list('platform_connections')");
    const columnNames = new Set(columns.rows.map((row) => row.name));
    const indexNames = new Set(indexes.rows.map((row) => row.name));
    if (!columnNames.has("renewal_lease_id") || !columnNames.has("renewal_lease_expires_at")
      || !indexNames.has("platform_connections_one_active_owner_platform_idx")) {
      throw new Error("Platform connection schema verification failed.");
    }
    const duplicates = await client.execute("SELECT owner_email, platform, COUNT(*) AS count FROM platform_connections WHERE state = 'active' GROUP BY owner_email, platform HAVING COUNT(*) > 1 LIMIT 1");
    if (duplicates.rows.length) throw new Error("Platform connection active-default verification failed.");
    return { schemaVerified: true };
  } finally {
    await client.close();
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runPlatformSchemaMigration({ directExecution: true })
    .then(() => console.log("Platform connection schema migration and verification complete."))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
