import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { platformConnections, postTargets, posts } from "../src/lib/db/schema.js";
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

test("disconnectActiveConnection blocks non-terminal bound targets without mutating credentials", async () => {
  await withDatabase(async ({ db }) => {
    const repository = createPlatformConnectionsRepository(db);
    await db.insert(platformConnections).values(connection("owner-meta", "owner@example.com", "meta", "active"));
    const [post] = await db.insert(posts).values(postRecord("owner@example.com", "scheduled")).returning();
    await db.insert(postTargets).values(targetRecord(post.id, "owner-meta", "scheduled"));

    const result = await repository.disconnectActiveConnection("owner@example.com", "meta", "cleared", new Date("2026-07-13T00:00:00.000Z"));

    assert.deepEqual(result, { status: "blocked" });
    const [stored] = await db.select().from(platformConnections);
    assert.equal(stored.state, "active");
    assert.equal(stored.encryptedCredentials, "encrypted");
  });
});

test("disconnectActiveConnection clears only the owner's unblocked active connection and preserves terminal history", async () => {
  await withDatabase(async ({ db }) => {
    const repository = createPlatformConnectionsRepository(db);
    await db.insert(platformConnections).values([
      connection("owner-meta", "owner@example.com", "meta", "active"),
      connection("other-meta", "other@example.com", "meta", "active"),
    ]);
    const [post] = await db.insert(posts).values(postRecord("owner@example.com", "published")).returning();
    await db.insert(postTargets).values(targetRecord(post.id, "owner-meta", "published"));

    const result = await repository.disconnectActiveConnection("owner@example.com", "meta", "cleared", new Date("2026-07-13T00:00:00.000Z"));

    assert.equal(result.status, "disconnected");
    assert.equal(result.connection.id, "owner-meta");
    const rows = await db.select().from(platformConnections);
    assert.equal(rows.find((row) => row.id === "owner-meta").state, "disconnected");
    assert.equal(rows.find((row) => row.id === "owner-meta").encryptedCredentials, "cleared");
    assert.equal(rows.find((row) => row.id === "other-meta").state, "active");
    assert.equal((await db.select().from(postTargets))[0].platformConnectionId, "owner-meta");
    assert.deepEqual(await repository.disconnectActiveConnection("owner@example.com", "meta", "cleared", new Date()), { status: "not_found" });
  });
});

test("renewal lease CAS allows one winner, preserves archived state, and permits stale recovery", async () => {
  await withDatabase(async ({ db }) => {
    const repository = createPlatformConnectionsRepository(db);
    await db.insert(platformConnections).values(connection("archived-line", "owner@example.com", "line", "archived"));
    const now = new Date("2026-07-13T00:00:00.000Z");
    const expires = new Date("2026-07-13T00:02:00.000Z");

    const [first, second] = await Promise.all([
      repository.acquireRenewalLease("archived-line", "owner@example.com", "lease-a", expires, now),
      repository.acquireRenewalLease("archived-line", "owner@example.com", "lease-b", expires, now),
    ]);
    const winner = first ?? second;
    const loser = first ? second : first;
    assert.equal(Boolean(winner), true);
    assert.equal(loser, null);
    assert.equal(winner.state, "archived");
    assert.equal(await repository.completeRenewalLease("archived-line", "other@example.com", winner.renewalLeaseId, { encryptedCredentials: "foreign" }), null);
    const completed = await repository.completeRenewalLease("archived-line", "owner@example.com", winner.renewalLeaseId, { encryptedCredentials: "renewed", updatedAt: now });
    assert.equal(completed.state, "archived");
    assert.equal(completed.encryptedCredentials, "renewed");

    await repository.acquireRenewalLease("archived-line", "owner@example.com", "crashed", new Date("2026-07-12T00:00:00.000Z"), now);
    const recovered = await repository.acquireRenewalLease("archived-line", "owner@example.com", "recovered", expires, now);
    assert.equal(recovered.renewalLeaseId, "recovered");
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
        updated_at INTEGER NOT NULL,
        renewal_lease_id TEXT,
        renewal_lease_expires_at INTEGER
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, owner_email TEXT NOT NULL, product_name TEXT NOT NULL,
        product_features TEXT NOT NULL, image_prompt TEXT, image_imgur_url TEXT, status TEXT NOT NULL,
        scheduled_for INTEGER, publishing_started_at INTEGER, published_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE post_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, post_id INTEGER NOT NULL, platform TEXT NOT NULL,
        platform_connection_id TEXT, content TEXT NOT NULL, hashtags_json TEXT NOT NULL, status TEXT NOT NULL,
        external_post_id TEXT, error_message TEXT, published_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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

function postRecord(ownerEmail, status) {
  const timestamp = new Date("2026-07-12T00:00:00.000Z");
  return { ownerEmail, productName: "demo", productFeatures: "demo", status, createdAt: timestamp, updatedAt: timestamp };
}

function targetRecord(postId, platformConnectionId, status) {
  const timestamp = new Date("2026-07-12T00:00:00.000Z");
  return { postId, platform: "meta", platformConnectionId, content: "demo", hashtagsJson: "[]", status, createdAt: timestamp, updatedAt: timestamp };
}

function connection(id, ownerEmail, platform, state) {
  const timestamp = new Date("2026-07-12T00:00:00.000Z");
  return {
    id, ownerEmail, platform, displayName: id, state, encryptedCredentials: "encrypted",
    credentialExpiresAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
}
