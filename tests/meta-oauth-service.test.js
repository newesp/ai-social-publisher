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
  assert.equal(url.searchParams.get("state"), transactions.created[0].id);
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
  const result = await service.completeCallback("owner@example.com", callbackParams);

  assert.deepEqual(result.pages, [{ id: "page-1", name: "Owner Page" }]);
  assert.equal(JSON.stringify(result).includes("token"), false);
  assert.equal(transactions.created.length, 2);
  assert.equal(transactions.created[1].payload.pages[0].accessToken, "page-token");
  assert.equal(transactions.created[1].payload.longLivedUserAccessToken, "long-user-token");
});

test("callback consumes the opaque state only for the authenticated owner before token exchange", async () => {
  const transactions = createTransactions();
  let fetchCalls = 0;
  const service = createMetaOAuthService({ env, fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); }, transactions, connections: createConnections(), now: () => now });
  const started = await service.start("owner@example.com", "/settings");

  const callbackParams = new URL(started.authorizeUrl).searchParams;
  callbackParams.set("code", "oauth-code");
  await assert.rejects(
    service.completeCallback("other@example.com", callbackParams),
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

  const result = await service.completeCallback("owner@example.com", params);

  assert.deepEqual(result, { status: "reconnect", returnPath: "/settings" });
  assert.equal(JSON.stringify(result).includes("provider-private-detail"), false);
});

test("callback never exposes a provider URL containing the app secret when transport fails", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({
    env,
    fetchImpl: async (url) => { throw new Error(`request failed: ${url}`); },
    transactions,
    connections: createConnections(),
    now: () => now,
  });
  const started = await service.start("owner@example.com", "/settings");
  const callbackParams = new URL(started.authorizeUrl).searchParams;
  callbackParams.set("code", "private-oauth-code");

  await assert.rejects(service.completeCallback("owner@example.com", callbackParams), (error) => {
    assert.equal(error.message, "Meta connection could not be completed.");
    assert.equal(error.message.includes(env.META_APP_SECRET), false);
    assert.equal(error.message.includes("private-oauth-code"), false);
    return true;
  });
});

test("callback rejects expired and consumed state", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections: createConnections(), now: () => now });
  const started = await service.start("owner@example.com", "/settings");
  transactions.expire(transactions.created[0].id);

  const callbackParams = new URL(started.authorizeUrl).searchParams;
  callbackParams.set("code", "oauth-code");
  await assert.rejects(service.completeCallback("owner@example.com", callbackParams), /expired or already used/i);
});

test("selectPage rejects unavailable Pages and atomically replaces only the current owner's default", async () => {
  const transactions = createTransactions();
  const connections = createConnections();
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections, now: () => now });
  const pending = await transactions.create("owner@example.com", "meta", {
    phase: "page_selection", pages: [{ id: "page-1", name: "Owner Page", accessToken: "page-token" }],
    longLivedUserAccessToken: "long-user-token", expiresAt: "2026-09-11T00:00:00.000Z",
  }, "/settings", now);

  await assert.rejects(service.selectPage("other@example.com", pending.id, "page-1"), /expired or already used/i);
  await assert.rejects(service.selectPage("owner@example.com", pending.id, "other-page"), /not available/i);

  const selected = await service.selectPage("owner@example.com", pending.id, "page-1");
  assert.deepEqual(selected, { platform: "meta", state: "active", displayName: "Owner Page", expiresAt: new Date("2026-09-11T00:00:00.000Z") });
  assert.equal(connections.replaced.length, 1);
  assert.equal(connections.replaced[0].ownerEmail, "owner@example.com");
  assert.equal(connections.replaced[0].input.credentials.pageAccessToken, "page-token");
});

test("pending Page choices stay owner-scoped and omit credentials", async () => {
  const transactions = createTransactions();
  const service = createMetaOAuthService({ env, fetchImpl: unexpectedFetch, transactions, connections: createConnections(), now: () => now });
  const pending = await transactions.create("owner@example.com", "meta", {
    phase: "page_selection", pages: [{ id: "page-1", name: "Owner Page", accessToken: "page-token" }],
  }, "/settings", now);

  assert.deepEqual(await service.getPendingPages("owner@example.com", pending.id), [{ id: "page-1", name: "Owner Page" }]);
  await assert.rejects(service.getPendingPages("other@example.com", pending.id), /expired or already used/i);
});

test("ensureUsable validates the bound Page with Graph v25 and an Authorization header", async () => {
  const connections = createLifecycleConnections([metaConnection()]);
  const calls = [];
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: async (url, options) => {
    calls.push([String(url), options]);
    return jsonResponse({ id: "page-1" });
  } });

  const usable = await service.ensureUsable("owner@example.com", "meta-1");

  assert.equal(usable.credentials.pageAccessToken, "page-token");
  assert.equal(calls[0][0], "https://graph.facebook.com/v25.0/page-1?fields=id");
  assert.equal(calls[0][1].headers.Authorization, "Bearer page-token");
  assert.equal(calls.length, 1);
});

