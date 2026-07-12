import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { postTargets, posts } from "../src/lib/db/schema.js";
import { createPostRepository } from "../src/lib/posts/post-repository.js";

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
            where() { return query(table === posts ? [post] : targets); },
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
    targetRows: [{ platform: "meta", status: "draft", createdAt: now, updatedAt: now }],
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
      content TEXT NOT NULL,
      hashtags_json TEXT NOT NULL,
      status TEXT NOT NULL,
      external_post_id TEXT,
      error_message TEXT,
      published_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
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
