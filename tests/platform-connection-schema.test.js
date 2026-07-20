import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";

test("migration adds renewal leases and enforces one active connection per owner and platform", async () => {
  const sql = await readFile(new URL("../drizzle/0003_renewal_leases_active_default.sql", import.meta.url), "utf8");
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const snapshot = JSON.parse(await readFile(new URL("../drizzle/meta/0003_snapshot.json", import.meta.url), "utf8"));
  assert.match(sql, /renewal_lease_id/i);
  assert.match(sql, /renewal_lease_expires_at/i);
  assert.match(sql, /unique index.*owner.*platform/i);
  assert.equal(
    journal.entries.some((entry) => entry.idx === 3 && entry.tag === "0003_renewal_leases_active_default"),
    true,
  );
  assert.equal(snapshot.tables["platform_connections"].columns.renewal_lease_id.notNull, false);

  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`
      CREATE TABLE platform_connections (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform TEXT NOT NULL, display_name TEXT NOT NULL,
        state TEXT NOT NULL, encrypted_credentials TEXT NOT NULL, credential_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO platform_connections (id,owner_email,platform,display_name,state,encrypted_credentials,created_at,updated_at)
        VALUES ('active-old','owner@example.com','meta','old','active','encrypted',1,1);
      INSERT INTO platform_connections (id,owner_email,platform,display_name,state,encrypted_credentials,created_at,updated_at)
        VALUES ('active-new','owner@example.com','meta','new','active','encrypted',2,2);
      ${sql.replaceAll("--> statement-breakpoint", "")}
    `);
    const migrated = await client.execute("SELECT id,state FROM platform_connections ORDER BY id");
    assert.deepEqual(migrated.rows.map((row) => [row.id, row.state]), [["active-new", "active"], ["active-old", "archived"]]);
    const values = (id, state) => ({ id, owner_email: "owner@example.com", platform: "meta", display_name: id, state, encrypted_credentials: "encrypted", created_at: 1, updated_at: 1 });
    await assert.rejects(client.execute({ sql: "INSERT INTO platform_connections (id,owner_email,platform,display_name,state,encrypted_credentials,created_at,updated_at) VALUES (:id,:owner_email,:platform,:display_name,:state,:encrypted_credentials,:created_at,:updated_at)", args: values("active-2", "active") }));
    await client.execute({ sql: "INSERT INTO platform_connections (id,owner_email,platform,display_name,state,encrypted_credentials,created_at,updated_at) VALUES (:id,:owner_email,:platform,:display_name,:state,:encrypted_credentials,:created_at,:updated_at)", args: values("archived-1", "archived") });
  } finally {
    await client.close();
  }
});
