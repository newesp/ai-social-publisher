import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createCronRouteHandlers,
  runDuePostScheduler,
} from "../src/lib/scheduler/run-due-post-scheduler.js";
import { publishTargets as publishPlatformTargets } from "../src/lib/platforms/publish-service.js";
import { nextScheduledRetryAt } from "../src/lib/scheduler/retry-schedule.js";

const NOW = new Date("2026-07-11T01:05:00.000Z");

test("next retry follows the next strictly-future 01:00 UTC scheduler occurrence", () => {
  assert.equal(nextScheduledRetryAt(new Date("2026-07-11T00:59:59.999Z")).toISOString(), "2026-07-11T01:00:00.000Z");
  assert.equal(nextScheduledRetryAt(new Date("2026-07-11T01:00:00.000Z")).toISOString(), "2026-07-12T01:00:00.000Z");
  assert.equal(nextScheduledRetryAt(new Date("2026-07-11T23:59:59.999Z")).toISOString(), "2026-07-12T01:00:00.000Z");
});

function claimedPost({ id, ownerEmail = "owner@example.com" }) {
  return {
    id,
    ownerEmail,
    status: "publishing",
    imageImgurUrl: null,
    targets: [{ platform: "meta", platformConnectionId: `meta-${id}`, content: `Post ${id}`, hashtagsJson: "[]", status: "publishing" }],
  };
}

test("scheduler publishes only due rows atomically claimed from scheduled status", async () => {
  const duePost = claimedPost({ id: 1 });
  const stalePublishingPost = claimedPost({ id: 2 });
  let claimCalls = 0;
  const recorded = [];
  const repository = {
    async claimDueScheduledPosts(now) {
      claimCalls += 1;
      assert.equal(now, NOW);
      return [duePost];
    },
    async recordPublishResults(ownerEmail, postId, results) {
      recorded.push({ ownerEmail, postId, results });
      return { ...duePost, status: "published" };
    },
  };

  const result = await runDuePostScheduler({
    repository,
    getConnection: async (ownerEmail, id) => ({ id, ownerEmail, platform: "meta", state: "active", credentials: {} }),
    publishTargets: async () => [{ platform: "meta", status: "published", externalId: "meta-1" }],
    now: NOW,
  });

  assert.equal(claimCalls, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].postId, duePost.id);
  assert.notEqual(recorded[0].postId, stalePublishingPost.id);
  assert.deepEqual(result.posts, [{ id: duePost.id, status: "published" }]);
});

test("scheduler continues after a provider failure and records terminal outcomes", async () => {
  const first = claimedPost({ id: 1, ownerEmail: "first@example.com" });
  const second = claimedPost({ id: 2, ownerEmail: "second@example.com" });
  const recorded = [];
  const repository = {
    async claimDueScheduledPosts() {
      return [first, second];
    },
    async recordPublishResults(ownerEmail, postId, results) {
      recorded.push({ ownerEmail, postId, results });
      return { id: postId, status: results[0].status };
    },
  };

  const result = await runDuePostScheduler({
    repository,
    getConnection: async (ownerEmail, id) => ({ id, ownerEmail, platform: "meta", state: "active", credentials: {} }),
    publishTargets: async ({ targets }) => {
      if (targets[0].publishPayload.message === "Post 1") throw new Error("provider refused");
      return [{ platform: "meta", status: "published", externalId: "meta-2" }];
    },
    now: NOW,
  });

  assert.deepEqual(recorded.map(({ postId, results }) => [postId, results[0].status]), [
    [1, "failed"],
    [2, "published"],
  ]);
  assert.deepEqual(result.posts, [
    { id: 1, status: "failed" },
    { id: 2, status: "published" },
  ]);
});

test("scheduler loads the connection id stored on the scheduled target instead of a current default", async () => {
  const duePost = claimedPost({ id: 7 });
  const loaded = [];
  const repository = {
    async claimDueScheduledPosts() { return [duePost]; },
    async recordPublishResults(_ownerEmail, postId, results) { return { id: postId, status: results[0].status }; },
  };

  await runDuePostScheduler({
    repository,
    getConnection: async (ownerEmail, connectionId) => {
      loaded.push([ownerEmail, connectionId]);
      return { id: connectionId, ownerEmail, platform: "meta", state: "active", credentials: {} };
    },
    publishTargets: async ({ connections }) => {
      assert.equal(connections[0].id, "meta-7");
      return [{ platform: "meta", status: "published", externalId: "external-7" }];
    },
    now: NOW,
  });

  assert.deepEqual(loaded, [["owner@example.com", "meta-7"]]);
});

