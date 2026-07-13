import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { platformConnections } from "../src/lib/db/schema.js";
import { createPlatformConnectionsRepository } from "../src/lib/platform-connections/platform-connections-repository.js";

test("archiveActiveDefaultConnection atomically archives every current active owner-platform row only", async () => {
  await withDatabase(async ({ db }) => {
    const now = new Date("2026-07-13T00:00:00.000Z");
    await db.insert(platformConnections).values([
      connection("owner-meta-old", "owner@example.com", "meta", "active"),
      connection("owner-meta-new", "owner@example.com", "meta", "active"),
      connection("owner-line", "owner@example.com", "line", "active"),
      connection("other-meta", "other@example.com", "meta", "active"),
    ]);
    const repository = createPlatformConnectionsRepository(db);

    const archived = await repository.archiveActiveDefaultConnection("owner@example.com", "meta", now);

    assert.equal(archived.ownerEmail, "owner@example.com");
    assert.equal(archived.platform, "meta");
    assert.equal(archived.state, "archived");
    const rows = await db.select().from(platformConnections);
    assert.deepEqual(rows.filter((row) => row.ownerEmail === "owner@example.com" && row.platform === "meta").map((row) => row.state), ["archived", "archived"]);
    assert.equal(rows.find((row) => row.id === "owner-line").state, "active");
    assert.equal(rows.find((row) => row.id === "other-meta").state, "active");
    assert.equal(await repository.archiveActiveDefaultConnection("owner@example.com", "meta", now), null);
  });
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "platform-connections-repository-"));
  const client = createClient({ url: pathToFileURL(join(directory, "connections.db")).href });
  try {
    await client.executeMultiple(`
      CREATE TABLE platform_connections (
        id TEXT PRIMARY KEY NOT NULL,
        owner_email TEXT NOT NULL,
        platform TEXT NOT NULL,
        display_name TEXT NOT NULL,
        state TEXT NOT NULL,
        encrypted_credentials TEXT NOT NULL,
        credential_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await run({ db: drizzle(client) });
  } finally {
    await client.close();
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EBUSY") throw error;
    }
  }
}

function connection(id, ownerEmail, platform, state) {
  const timestamp = new Date("2026-07-12T00:00:00.000Z");
  return {
    id, ownerEmail, platform, displayName: id, state, encryptedCredentials: "encrypted",
    credentialExpiresAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
}
