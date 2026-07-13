import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createCronRouteHandlers,
  runDuePostScheduler,
} from "../src/lib/scheduler/run-due-post-scheduler.js";

const NOW = new Date("2026-07-11T01:05:00.000Z");

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
