import assert from "node:assert/strict";
import { test } from "node:test";

import { posts, postTargets } from "../src/lib/db/schema.js";
import { createPostRepository } from "../src/lib/posts/post-repository.js";

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
