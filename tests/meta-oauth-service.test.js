import assert from "node:assert/strict";
import { test } from "node:test";

import { createMetaOAuthService } from "../src/lib/platform-connections/meta-oauth-service.js";

const now = new Date("2026-07-13T00:00:00.000Z");
const env = {
  META_APP_ID: "meta-app-id",
  META_APP_SECRET: "meta-app-secret",
  META_OAUTH_REDIRECT_URI: "https://publisher.example/api/platform-connections/meta/callback",
};

test("start creates an owner-bound transaction and requests only publishing Page scopes", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections: createConnections(), now: () => now });

  const result = await service.start("OWNER@example.com", "/settings?tab=publishing");
  const url = new URL(result.authorizeUrl);

  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/v25.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "meta-app-id");
  assert.equal(url.searchParams.get("redirect_uri"), env.META_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), "pages_show_list,pages_read_engagement,pages_manage_posts");
  assert.equal(transactions.created[0].ownerEmail, "owner@example.com");
  assert.equal(transactions.created[0].returnPath, "/settings?tab=publishing");
  assert.equal(url.searchParams.get("state").includes(transactions.created[0].id), false);
});

test("callback exchanges code, stores pending Page credentials, and never returns Tokens", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({ env, fetchImpl: sequenceFetch([
    { access_token: "short-user-token" },
    { access_token: "long-user-token", expires_in: 5_184_000 },
    { data: [{ id: "page-1", name: "Owner Page", access_token: "page-token" }] },
  ]), transactions, connections: createConnections(), now: () => now });
  const started = await service.start("owner@example.com", "/settings");

  const callbackParams = new URL(started.authorizeUrl).searchParams;
  callbackParams.set("code", "oauth-code");
  const result = await service.completeCallback(callbackParams, "owner@example.com");

  assert.deepEqual(result.pages, [{ id: "page-1", name: "Owner Page" }]);
  assert.equal(JSON.stringify(result).includes("token"), false);
  assert.equal(transactions.created.length, 2);
  assert.equal(transactions.created[1].payload.pages[0].accessToken, "page-token");
  assert.equal(transactions.created[1].payload.longLivedUserAccessToken, "long-user-token");
});

test("callback rejects a session owner that does not match the owner-bound state before token exchange", async () => {
  const transactions = createTransactions();
  let fetchCalls = 0;
  const service = createMetaOAuthService({ env, fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); }, transactions, connections: createConnections(), now: () => now });
  const started = await service.start("owner@example.com", "/settings");

  const callbackParams = new URL(started.authorizeUrl).searchParams;
  callbackParams.set("code", "oauth-code");
  await assert.rejects(
    service.completeCallback(callbackParams, "other@example.com"),
    /expired or already used/i,
  );
  assert.equal(fetchCalls, 0);
});

test("callback handles provider cancellation without echoing provider details", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections: createConnections(), now: () => now });
  const started = await service.start("owner@example.com", "/settings");
  const params = new URL(started.authorizeUrl).searchParams;
  params.set("error", "access_denied");
  params.set("error_description", "provider-private-detail");

  const result = await service.completeCallback(params, "owner@example.com");

  assert.deepEqual(result, { status: "reconnect", returnPath: "/settings" });
  assert.equal(JSON.stringify(result).includes("provider-private-detail"), false);
});

test("callback rejects expired and consumed state", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections: createConnections(), now: () => now });
  const started = await service.start("owner@example.com", "/settings");
  transactions.expire(transactions.created[0].id);

  const callbackParams = new URL(started.authorizeUrl).searchParams;
  callbackParams.set("code", "oauth-code");
  await assert.rejects(service.completeCallback(callbackParams, "owner@example.com"), /expired or already used/i);
});

test("selectPage rejects unavailable Pages and archives the previous default only for its owner", async () => {
  const transactions = createTransactions();
  const connections = createConnections();
  connections.current = { id: "old-meta", platform: "meta", state: "active" };
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections, now: () => now });
  const pending = await transactions.create("owner@example.com", "meta", {
    phase: "page_selection", pages: [{ id: "page-1", name: "Owner Page", accessToken: "page-token" }],
    longLivedUserAccessToken: "long-user-token", expiresAt: "2026-09-11T00:00:00.000Z",
  }, "/settings", now);

  await assert.rejects(service.selectPage("other@example.com", pending.id, "page-1"), /expired or already used/i);
  const anotherPending = await transactions.create("owner@example.com", "meta", {
    phase: "page_selection", pages: [{ id: "page-1", name: "Owner Page", accessToken: "page-token" }],
    longLivedUserAccessToken: "long-user-token", expiresAt: "2026-09-11T00:00:00.000Z",
  }, "/settings", now);
  await assert.rejects(service.selectPage("owner@example.com", anotherPending.id, "other-page"), /not available/i);

  const selected = await service.selectPage("owner@example.com", pending.id, "page-1");
  assert.deepEqual(selected, { platform: "meta", state: "active", displayName: "Owner Page", expiresAt: new Date("2026-09-11T00:00:00.000Z") });
  assert.deepEqual(connections.archived, [["owner@example.com", "old-meta"]]);
  assert.equal(connections.created[0].input.credentials.pageAccessToken, "page-token");
});

function createTransactions() {
  const records = new Map();
  const created = [];
  return {
    created,
    async create(ownerEmail, provider, payload, returnPath) {
      const record = { id: `transaction-${created.length + 1}`, ownerEmail, provider, payload, returnPath, consumed: false, expired: false };
      created.push(record); records.set(record.id, record);
      return { id: record.id, returnPath };
    },
    async consume(ownerEmail, id) {
      const record = records.get(id);
      if (!record || record.ownerEmail !== ownerEmail || record.consumed || record.expired) throw new Error("OAuth transaction is expired or already used.");
      record.consumed = true;
      return record.payload;
    },
    expire(id) { records.get(id).expired = true; },
  };
}

function createConnections() {
  return {
    created: [], archived: [], current: null,
    async getDefault() { return this.current; },
    async create(ownerEmail, input) {
      const connection = { id: `connection-${this.created.length + 1}`, ownerEmail, ...input, state: "active", expiresAt: input.expiresAt ?? null };
      this.created.push({ ownerEmail, input, connection }); this.current = connection;
      return connection;
    },
    async archive(ownerEmail, id) { this.archived.push([ownerEmail, id]); },
  };
}

function sequenceFetch(results) {
  return async () => jsonResponse(results.shift());
}
function jsonResponse(value, ok = true) { return { ok, async json() { return value; } }; }
async function unexpectedFetch() { throw new Error("fetch should not have been called"); }