test("scheduler lifecycle 503 requeues scheduled work instead of terminalizing it", async () => {
  const duePost = { ...claimedPost({ id: 9 }), scheduledFor: new Date("2026-07-11T01:00:00.000Z") };
  const requeued = [];
  const transient = new Error("private validation outage");
  transient.status = 503;
  transient.retryable = true;
  const repository = {
    async claimDueScheduledPosts() { return [duePost]; },
    async requeueClaimedPost(owner, id, status, retryAt) {
      requeued.push([owner, id, status, retryAt]);
      return { ...duePost, status, scheduledFor: retryAt };
    },
  };

  const result = await runDuePostScheduler({ repository, getConnection: async () => { throw transient; }, now: NOW });

  assert.equal(requeued.length, 1);
  assert.deepEqual(requeued[0].slice(0, 3), ["owner@example.com", 9, "scheduled"]);
  assert.equal(requeued[0][3].toISOString(), "2026-07-12T01:00:00.000Z");
  assert.deepEqual(result.posts, [{ id: 9, status: "scheduled" }]);
});

test("scheduler attempts a permanent provider 400 once and records a terminal target", async () => {
  const duePost = claimedPost({ id: 10 });
  let providerCalls = 0;
  const recorded = [];
  const repository = {
    async claimDueScheduledPosts() { return [duePost]; },
    async recordPublishResults(_owner, _id, results) { recorded.push(results); return { ...duePost, status: "failed" }; },
  };
  const result = await runDuePostScheduler({
    repository,
    getConnection: async (ownerEmail, id) => ({ id, ownerEmail, platform: "meta", state: "active", credentials: { pageId: "page", pageAccessToken: "token" } }),
    publishTargets: (args) => publishPlatformTargets({ ...args, fetchImpl: async () => {
      providerCalls += 1;
      return new Response("private invalid payload", { status: 400 });
    } }),
    now: NOW,
  });
  assert.equal(providerCalls, 1);
  assert.equal(recorded[0][0].retryable, undefined);
  assert.deepEqual(result.posts, [{ id: 10, status: "failed" }]);
});

