import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import { platformConnections, postTargets, posts } from "../src/lib/db/schema.js";
import { createPostRepository } from "../src/lib/posts/post-repository.js";
import { createPlatformConnectionsRepository } from "../src/lib/platform-connections/platform-connections-repository.js";

const NOW = new Date("2026-07-11T01:05:00.000Z");

function createTransactionOnlyDb() {
  let transactions = 0;
  const post = { id: 1, ownerEmail: "owner@example.com", status: "draft" };
  const targets = [{ id: 1, postId: 1, platform: "meta", status: "draft" }];
  const query = (rows) => ({
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    orderBy: async () => rows,
  });
  const tx = {
    insert(table) {
      return {
        values(values) {
          return {
            returning: async () => table === posts ? [{ ...post, ...values }] : values.map((value, index) => ({ id: index + 1, ...value })),
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                returning: async () => [post],
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from(table) {
          return {
            where() {
              if (table === platformConnections) return { limit: async () => [{ id: "meta-connection" }] };
              return query(table === posts ? [post] : targets);
            },
          };
        },
      };
    },
  };
  return {
    db: {
      transaction: async (callback) => {
        transactions += 1;
        return callback(tx);
      },
    },
    transactionCount: () => transactions,
  };
}

test("post repository commits each parent-and-target state transition in one transaction", async () => {
  const fake = createTransactionOnlyDb();
  const repository = createPostRepository(fake.db);
  const now = new Date("2026-07-09T00:00:00.000Z");

  await repository.createPostWithTargets({
    post: { ownerEmail: "owner@example.com", status: "draft", createdAt: now, updatedAt: now },
    targetRows: [{ platform: "meta", platformConnectionId: "meta-connection", status: "draft", createdAt: now, updatedAt: now }],
  });
  await repository.cancelScheduledPost("owner@example.com", 1, now);
  await repository.claimPostForPublish("owner@example.com", 1, now);
  await repository.recordPublishResults("owner@example.com", 1, [{ platform: "meta", status: "failed" }], now);

  assert.equal(fake.transactionCount(), 4);
});

test("claimDueScheduledPosts conditionally claims only due scheduled posts", async () => {
  await withDatabase(async ({ db }) => {
    const due = await insertPost(db, { productName: "due", status: "scheduled", scheduledFor: new Date("2026-07-11T01:00:00.000Z") });
    const future = await insertPost(db, { productName: "future", status: "scheduled", scheduledFor: new Date("2026-07-12T01:00:00.000Z") });
    const stale = await insertPost(db, { productName: "stale", status: "publishing", scheduledFor: new Date("2026-07-10T01:00:00.000Z") });
    const repository = createPostRepository(db);

    const claimed = await repository.claimDueScheduledPosts(NOW);

    assert.deepEqual(claimed.map((post) => post.id), [due.id]);
    assert.equal(claimed[0].status, "publishing");
    assert.equal(claimed[0].targets[0].status, "publishing");
    const rows = await db.select().from(posts);
    assert.equal(rows.find((post) => post.id === future.id).status, "scheduled");
    assert.equal(rows.find((post) => post.id === stale.id).status, "publishing");
  });
});

test("competing claimDueScheduledPosts calls cannot return the same due row", async () => {
  await withDatabase(async ({ db, createRepository }) => {
    const due = await insertPost(db, { productName: "contended", status: "scheduled", scheduledFor: new Date("2026-07-11T01:00:00.000Z") });
    const first = await createRepository();
    const second = await createRepository();

    const [firstClaim, secondClaim] = await Promise.all([
      first.claimDueScheduledPosts(NOW),
      second.claimDueScheduledPosts(NOW),
    ]);

    assert.deepEqual([...firstClaim, ...secondClaim].map((post) => post.id), [due.id]);
  });
});

test("requeueClaimedPost atomically restores scheduled work with bounded backoff", async () => {
  await withDatabase(async ({ db }) => {
    const due = await insertPost(db, { productName: "retry", status: "scheduled", scheduledFor: new Date("2026-07-11T01:00:00.000Z") });
    const repository = createPostRepository(db);
    await repository.claimDueScheduledPosts(NOW);
    const retryAt = new Date("2026-07-11T01:06:00.000Z");

    const retried = await repository.requeueClaimedPost("owner@example.com", due.id, "scheduled", retryAt, NOW);

    assert.equal(retried.status, "scheduled");
    assert.equal(retried.scheduledFor.toISOString(), retryAt.toISOString());
    assert.deepEqual(retried.targets.map((target) => target.status), ["scheduled"]);
  });
});

test("partial publish progress requeues only unfinished targets", async () => {
  await withDatabase(async ({ db }) => {
    const post = await insertPost(db, { productName: "partial", status: "draft", scheduledFor: null });
    await db.insert(postTargets).values(targetValues("line", null, post.id));
    const repository = createPostRepository(db);
    await repository.claimPostForPublish("owner@example.com", post.id, NOW);
    const requeued = await repository.recordPublishProgressAndRequeue("owner@example.com", post.id, [
      { platform: "meta", status: "published", externalId: "meta-1" },
      { platform: "line", status: "failed", retryable: true },
    ], "draft", null, NOW);
    assert.deepEqual(requeued.targets.map((target) => [target.platform, target.status]), [["meta", "published"], ["line", "draft"]]);

    const claimed = await repository.claimPostForPublish("owner@example.com", post.id, NOW);
    assert.deepEqual(claimed.targets.map((target) => [target.platform, target.status]), [["meta", "published"], ["line", "publishing"]]);
  });
});

test("mixed permanent and retryable results persist the permanent failure and schedule only the retryable target", async () => {
  await withDatabase(async ({ db }) => {
    const post = await insertPost(db, { productName: "mixed", status: "draft", scheduledFor: null });
    await db.insert(postTargets).values(targetValues("line", null, post.id));
    const repository = createPostRepository(db);
    await repository.claimPostForPublish("owner@example.com", post.id, NOW);
    const retryAt = new Date("2026-07-12T01:00:00.000Z");
    const requeued = await repository.recordPublishProgressAndRequeue("owner@example.com", post.id, [
      { platform: "meta", status: "failed", error: "meta publishing failed." },
      { platform: "line", status: "failed", error: "line publishing failed.", retryable: true },
    ], "scheduled", retryAt, NOW);
    assert.equal(requeued.status, "scheduled");
    assert.deepEqual(requeued.targets.map((target) => [target.platform, target.status]), [["meta", "failed"], ["line", "scheduled"]]);

    const [claimed] = await repository.claimDueScheduledPosts(retryAt);
    assert.deepEqual(claimed.targets.map((target) => [target.platform, target.status]), [["meta", "failed"], ["line", "publishing"]]);
  });
});

test("final result persistence cannot downgrade an already published target from a stale fallback result", async () => {
  await withDatabase(async ({ db }) => {
    const post = await insertPost(db, { productName: "terminal-guard", status: "publishing", scheduledFor: null });
    const publishedAt = new Date("2026-07-12T01:00:00.000Z");
    await db.update(postTargets).set({ status: "published", externalPostId: "meta-external", publishedAt })
      .where(and(eq(postTargets.postId, post.id), eq(postTargets.platform, "meta")));
    await db.insert(postTargets).values({ ...targetValues("line", null, post.id), status: "publishing" });
    const repository = createPostRepository(db);

    const result = await repository.recordPublishResults("owner@example.com", post.id, [
      { platform: "meta", status: "failed", error: "stale fallback" },
      { platform: "line", status: "failed", error: "current fallback" },
    ], NOW);

    const meta = result.targets.find((target) => target.platform === "meta");
    assert.equal(meta.status, "published");
    assert.equal(meta.externalPostId, "meta-external");
    assert.equal(meta.publishedAt.toISOString(), publishedAt.toISOString());
    assert.equal(result.targets.find((target) => target.platform === "line").status, "failed");
    assert.equal(result.status, "partial_failed");
  });
});

test("createPostWithTargets revalidates stale bindings in its transaction and rolls back the parent", async () => {
  await withDatabase(async ({ db }) => {
    await db.insert(platformConnections).values(connectionRecord("meta-stale", "owner@example.com", "meta", "archived"));
    const repository = createPostRepository(db);

    await assert.rejects(repository.createPostWithTargets({
      post: postValues("owner@example.com", "stale"),
      targetRows: [targetValues("meta", "meta-stale")],
    }), { status: 409, message: "The selected platform connection needs to be reconnected." });

    assert.equal((await db.select().from(posts)).length, 0);
    assert.equal((await db.select().from(postTargets)).length, 0);
  });
});

test("concurrent post binding and disconnect serialize to exactly one safe outcome", async () => {
  await withDatabase(async ({ db, createRepository, createConnectionsRepository }) => {
    await db.insert(platformConnections).values(connectionRecord("meta-race", "owner@example.com", "meta", "active"));
    const postsRepository = await createRepository();
    const connectionsRepository = await createConnectionsRepository();

    const [created, disconnected] = await Promise.allSettled([
      postsRepository.createPostWithTargets({ post: postValues("owner@example.com", "race"), targetRows: [targetValues("meta", "meta-race")] }),
      connectionsRepository.disconnectActiveConnection("owner@example.com", "meta", "cleared", NOW),
    ]);

    const postExists = (await db.select().from(posts)).length === 1;
    const [connection] = await db.select().from(platformConnections);
    assert.equal(postExists && connection.state === "disconnected", false);
    if (created.status === "fulfilled") {
      assert.equal(disconnected.status, "fulfilled");
      assert.equal(disconnected.value.status, "blocked");
      assert.equal(connection.state, "active");
    } else {
      assert.equal(disconnected.status, "fulfilled");
      assert.equal(disconnected.value.status, "disconnected");
      assert.equal(postExists, false);
    }
  });
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-repository-"));
  const url = pathToFileURL(join(directory, "posts.db")).href;
  const primaryClient = createClient({ url });
  const secondaryClients = [];
  const db = drizzle(primaryClient);
  try {
    await createSchema(primaryClient);
    await run({
      db,
      createRepository: async () => {
        const client = createClient({ url });
        secondaryClients.push(client);
        await client.execute("PRAGMA busy_timeout = 1000");
        return createPostRepository(drizzle(client));
      },
      createConnectionsRepository: async () => {
        const client = createClient({ url });
        secondaryClients.push(client);
        await client.execute("PRAGMA busy_timeout = 1000");
        return createPlatformConnectionsRepository(drizzle(client));
      },
    });
  } finally {
    await Promise.all(secondaryClients.map((client) => client.close()));
    await primaryClient.close();
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EBUSY") throw error;
    }
  }
}

async function createSchema(client) {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 1000");
  await client.executeMultiple(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      owner_email TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_features TEXT NOT NULL,
      image_prompt TEXT,
      image_imgur_url TEXT,
      status TEXT NOT NULL,
      scheduled_for INTEGER,
      publishing_started_at INTEGER,
      published_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE post_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      post_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      platform_connection_id TEXT,
      content TEXT NOT NULL,
      hashtags_json TEXT NOT NULL,
      status TEXT NOT NULL,
      external_post_id TEXT,
      error_message TEXT,
      published_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE platform_connections (
      id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform TEXT NOT NULL, display_name TEXT NOT NULL,
      state TEXT NOT NULL, encrypted_credentials TEXT NOT NULL, credential_expires_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, renewal_lease_id TEXT, renewal_lease_expires_at INTEGER
    );
  `);
}

function postValues(ownerEmail, productName) {
  return { ownerEmail, productName, productFeatures: "features", status: "draft", createdAt: NOW, updatedAt: NOW };
}

function targetValues(platform, platformConnectionId, postId) {
  return { ...(postId ? { postId } : {}), platform, platformConnectionId, content: "content", hashtagsJson: "[]", status: "draft", createdAt: NOW, updatedAt: NOW };
}

function connectionRecord(id, ownerEmail, platform, state) {
  return { id, ownerEmail, platform, displayName: id, state, encryptedCredentials: "encrypted", createdAt: NOW, updatedAt: NOW };
}

async function insertPost(db, { productName, status, scheduledFor }) {
  const [post] = await db.insert(posts).values({
    ownerEmail: "owner@example.com",
    productName,
    productFeatures: "features",
    imagePrompt: null,
    imageImgurUrl: null,
    status,
    scheduledFor,
    publishingStartedAt: null,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await db.insert(postTargets).values({
    postId: post.id,
    platform: "meta",
    content: productName,
    hashtagsJson: "[]",
    status,
    externalPostId: null,
    errorMessage: null,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return post;
}
