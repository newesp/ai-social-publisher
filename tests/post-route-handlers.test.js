import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createPublishingConnectionResolver,
  createPostCancellationHandler,
  createPostRouteHandlers,
} from "../src/lib/posts/post-route-handlers.js";

test("publishing connection resolution runs LINE ensureUsable before returning credentials", async () => {
  const calls = [];
  const getConnectionForPublish = createPublishingConnectionResolver({
    connections: {
      async getById(ownerEmail, id) {
        calls.push(["get", ownerEmail, id]);
        return { id, ownerEmail, platform: "line", state: "active", credentials: { accessToken: "old" } };
      },
      async markNeedsReconnect(ownerEmail, id) { calls.push(["mark", ownerEmail, id]); },
    },
    line: {
      async ensureUsable(ownerEmail, id) {
        calls.push(["ensure", ownerEmail, id]);
        return { id, ownerEmail, platform: "line", state: "active", credentials: { accessToken: "renewed" } };
      },
    },
  });

  const connection = await getConnectionForPublish("owner@example.com", "line-1");
  await connection.markNeedsReconnect();

  assert.equal(connection.credentials.accessToken, "renewed");
  assert.deepEqual(calls, [
    ["get", "owner@example.com", "line-1"],
    ["ensure", "owner@example.com", "line-1"],
    ["mark", "owner@example.com", "line-1"],
  ]);
});

function createMemoryRepository() {
  const posts = [];
  const targets = [];
  let id = 1;
  const withTargets = (post) => ({ ...post, targets: targets.filter((target) => target.postId === post.id) });
  return {
    async createPostWithTargets({ post, targetRows }) {
      const created = { ...post, id: id++ };
      posts.push(created);
      targets.push(...targetRows.map((target) => ({ ...target, postId: created.id })));
      return withTargets(created);
    },
    async listPostsByOwner(owner) { return posts.filter((post) => post.ownerEmail === owner).map(withTargets); },
    async findPostByOwner(owner, postId) {
      const post = posts.find((item) => item.ownerEmail === owner && item.id === postId);
      return post ? withTargets(post) : null;
    },
    async cancelScheduledPost(owner, postId, now) {
      const post = posts.find((item) => item.ownerEmail === owner && item.id === postId && item.status === "scheduled");
      if (!post) return null;
      post.status = "cancelled";
      post.updatedAt = now;
      targets.filter((target) => target.postId === postId).forEach((target) => { target.status = "cancelled"; });
      return withTargets(post);
    },
    async claimPostForPublish(owner, postId, now) {
      const post = posts.find((item) => item.ownerEmail === owner && item.id === postId && item.status === "draft");
      if (!post) return null;
      post.status = "publishing";
      post.publishingStartedAt = now;
      targets.filter((target) => target.postId === postId).forEach((target) => { target.status = "publishing"; });
      return withTargets(post);
    },
    async recordPublishResults(owner, postId, results, now) {
      const post = posts.find((item) => item.ownerEmail === owner && item.id === postId);
      for (const result of results) {
        const target = targets.find((item) => item.postId === postId && item.platform === result.platform);
        Object.assign(target, {
          status: result.status,
          externalPostId: result.externalId ?? null,
          errorMessage: result.error ?? null,
          publishedAt: result.status === "published" ? now : null,
        });
      }
      const postTargets = targets.filter((target) => target.postId === postId);
      post.status = postTargets.every((target) => target.status === "published") ? "published" : "failed";
      return withTargets(post);
    },
  };
}

const body = {
  productName: "Demo",
  productFeatures: "Fast",
  targets: [{ platform: "meta", content: "Meta", hashtags: [] }],
};

const resolveConnection = async (ownerEmail, platform) => ({ id: `${platform}-connection`, ownerEmail, platform, state: "active", credentials: {} });
const getConnection = async (ownerEmail, id) => ({ id, ownerEmail, platform: id.split("-", 1)[0], state: "active", credentials: {} });

test("posts handlers derive the owner and keep scheduled requests provider-free", async () => {
  const repository = createMemoryRepository();
  let providerCalls = 0;
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => "owner@example.com",
    getRepository: async () => repository,
    resolveConnection,
    getConnection,
    publishTargets: async () => { providerCalls += 1; return []; },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });

  const response = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "scheduled", scheduledDate: "2026-07-11", scheduledTime: "09:00" }),
  }));
  const listed = await handlers.GET();

  assert.equal(response.status, 201);
  assert.equal(providerCalls, 0);
  assert.equal((await response.json()).post.status, "scheduled");
  assert.equal((await listed.json()).posts.length, 1);
});

test("publish-now handler loads the signed-in owner's bound connection without returning provider errors", async () => {
  const repository = createMemoryRepository();
  const owners = [];
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => "owner@example.com",
    getRepository: async () => repository,
    resolveConnection,
    getConnection: async (owner, id) => { owners.push(owner); return { id, ownerEmail: owner, platform: "meta", state: "active", credentials: { pageAccessToken: "private" } }; },
    publishTargets: async () => [{ platform: "meta", status: "failed", error: "provider refused private" }],
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });

  const response = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "now" }),
  }));
  const data = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(owners, ["owner@example.com"]);
  assert.equal(data.post.status, "failed");
  assert.equal(data.post.targets[0].errorMessage, "Publishing failed.");
});