test("scheduler retry completion never republishes a target already confirmed published", async () => {
  const duePost = {
    ...claimedPost({ id: 11 }),
    targets: [
      { platform: "meta", platformConnectionId: "meta-11", content: "done", hashtagsJson: "[]", status: "published" },
      { platform: "line", platformConnectionId: "line-11", content: "retry", hashtagsJson: "[]", status: "publishing" },
    ],
  };
  let providerCalls = 0;
  const repository = {
    async claimDueScheduledPosts() { return [duePost]; },
    async recordPublishResults(_owner, _id, results) {
      assert.deepEqual(results.map((item) => item.platform), ["line"]);
      return { ...duePost, status: "published" };
    },
  };
  const result = await runDuePostScheduler({
    repository,
    getConnection: async (ownerEmail, id) => ({ id, ownerEmail, platform: "line", state: "active", credentials: { accessToken: "token" } }),
    publishTargets: async ({ targets }) => {
      providerCalls += 1;
      assert.deepEqual(targets.map((target) => target.platform), ["line"]);
      return [{ platform: "line", status: "published", externalId: "line-11" }];
    },
    now: NOW,
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(result.posts, [{ id: 11, status: "published" }]);
});

test("scheduler mixed permanent Meta and retryable LINE results retry only LINE on the next run", async () => {
  let targets = [
    { platform: "meta", platformConnectionId: "meta-12", content: "meta", hashtagsJson: "[]", status: "publishing" },
    { platform: "line", platformConnectionId: "line-12", content: "line", hashtagsJson: "[]", status: "publishing" },
  ];
  let run = 0;
  const providerPlatforms = [];
  const repository = {
    async claimDueScheduledPosts() {
      run += 1;
      if (run === 1) return [{ ...claimedPost({ id: 12 }), targets: structuredClone(targets) }];
      targets = targets.map((target) => target.status === "scheduled" ? { ...target, status: "publishing" } : target);
      return [{ ...claimedPost({ id: 12 }), targets: structuredClone(targets) }];
    },
    async recordPublishProgressAndRequeue(_owner, _id, results, status) {
      targets = targets.map((target) => {
        const result = results.find((item) => item.platform === target.platform);
        return result?.retryable ? { ...target, status } : result ? { ...target, status: result.status } : target;
      });
      return { id: 12, status: "scheduled", targets: structuredClone(targets) };
    },
    async recordPublishResults(_owner, _id, results) {
      targets = targets.map((target) => {
        const result = results.find((item) => item.platform === target.platform);
        return result ? { ...target, status: result.status } : target;
      });
      return { id: 12, status: "partial_failed", targets: structuredClone(targets) };
    },
  };
  const publishTargets = async ({ targets: batch }) => {
    providerPlatforms.push(batch.map((target) => target.platform));
    return run === 1
      ? [{ platform: "meta", status: "failed", error: "permanent" }, { platform: "line", status: "failed", error: "transient", retryable: true }]
      : [{ platform: "line", status: "published", externalId: "line-12" }];
  };
  const getConnection = async (ownerEmail, id) => ({ id, ownerEmail, platform: id.startsWith("meta") ? "meta" : "line", state: "active", credentials: {} });

  assert.deepEqual((await runDuePostScheduler({ repository, getConnection, publishTargets, now: NOW })).posts, [{ id: 12, status: "scheduled" }]);
  assert.deepEqual((await runDuePostScheduler({ repository, getConnection, publishTargets, now: new Date("2026-07-12T01:00:00.000Z") })).posts, [{ id: 12, status: "partial_failed" }]);
  assert.deepEqual(providerPlatforms, [["meta", "line"], ["line"]]);
});

test("scheduler composes one connection resolver per invocation", async () => {
  let factories = 0;
  const repository = {
    async claimDueScheduledPosts() { return [claimedPost({ id: 1 }), claimedPost({ id: 2 })]; },
    async recordPublishResults(_owner, id) { return { id, status: "published" }; },
  };
  await runDuePostScheduler({
    repository,
    createGetConnection: () => { factories += 1; return async (ownerEmail, id) => ({ id, ownerEmail, platform: "meta", state: "active", credentials: {} }); },
    publishTargets: async ({ targets }) => targets.map((target) => ({ platform: target.platform, status: "published" })), now: NOW,
  });
  assert.equal(factories, 1);
});

test("cron route fails closed when the secret is absent or Bearer authorization is invalid", async () => {
  let calls = 0;
  const handlersWithoutSecret = createCronRouteHandlers({
    runScheduler: async () => { calls += 1; },
    env: {},
    respond: (body, init) => ({ body, ...init }),
  });
  const handlersWithSecret = createCronRouteHandlers({
    runScheduler: async () => { calls += 1; },
    env: { CRON_SECRET: "cron-secret" },
    respond: (body, init) => ({ body, ...init }),
  });

  assert.equal((await handlersWithoutSecret.GET(new Request("https://app.test/api/cron"))).status, 401);
  assert.equal((await handlersWithSecret.GET(new Request("https://app.test/api/cron", {
    headers: { authorization: "Bearer wrong" },
  }))).status, 401);
  assert.equal(calls, 0);
});

test("cron route accepts exactly the configured Bearer authorization and delegates to scheduler", async () => {
  let calls = 0;
  const handlers = createCronRouteHandlers({
    runScheduler: async () => { calls += 1; return { posts: [{ id: 4, status: "published" }] }; },
    env: { CRON_SECRET: "cron-secret" },
    now: () => NOW,
    respond: (body, init) => ({ body, ...init }),
  });

  const response = await handlers.GET(new Request("https://app.test/api/cron", {
    headers: { authorization: "Bearer cron-secret" },
  }));

  assert.equal(calls, 1);
  assert.deepEqual(response, {
    body: { checkedAt: NOW.toISOString(), posts: [{ id: 4, status: "published" }] },
  });
});

test("cron trigger runs daily at 01:00 UTC and upload route no longer advertises Imgur", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const uploadRoute = await readFile(new URL("../src/app/api/upload/route.js", import.meta.url), "utf8");

  assert.equal(vercel.crons[0].schedule, "0 1 * * *");
  assert.equal(uploadRoute.toLowerCase().includes("imgur"), false);
});