test("ensureUsable recovers a rejected Page token through retained User authorization", async () => {
  const connections = createLifecycleConnections([metaConnection()]);
  const calls = [];
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: sequenceFetch([
    { error: { code: 190, message: "private page rejection page-token" }, __status: 401 },
    { access_token: "renewed-user-token", expires_in: 5_184_000 },
    { data: [{ id: "page-1", name: "Owner Page", access_token: "renewed-page-token" }] },
  ], calls) });

  const usable = await service.ensureUsable("owner@example.com", "meta-1");

  assert.equal(usable.credentials.pageAccessToken, "renewed-page-token");
  assert.equal(usable.state, "archived");
  assert.equal(connections.completed, 1);
  const accounts = calls.find(([url]) => url.includes("/me/accounts"));
  assert.equal(new URL(accounts[0]).searchParams.has("access_token"), false);
  assert.equal(accounts[1].headers.Authorization, "Bearer renewed-user-token");
  assert.equal(JSON.stringify(usable).includes("private page rejection"), false);
});

test("ambiguous Meta 403 validation is transient rather than reconnect", async () => {
  const connections = createLifecycleConnections([metaConnection()]);
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: async () => jsonResponse({ error: { code: 10, message: "policy" } }, false, 403) });
  const usable = await service.ensureUsable("owner@example.com", "meta-1");
  assert.match(usable.warning, /validation/i);
  assert.deepEqual(connections.marked, []);
});

test("rejected Meta Page plus transient refresh failure stays retryable", async () => {
  const connections = createLifecycleConnections([metaConnection()]);
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: sequenceFetch([
    { error: { code: 190 }, __status: 401 },
    { error: { message: "private outage" }, __status: 503 },
  ]) });
  await assert.rejects(service.ensureUsable("owner@example.com", "meta-1"), (error) => error.status === 503 && error.retryable === true && !error.message.includes("private"));
  assert.deepEqual(connections.marked, []);
});

test("ensureUsable marks only an unrenewable rejected Page connection for reconnect", async () => {
  const connections = createLifecycleConnections([metaConnection({ ownerEmail: "owner@example.com", expiresAt: new Date("2026-07-12T00:00:00.000Z"), credentials: { ...metaConnection().credentials, userTokenExpiresAt: "2026-07-12T00:00:00.000Z" } })]);
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: async () => jsonResponse({ error: { code: 190 } }, false, 401) });

  await assert.rejects(service.ensureUsable("owner@example.com", "meta-1"), /reconnect/i);

  assert.deepEqual(connections.marked, [["owner@example.com", "meta-1"]]);
  await assert.rejects(service.ensureUsable("other@example.com", "meta-1"), /not available/i);
});

test("ensureUsable keeps a valid Page token on transient validation failure without marking reconnect", async () => {
  const connections = createLifecycleConnections([metaConnection()]);
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: async () => new Response("private outage", { status: 503 }) });

  const usable = await service.ensureUsable("owner@example.com", "meta-1");

  assert.equal(usable.credentials.pageAccessToken, "page-token");
  assert.match(usable.warning, /validation/i);
  assert.deepEqual(connections.marked, []);
  assert.equal(JSON.stringify(usable).includes("private outage"), false);
});

test("Meta validation deadline covers a stalled response body", { timeout: 250 }, async () => {
  const connections = createLifecycleConnections([metaConnection()]);
  const service = createMetaOAuthService({
    env, transactions: createTransactions(), connections, now: () => now, requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      ok: true, status: 200,
      json: async () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private stalled body")))),
    }),
  });

  const usable = await service.ensureUsable("owner@example.com", "meta-1");
  assert.match(usable.warning, /validation/i);
  assert.deepEqual(connections.marked, []);
});

test("ensureUsable treats a mismatched Page ID as credential rejection", async () => {
  const base = metaConnection();
  const connections = createLifecycleConnections([{ ...base, expiresAt: new Date("2026-07-12T00:00:00.000Z"), credentials: { ...base.credentials, userTokenExpiresAt: "2026-07-12T00:00:00.000Z" } }]);
  const service = createMetaOAuthService({ env, transactions: createTransactions(), connections, now: () => now, fetchImpl: async () => jsonResponse({ id: "other-page" }) });

  await assert.rejects(service.ensureUsable("owner@example.com", "meta-1"), /reconnect/i);
  assert.deepEqual(connections.marked, [["owner@example.com", "meta-1"]]);
});

