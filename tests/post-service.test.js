import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cancelScheduledPost,
  createPost,
  listPosts,
  publishPost,
} from "../src/lib/posts/post-service.js";

function createMemoryRepository() {
  const posts = [];
  const targets = [];
  let nextPostId = 1;

  function withTargets(post) {
    return {
      ...post,
      targets: targets.filter((target) => target.postId === post.id).map((target) => ({ ...target })),
    };
  }

  return {
    posts,
    targets,
    async createPostWithTargets({ post, targetRows }) {
      const created = { ...post, id: nextPostId++ };
      posts.push(created);
      targets.push(...targetRows.map((target) => ({ ...target, postId: created.id })));
      return withTargets(created);
    },
    async listPostsByOwner(ownerEmail) {
      return posts.filter((post) => post.ownerEmail === ownerEmail).map(withTargets);
    },
    async findPostByOwner(ownerEmail, id) {
      const post = posts.find((item) => item.ownerEmail === ownerEmail && item.id === id);
      return post ? withTargets(post) : null;
    },
    async cancelScheduledPost(ownerEmail, id, now) {
      const post = posts.find(
        (item) => item.ownerEmail === ownerEmail && item.id === id && item.status === "scheduled",
      );
      if (!post) return null;
      post.status = "cancelled";
      post.updatedAt = now;
      for (const target of targets.filter((item) => item.postId === id)) {
        target.status = "cancelled";
        target.updatedAt = now;
      }
      return withTargets(post);
    },
    async claimPostForPublish(ownerEmail, id, now) {
      const post = posts.find(
        (item) => item.ownerEmail === ownerEmail && item.id === id && item.status === "draft",
      );
      if (!post) return null;
      post.status = "publishing";
      post.publishingStartedAt = now;
      post.updatedAt = now;
      for (const target of targets.filter((item) => item.postId === id)) target.status = "publishing";
      return withTargets(post);
    },
    async recordPublishResults(ownerEmail, id, results, now) {
      const post = posts.find((item) => item.ownerEmail === ownerEmail && item.id === id);
      for (const result of results) {
        const target = targets.find((item) => item.postId === id && item.platform === result.platform);
        target.status = result.status;
        target.externalPostId = result.externalId ?? null;
        target.errorMessage = result.error ?? null;
        target.publishedAt = result.status === "published" ? now : null;
        target.updatedAt = now;
      }
      const updatedTargets = targets.filter((item) => item.postId === id);
      post.status = updatedTargets.every((item) => item.status === "published")
        ? "published"
        : updatedTargets.some((item) => item.status === "published")
          ? "partial_failed"
          : "failed";
      post.publishedAt = post.status === "published" ? now : null;
      post.updatedAt = now;
      return withTargets(post);
    },
  };
}

const input = {
  productName: "Demo Product",
  productFeatures: "Fast setup",
  imageUrl: "https://blob.example/image.jpg",
  targets: [
    { platform: "meta", content: "Meta text", hashtags: ["demo"] },
    { platform: "line", content: "LINE text", hashtags: [] },
    { platform: "instagram", content: "Hidden target", hashtags: [] },
  ],
};

const defaultConnections = {
  meta: { id: "meta-connection", ownerEmail: "owner@example.com", platform: "meta", state: "active", credentials: { pageId: "page-id", pageAccessToken: "meta-token" } },
  line: { id: "line-connection", ownerEmail: "owner@example.com", platform: "line", state: "active", credentials: { accessToken: "line-token" } },
};

async function resolveConnection(ownerEmail, platform) {
  return { ...defaultConnections[platform], ownerEmail };
}

test("lists only posts owned by the signed-in owner", async () => {
  const repository = createMemoryRepository();
  await createPost({ ownerEmail: "owner@example.com", input, mode: "now", repository, resolveConnection });
  await createPost({ ownerEmail: "other@example.com", input, mode: "now", repository, resolveConnection });

  const posts = await listPosts({ ownerEmail: " OWNER@example.com ", repository });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].ownerEmail, "owner@example.com");
  assert.deepEqual(posts[0].targets.map((target) => target.platform), ["meta", "line"]);
});

