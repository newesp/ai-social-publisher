import assert from "node:assert/strict";
import { test } from "node:test";

import { createPlatformConnectionRouteHandlers } from "../src/lib/platform-connections/platform-connection-route-handlers.js";

test("availability is scoped to the authenticated owner and never returns credentials", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ connections: { async listAvailability(ownerEmail) { calls.push(ownerEmail); return [{ platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null, credentials: { pageAccessToken: "secret" } }]; } } }),
  });

  const response = await handlers.GET();
  const body = await response.json();
  assert.deepEqual(calls, ["owner@example.com"]);
  assert.deepEqual(body, { connections: [{ platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null }] });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("POST handlers reject cross-origin requests before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });
  const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST", headers: { origin: "https://attacker.example" }, body: "{}",
  });

  await assert.rejects(handlers.startMeta(request), (error) => error.status === 403 && /origin/i.test(error.message));
  assert.equal(storesCreated, 0);
});

test("Meta selection passes only the authenticated owner and returns a safe connection", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async selectPage(...args) { calls.push(args); return { platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null, credentials: { pageAccessToken: "secret" } }; } } }),
  });
  const response = await handlers.selectMeta(new Request("https://publisher.example/api/platform-connections/meta/select", {
    method: "POST", headers: { origin: "https://publisher.example" }, body: JSON.stringify({ transactionId: "transaction-1", pageId: "page-1" }),
  }));
  const body = await response.json();

  assert.deepEqual(calls, [["owner@example.com", "transaction-1", "page-1"]]);
  assert.deepEqual(body, { connection: { platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null } });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("Meta callback turns a provider cancellation into a generic settings redirect", async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async completeCallback() { return { status: "reconnect", returnPath: "/settings?tab=publishing", providerDetail: "do-not-leak" }; } } }),
  });

  const response = await handlers.completeMeta(new Request("https://publisher.example/api/platform-connections/meta/callback?error=access_denied"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://publisher.example/settings?tab=publishing&meta=reconnect");
  assert.equal(response.headers.get("location").includes("do-not-leak"), false);
});

test("Meta callback redirects only an opaque picker transaction to settings", async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async completeCallback() { return {
      status: "select_page", transactionId: "transaction-1", returnPath: "/settings?tab=publishing",
      pages: [{ id: "page-1", name: "Owner Page", accessToken: "secret" }],
    }; } } }),
  });

  const response = await handlers.completeMeta(new Request("https://publisher.example/api/platform-connections/meta/callback?code=code"));
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/settings");
  assert.equal(location.searchParams.get("meta"), "select");
  assert.equal(location.searchParams.get("transactionId"), "transaction-1");
  assert.equal(location.searchParams.get("pages"), null);
  assert.equal(location.toString().includes("secret"), false);
});

test("Meta pending Page route obtains choices only for the authenticated owner and redacts credentials", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async getPendingPages(...args) { calls.push(args); return [{ id: "page-1", name: "Owner Page", accessToken: "secret" }]; } } }),
  });

  const response = await handlers.getMetaPending(new Request("https://publisher.example/api/platform-connections/meta/pending?transactionId=transaction-1"));
  const body = await response.json();
  assert.deepEqual(calls, [["owner@example.com", "transaction-1"]]);
  assert.deepEqual(body, { pages: [{ id: "page-1", name: "Owner Page" }] });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("LINE connect is owner-scoped, same-origin protected, and returns only safe availability", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ line: { async connect(...args) { calls.push(args); return {
      id: "connection-1", ownerEmail: "owner@example.com", platform: "line", state: "active", displayName: "Owner OA",
      expiresAt: new Date("2026-08-12T00:00:00.000Z"), credentials: { channelSecret: "secret", accessToken: "token" },
    }; } } }),
  });

  const response = await handlers.connectLine(new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST", headers: { origin: "https://publisher.example", "content-type": "application/json" }, body: JSON.stringify({ channelId: "channel-id", channelSecret: "channel-secret" }),
  }));
  const body = await response.json();

  assert.deepEqual(calls, [["owner@example.com", { channelId: "channel-id", channelSecret: "channel-secret" }]]);
  assert.deepEqual(body, { connection: { platform: "line", state: "active", displayName: "Owner OA", expiresAt: "2026-08-12T00:00:00.000Z" } });
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(JSON.stringify(body).includes("token"), false);
});

test("LINE connect rejects cross-origin requests before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });
  const request = new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST", headers: { origin: "https://attacker.example" }, body: "{}",
  });

  await assert.rejects(handlers.connectLine(request), (error) => error.status === 403 && /origin/i.test(error.message));
  assert.equal(storesCreated, 0);
});

test("LINE connect accepts only a Channel ID and Channel Secret JSON object", async () => {
  let calls = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ line: { async connect() { calls += 1; } } }),
  });
  const request = new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST", headers: { origin: "https://publisher.example", "content-type": "application/json" },
    body: JSON.stringify({ channelId: "channel-id", channelSecret: "channel-secret", unexpected: "value" }),
  });

  await assert.rejects(handlers.connectLine(request), (error) => error.status === 400 && /channel id.*channel secret/i.test(error.message));
  assert.equal(calls, 0);
});