test("concurrent Meta refresh callers share one validation, exchange, lookup, and credential update", async () => {
  const base = metaConnection();
  const connections = createLifecycleConnections([{ ...base, expiresAt: new Date("2026-07-14T00:00:00.000Z"), credentials: { ...base.credentials, userTokenExpiresAt: "2026-07-14T00:00:00.000Z" } }]);
  let calls = 0;
  const fetchImpl = sequenceFetch([
    { id: "page-1" },
    { access_token: "renewed-user-token", expires_in: 5_184_000 },
    { data: [{ id: "page-1", name: "Owner Page", access_token: "renewed-page-token" }] },
  ]);
  const options = { env, transactions: createTransactions(), connections, now: () => now, fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); } };
  const firstService = createMetaOAuthService(options);
  const secondService = createMetaOAuthService(options);

  const [first, second] = await Promise.all([
    firstService.ensureUsable("owner@example.com", "meta-1"),
    secondService.ensureUsable("owner@example.com", "meta-1"),
  ]);

  assert.equal(calls, 3);
  assert.equal(connections.completed, 1);
  assert.equal(first.credentials.pageAccessToken, "renewed-page-token");
  assert.equal(second.credentials.pageAccessToken, "renewed-page-token");
});

function createTransactions() {
  const records = new Map();
  const created = [];
  return {
    created,
    async purgeExpired() {},
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
    async read(ownerEmail, id) {
      const record = records.get(id);
      if (!record || record.ownerEmail !== ownerEmail || record.consumed || record.expired) throw new Error("OAuth transaction is expired or already used.");
      return record.payload;
    },
    expire(id) { records.get(id).expired = true; },
  };
}

function createConnections() {
  return {
    replaced: [],
    async replaceDefault(ownerEmail, input) {
      const connection = { id: `connection-${this.replaced.length + 1}`, ownerEmail, ...input, state: "active", expiresAt: input.expiresAt ?? null };
      this.replaced.push({ ownerEmail, input, connection });
      return connection;
    },
    async replaceDefaultFromOAuth(ownerEmail, input, transactionId) {
      const connection = await this.replaceDefault(ownerEmail, input);
      this.replaced.at(-1).transactionId = transactionId;
      return connection;
    },
  };
}

function metaConnection(overrides = {}) {
  return {
    id: "meta-1", ownerEmail: "owner@example.com", platform: "meta", state: "archived", displayName: "Owner Page",
    expiresAt: new Date("2026-09-11T00:00:00.000Z"), updatedAt: new Date("2026-07-12T00:00:00.000Z"),
    credentials: { pageId: "page-1", pageName: "Owner Page", pageAccessToken: "page-token", longLivedUserAccessToken: "user-token", userTokenExpiresAt: "2026-09-11T00:00:00.000Z" },
    ...overrides,
  };
}

function createLifecycleConnections(initial) {
  const records = new Map(initial.map((record) => [record.id, structuredClone(record)]));
  const marked = [];
  let completed = 0;
  return {
    marked,
    get completed() { return completed; },
    async getById(owner, id) { const record = records.get(id); return record?.ownerEmail === owner ? structuredClone(record) : null; },
    async acquireRenewalLease(owner, id, leaseId, expiresAt, acquiredAt) {
      const record = records.get(id);
      if (record?.ownerEmail !== owner || !["active", "archived"].includes(record.state)) return null;
      if (record.renewalLeaseId && new Date(record.renewalLeaseExpiresAt) > acquiredAt) return null;
      record.renewalLeaseId = leaseId; record.renewalLeaseExpiresAt = expiresAt; return structuredClone(record);
    },
    async completeRenewalLease(owner, id, leaseId, credentials) {
      const record = records.get(id);
      if (record?.ownerEmail !== owner || record.renewalLeaseId !== leaseId) return null;
      record.credentials = credentials; record.expiresAt = new Date(credentials.userTokenExpiresAt); record.renewalLeaseId = null; record.renewalLeaseExpiresAt = null; completed += 1;
      return structuredClone(record);
    },
    async releaseRenewalLease(owner, id, leaseId) { const record = records.get(id); if (record?.ownerEmail === owner && record.renewalLeaseId === leaseId) record.renewalLeaseId = null; },
    async markNeedsReconnect(owner, id) { const record = records.get(id); if (record?.ownerEmail !== owner) return null; record.state = "needs_reconnect"; marked.push([owner, id]); return structuredClone(record); },
  };
}

function sequenceFetch(results, calls = []) {
  return async (...args) => { calls.push(args); const result = results.shift(); return jsonResponse(result, result?.__status ? false : true, result?.__status); };
}
function jsonResponse(value, ok = true, status = ok ? 200 : 500) { return { ok, status, async json() { return value; } }; }
async function unexpectedFetch() { throw new Error("fetch should not have been called"); }
