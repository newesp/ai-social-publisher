import assert from "node:assert/strict";
import test from "node:test";

import { cancelScheduledPost, loadPostHistory } from "../src/lib/history/post-history.js";

test("loads owner history from the posts API", async () => {
  const posts = [{ id: 7, status: "scheduled" }];
  const result = await loadPostHistory(async (url) => {
    assert.equal(url, "/api/posts");
    return { ok: true, json: async () => ({ posts }) };
  });

  assert.deepEqual(result, posts);
});

test("cancels a scheduled post through its owner-scoped API endpoint", async () => {
  const post = { id: 7, status: "cancelled" };
  const result = await cancelScheduledPost(async (url, options) => {
    assert.equal(url, "/api/posts/7");
    assert.equal(options.method, "DELETE");
    return { ok: true, json: async () => ({ post }) };
  }, 7);

  assert.deepEqual(result, post);
});