test("cancels only the owner's scheduled post while leaving another owner's row unchanged", async () => {
  const repository = createMemoryRepository();
  const post = await createPost({
    ownerEmail: "owner@example.com",
    input: { ...input, scheduledDate: "2026-07-11", scheduledTime: "09:00" },
    mode: "scheduled",
    repository,
    resolveConnection,
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  await assert.rejects(
    cancelScheduledPost({ ownerEmail: "other@example.com", postId: post.id, repository }),
    { status: 404 },
  );
  const cancelled = await cancelScheduledPost({ ownerEmail: "owner@example.com", postId: post.id, repository });

  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.targets.map((target) => target.status), ["cancelled", "cancelled"]);
});

test("creates a scheduled post without invoking the publish runner", async () => {
  const repository = createMemoryRepository();
  let publishCalls = 0;

  const post = await createPost({
    ownerEmail: "owner@example.com",
    input: { ...input, scheduledDate: "2026-07-11", scheduledTime: "09:00" },
    mode: "scheduled",
    repository,
    resolveConnection,
    publish: async () => { publishCalls += 1; },
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  assert.equal(publishCalls, 0);
  assert.equal(post.status, "scheduled");
  assert.equal(post.scheduledFor.toISOString(), "2026-07-11T01:00:00.000Z");
  assert.deepEqual(post.targets.map((target) => target.status), ["scheduled", "scheduled"]);
});

test("persists immediate publish outcomes from the injected publisher", async () => {
  const repository = createMemoryRepository();
  const created = await createPost({ ownerEmail: "owner@example.com", input, mode: "now", repository, resolveConnection });

  const post = await publishPost({
    ownerEmail: "owner@example.com",
    postId: created.id,
    repository,
    getConnection: async (ownerEmail, connectionId) => {
      assert.equal(ownerEmail, "owner@example.com");
      return Object.values(defaultConnections).find((connection) => connection.id === connectionId);
    },
    publishTargets: async ({ targets, connections }) => {
      assert.deepEqual(targets.map((target) => target.platform), ["meta", "line"]);
      assert.deepEqual(connections.map((connection) => connection.id), ["meta-connection", "line-connection"]);
      return [
        { platform: "meta", status: "published", externalId: "meta-1" },
        { platform: "line", status: "failed", error: "LINE rejected the request" },
      ];
    },
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  assert.equal(post.status, "partial_failed");
  assert.deepEqual(post.targets.map((target) => [target.platform, target.status, target.errorMessage]), [
    ["meta", "published", null],
    ["line", "failed", "LINE rejected the request"],
  ]);
});

test("persists a terminal failed result for every claimed target omitted by the publisher", async () => {
  const repository = createMemoryRepository();
  const created = await createPost({ ownerEmail: "owner@example.com", input, mode: "now", repository, resolveConnection });

  const post = await publishPost({
    ownerEmail: "owner@example.com",
    postId: created.id,
    repository,
    getConnection: async (_ownerEmail, connectionId) => Object.values(defaultConnections).find((connection) => connection.id === connectionId),
    publishTargets: async () => [{ platform: "meta", status: "published", externalId: "meta-1" }],
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  assert.deepEqual(post.targets.map((target) => target.status), ["published", "failed"]);
  assert.equal(post.targets[1].errorMessage, "Publishing did not return a terminal result.");
  assert.equal(post.status, "partial_failed");
});

test("binds each selected platform target to the owner's active default connection", async () => {
  const repository = createMemoryRepository();
  const calls = [];

  const post = await createPost({
    ownerEmail: " OWNER@example.com ", input, mode: "now", repository,
    resolveConnection: async (ownerEmail, platform) => {
      calls.push([ownerEmail, platform]);
      return { id: `${platform}-v1`, ownerEmail, platform, state: "active", credentials: {} };
    },
  });

  assert.deepEqual(calls, [["owner@example.com", "meta"], ["owner@example.com", "line"]]);
  assert.deepEqual(post.targets.map((target) => target.platformConnectionId), ["meta-v1", "line-v1"]);
});

test("rejects unavailable or unusable default connections before creating any rows", async () => {
  const invalidConnections = [
    null,
    { id: "foreign", ownerEmail: "other@example.com", platform: "meta", state: "active" },
    { id: "archived", ownerEmail: "owner@example.com", platform: "meta", state: "archived" },
    { id: "reconnect", ownerEmail: "owner@example.com", platform: "meta", state: "needs_reconnect" },
  ];

  for (const connection of invalidConnections) {
    const repository = createMemoryRepository();
    await assert.rejects(
      createPost({
        ownerEmail: "owner@example.com",
        input: { ...input, targets: [input.targets[0]] },
        mode: "now",
        repository,
        resolveConnection: async () => connection,
      }),
      { status: 409, message: "The selected platform connection needs to be reconnected." },
    );
    assert.equal(repository.posts.length, 0);
    assert.equal(repository.targets.length, 0);
  }
});

test("scheduled publishing uses the immutable stored connection after the default changes", async () => {
  const repository = createMemoryRepository();
  let currentDefault = "meta-v1";
  const created = await createPost({
    ownerEmail: "owner@example.com",
    input: { ...input, targets: [input.targets[0]], scheduledDate: "2026-07-11", scheduledTime: "09:00" },
    mode: "scheduled",
    repository,
    resolveConnection: async (ownerEmail, platform) => ({ id: currentDefault, ownerEmail, platform, state: "active" }),
    now: new Date("2026-07-09T00:00:00.000Z"),
  });
  currentDefault = "meta-v2";
  repository.posts[0].status = "draft";
  const loaded = [];

  await publishPost({
    ownerEmail: "owner@example.com", postId: created.id, repository,
    getConnection: async (ownerEmail, id) => {
      loaded.push([ownerEmail, id]);
      return { id, ownerEmail, platform: "meta", state: "archived", credentials: {} };
    },
    publishTargets: async () => [{ platform: "meta", status: "published", externalId: "post-1" }],
  });

  assert.deepEqual(loaded, [["owner@example.com", "meta-v1"]]);
});

test("a pre-feature target without a connection id fails safely without any fallback lookup", async () => {
  const repository = createMemoryRepository();
  const created = await createPost({
    ownerEmail: "owner@example.com", input: { ...input, targets: [input.targets[0]] }, mode: "now", repository, resolveConnection,
  });
  repository.targets[0].platformConnectionId = null;
  let lookupCalls = 0;
  let publishCalls = 0;

  const post = await publishPost({
    ownerEmail: "owner@example.com", postId: created.id, repository,
    getConnection: async () => { lookupCalls += 1; throw new Error("must not resolve a default"); },
    publishTargets: async () => { publishCalls += 1; return []; },
  });

  assert.equal(lookupCalls, 0);
  assert.equal(publishCalls, 0);
  assert.equal(post.targets[0].status, "failed");
  assert.equal(post.targets[0].errorMessage, "The selected platform connection needs to be reconnected.");
});

test("redacts nested connection credentials before persisting a publisher error", async () => {
  const repository = createMemoryRepository();
  const created = await createPost({
    ownerEmail: "owner@example.com", input: { ...input, targets: [input.targets[0]] }, mode: "now", repository, resolveConnection,
  });

  const post = await publishPost({
    ownerEmail: "owner@example.com", postId: created.id, repository,
    getConnection: async (ownerEmail, id) => ({
      id, ownerEmail, platform: "meta", state: "active",
      credentials: { pageAccessToken: "deep-private-token", nested: { appSecret: "deep-private-secret" } },
    }),
    publishTargets: async () => [{
      platform: "meta", status: "failed", error: "deep-private-token deep-private-secret owner@example.com",
    }],
  });

  assert.equal(post.targets[0].errorMessage.includes("deep-private-token"), false);
  assert.equal(post.targets[0].errorMessage.includes("deep-private-secret"), false);
  assert.equal(post.targets[0].errorMessage.includes("owner@example.com"), false);
});