test("posts API responses never expose an owner email or settings token", async () => {
  const repository = createMemoryRepository();
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => "owner@example.com",
    getRepository: async () => repository,
    resolveConnection,
    getConnection: async (owner, id) => ({ id, ownerEmail: owner, platform: "meta", state: "active", credentials: { pageAccessToken: "owner-token" } }),
    publishTargets: async () => [{
      platform: "meta",
      status: "failed",
      error: "owner@example.com failed with owner-token",
    }],
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });

  const created = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "now" }),
  }));
  const listed = await handlers.GET();

  for (const response of [created, listed]) {
    const payload = JSON.stringify(await response.json());
    assert.equal(payload.includes("owner@example.com"), false);
    assert.equal(payload.includes("owner-token"), false);
  }
});

test("publish-now records a safe failed result when the publisher throws after claim", async () => {
  const repository = createMemoryRepository();
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => "owner@example.com",
    getRepository: async () => repository,
    resolveConnection,
    getConnection,
    publishTargets: async () => { throw new Error("provider failed for owner@example.com Bearer owner-token"); },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });

  const response = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "now" }),
  }));
  const { post } = await response.json();

  assert.equal(response.status, 201);
  assert.equal(post.status, "failed");
  assert.equal(post.targets[0].status, "failed");
  assert.equal(post.targets[0].errorMessage.includes("owner-token"), false);
  assert.equal(post.targets[0].errorMessage.includes("owner@example.com"), false);
});

test("publish-now records a safe failed result when the bound connection cannot be read", async () => {
  const repository = createMemoryRepository();
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => "owner@example.com",
    getRepository: async () => repository,
    resolveConnection,
    getConnection: async () => { throw new Error("connection unavailable for owner@example.com token=owner-token"); },
    publishTargets: async () => { throw new Error("publisher must not run"); },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });

  const response = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "now" }),
  }));
  const { post } = await response.json();

  assert.equal(response.status, 201);
  assert.equal(post.status, "failed");
  assert.equal(post.targets[0].status, "failed");
  assert.equal(post.targets[0].errorMessage.includes("owner-token"), false);
  assert.equal(post.targets[0].errorMessage.includes("owner@example.com"), false);
});

test("cancellation handler conditionally cancels only the current owner's scheduled row", async () => {
  const repository = createMemoryRepository();
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => "owner@example.com",
    getRepository: async () => repository,
    resolveConnection,
    getConnection,
    publishTargets: async () => [],
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });
  const createResponse = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "scheduled", scheduledDate: "2026-07-11", scheduledTime: "09:00" }),
  }));
  const { post } = await createResponse.json();
  const cancel = createPostCancellationHandler({
    requirePublisher: async () => "other@example.com",
    getRepository: async () => repository,
  });

  await assert.rejects(
    cancel(new Request("http://localhost/api/posts/1", { method: "DELETE" }), { params: { id: post.id } }),
    { status: 404 },
  );
  assert.equal((await repository.findPostByOwner("owner@example.com", post.id)).status, "scheduled");
});

test("post handlers bind selected targets through the authenticated owner's resolver", async () => {
  const repository = createMemoryRepository();
  const resolved = [];
  const handlers = createPostRouteHandlers({
    requireAppUser: async () => "owner@example.com",
    requirePublisher: async () => " OWNER@example.com ",
    getRepository: async () => repository,
    resolveConnection: async (ownerEmail, platform) => {
      resolved.push([ownerEmail, platform]);
      return { id: "meta-immutable", ownerEmail, platform, state: "active", credentials: {} };
    },
    getConnection,
    publishTargets: async () => [],
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  });

  const response = await handlers.POST(new Request("http://localhost/api/posts", {
    method: "POST",
    body: JSON.stringify({ ...body, mode: "scheduled", scheduledDate: "2026-07-11", scheduledTime: "09:00" }),
  }));

  assert.equal(response.status, 201);
  assert.deepEqual(resolved, [["owner@example.com", "meta"]]);
  assert.equal(repository.findPostByOwner ? (await repository.findPostByOwner("owner@example.com", 1)).targets[0].platformConnectionId : null, "meta-immutable");
  assert.equal(JSON.stringify(await response.json()).includes("meta-immutable"), false);
});

test("legacy direct publish route is retired instead of accepting a client-controlled post payload", async () => {
  const source = await readFile(new URL("../src/app/api/posts/[id]/publish/route.js", import.meta.url), "utf8");

  assert.equal(source.includes("status: 410"), true);
  assert.equal(source.includes("publishTargets("), false);
  assert.equal(source.includes("readSettings("), false);
});
