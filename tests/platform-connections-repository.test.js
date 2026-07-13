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

test("Meta selection atomically deletes one valid OAuth row and replaces the default", async () => {
  await withDatabase(async ({ db, createRepository }) => {
    const repository = createPlatformConnectionsRepository(db);
    const timestamp = new Date("2026-07-13T00:00:00.000Z");
    await repository.createOAuthTransaction({
      id: "picker-1", ownerEmail: "owner@example.com", provider: "meta", encryptedPayload: "encrypted",
      returnPath: "/settings", expiresAt: new Date("2026-07-13T00:10:00.000Z"), consumedAt: null, createdAt: timestamp,
    });
    await db.insert(platformConnections).values(connection("old-meta", "owner@example.com", "meta", "active"));

    const other = await createRepository();
    const [first, second] = await Promise.all([
      repository.replaceDefaultConnectionFromOAuth(connection("new-meta-a", "owner@example.com", "meta", "active"), "picker-1", "owner@example.com", "meta", timestamp),
      other.replaceDefaultConnectionFromOAuth(connection("new-meta-b", "owner@example.com", "meta", "active"), "picker-1", "owner@example.com", "meta", timestamp),
    ]);

    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal(await repository.findOAuthTransactionByIdAndOwner("picker-1", "owner@example.com", timestamp), null);
    const rows = await db.select().from(platformConnections);
    assert.equal(rows.filter((row) => row.state === "active").length, 1);
  });
});

test("failed Meta replacement rolls back OAuth deletion and expired purge is bounded", async () => {
  await withDatabase(async ({ db }) => {
    const repository = createPlatformConnectionsRepository(db);
    const now = new Date("2026-07-13T00:00:00.000Z");
    await db.insert(platformConnections).values(connection("duplicate-id", "owner@example.com", "meta", "active"));
    await repository.createOAuthTransaction({ id: "retry-picker", ownerEmail: "owner@example.com", provider: "meta", encryptedPayload: "encrypted", returnPath: "/settings", expiresAt: new Date(now.getTime() + 60_000), consumedAt: null, createdAt: now });
    await assert.rejects(repository.replaceDefaultConnectionFromOAuth(connection("duplicate-id", "owner@example.com", "meta", "active"), "retry-picker", "owner@example.com", "meta", now));
    assert.notEqual(await repository.findOAuthTransactionByIdAndOwner("retry-picker", "owner@example.com", now), null);
    assert.equal((await db.select().from(platformConnections))[0].state, "active");

    for (let index = 0; index < 101; index += 1) {
      await repository.createOAuthTransaction({ id: `expired-${index}`, ownerEmail: "owner@example.com", provider: "meta", encryptedPayload: "encrypted", returnPath: "/settings", expiresAt: new Date(now.getTime() - 1), consumedAt: null, createdAt: now });
    }
    assert.equal(await repository.purgeExpiredOAuthTransactions(now), 100);
    assert.equal(await repository.purgeExpiredOAuthTransactions(now), 1);
  });
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "platform-connections-repository-"));
  const url = pathToFileURL(join(directory, "connections.db")).href;
  const client = createClient({ url });
  const secondaryClients = [];
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
      CREATE TABLE oauth_transactions (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, provider TEXT NOT NULL, encrypted_payload TEXT NOT NULL,
        return_path TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
      );
    `);
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 1000");
    await run({ db: drizzle(client), createRepository: async () => {
      const secondary = createClient({ url }); secondaryClients.push(secondary);
      await secondary.execute("PRAGMA busy_timeout = 1000");
      return createPlatformConnectionsRepository(drizzle(secondary));
    } });
  } finally {
    await Promise.all(secondaryClients.map((secondary) => secondary.close()));
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
