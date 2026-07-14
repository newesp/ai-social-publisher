import assert from "node:assert/strict";
import { test } from "node:test";

import { createLineChannelService } from "../src/lib/platform-connections/line-channel-service.js";

const now = new Date("2026-07-13T00:00:00.000Z");

test("connect issues a form-encoded LINE token, verifies the bot, and keeps credentials out of its result", async () => {
  const connections = createConnections();
  const requests = [];
  const service = createLineChannelService({
    connections,
    now: () => now,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/oauth/accessToken")) return jsonResponse({ access_token: "line-access-token", expires_in: 2_592_000 });
      return jsonResponse({ userId: "U123", displayName: "Owner Official Account" });
    },
  });

  const connection = await service.connect("OWNER@example.com", { channelId: "channel-id", channelSecret: "channel-secret" });

  assert.equal(requests[0].url, "https://api.line.me/v2/oauth/accessToken");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(String(requests[0].options.body), "grant_type=client_credentials&client_id=channel-id&client_secret=channel-secret");
  assert.equal(requests[1].url, "https://api.line.me/v2/bot/info");
  assert.equal(requests[1].options.headers.Authorization, "Bearer line-access-token");
  assert.deepEqual(connection, {
    platform: "line", state: "active", displayName: "Owner Official Account", expiresAt: new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(JSON.stringify(connection).includes("channel-secret"), false);
  assert.equal(JSON.stringify(connection).includes("line-access-token"), false);
  assert.deepEqual(connections.replaced[0].input.credentials, {
    channelId: "channel-id", channelSecret: "channel-secret", accessToken: "line-access-token",
    expiresAt: "2026-08-12T00:00:00.000Z", officialAccountName: "Owner Official Account", botUserId: "U123",
  });
});

test("connect rejects invalid credentials without calling LINE", async () => {
  let calls = 0;
  const service = createLineChannelService({ connections: createConnections(), now: () => now, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });

  await assert.rejects(service.connect("owner@example.com", { channelId: "", channelSecret: "secret" }), /channel id.*channel secret/i);
  await assert.rejects(service.connect("owner@example.com", { channelId: 123, channelSecret: "secret" }), /channel id.*channel secret/i);
  await assert.rejects(service.connect("owner@example.com", { channelId: "channel", channelSecret: "********" }), /channel id.*channel secret/i);
  assert.equal(calls, 0);
});

test("connect rejects an incomplete LINE bot identity without persisting a connection", async () => {
  for (const profile of [
    { displayName: "Owner Official Account" },
    { userId: "U123", displayName: 123 },
    { userId: "U123", displayName: "   " },
  ]) {
    const connections = createConnections();
    const service = createLineChannelService({
      connections, now: () => now,
      fetchImpl: async (url) => url.endsWith("/oauth/accessToken")
        ? jsonResponse({ access_token: "line-access-token", expires_in: 2_592_000 })
        : jsonResponse(profile),
    });

    await assert.rejects(
      service.connect("owner@example.com", { channelId: "channel-id", channelSecret: "channel-secret" }),
      /could not be completed/i,
    );
    assert.equal(connections.replaced.length, 0);
  }
});

test("ensureUsable does not rotate a LINE token with more than 72 hours remaining", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-17T00:00:01.000Z" })]);
  let calls = 0;
  const service = createLineChannelService({ connections, now: () => now, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });

  const usable = await service.ensureUsable("owner@example.com", "connection-1");

  assert.equal(usable.credentials.accessToken, "old-token");
  assert.equal(calls, 0);
  assert.equal(connections.replaceAttempts.length, 0);
});

test("ensureUsable rotates at 72 hours and concurrent callers reuse the winning credentials", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-16T00:00:00.000Z" })]);
  let issued = 0;
  let verified = 0;
  const options = {
    connections, now: () => now,
    fetchImpl: async (url) => {
      if (url.endsWith("/oauth/accessToken")) { issued += 1; return jsonResponse({ access_token: `new-token-${issued}`, expires_in: 2_592_000 }); }
      verified += 1;
      return jsonResponse({ userId: "U123", displayName: "Owner Official Account" });
    },
  };
  const firstService = createLineChannelService(options);
  const secondService = createLineChannelService(options);

  const [first, second] = await Promise.all([
    firstService.ensureUsable("owner@example.com", "connection-1"),
    secondService.ensureUsable("owner@example.com", "connection-1"),
  ]);

  assert.equal(first.credentials.accessToken, second.credentials.accessToken);
  assert.equal(first.credentials.accessToken, "new-token-1");
  assert.equal(issued, 1);
  assert.equal(verified, 1);
  assert.equal(connections.replaceAttempts.filter((attempt) => attempt.updated).length, 1);
});

test("a cross-process lease loser never issues another token and safely reuses a valid old token", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-14T00:00:00.000Z" })]);
  let issued = 0;
  let releaseProvider;
  const providerBarrier = new Promise((resolve) => { releaseProvider = resolve; });
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth/accessToken")) { issued += 1; await providerBarrier; return jsonResponse({ access_token: "winner-token", expires_in: 2_592_000 }); }
    return jsonResponse({ userId: "U123", displayName: "Owner Official Account" });
  };
  const winnerService = createLineChannelService({ connections, now: () => now, fetchImpl, renewalFlights: new Map() });
  const loserService = createLineChannelService({ connections, now: () => now, fetchImpl, renewalFlights: new Map() });

  const winnerPromise = winnerService.ensureUsable("owner@example.com", "connection-1");
  await connections.leaseAcquired;
  const loser = await loserService.ensureUsable("owner@example.com", "connection-1");
  releaseProvider();
  const winner = await winnerPromise;

  assert.equal(issued, 1);
  assert.equal(loser.credentials.accessToken, "old-token");
  assert.match(loser.warning, /renewal.*progress/i);
  assert.equal(winner.credentials.accessToken, "winner-token");
});

test("an expired cross-process lease loser fails retryably without issuing or marking reconnect", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-12T00:00:00.000Z", renewalLeaseId: "other-worker", renewalLeaseExpiresAt: new Date("2026-07-13T00:01:00.000Z") })]);
  let calls = 0;
  const service = createLineChannelService({ connections, now: () => now, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });

  await assert.rejects(service.ensureUsable("owner@example.com", "connection-1"), (error) => error.status === 503 && /progress/i.test(error.message));
  assert.equal(calls, 0);
  assert.equal(connections.marked.length, 0);
});

test("ensureUsable renews an archived bound LINE connection without reactivating it", async () => {
  const connections = createConnections([connection({ state: "archived", expiresAt: "2026-07-16T00:00:00.000Z" })]);
  const service = createLineChannelService({
    connections, now: () => now,
    fetchImpl: async (url) => url.endsWith("/oauth/accessToken")
      ? jsonResponse({ access_token: "archived-new-token", expires_in: 2_592_000 })
      : jsonResponse({ userId: "U123", displayName: "Owner Official Account" }),
  });

  const usable = await service.ensureUsable("owner@example.com", "connection-1");

  assert.equal(usable.state, "archived");
  assert.equal(usable.credentials.accessToken, "archived-new-token");
  assert.equal(connections.replaceAttempts[0].updated, true);
});

test("ensureUsable keeps a still-valid token with a recoverable warning when renewal fails", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-14T00:00:00.000Z" })]);
  const service = createLineChannelService({ connections, now: () => now, fetchImpl: async () => jsonResponse({ provider_detail: "private" }, false) });

  const usable = await service.ensureUsable("owner@example.com", "connection-1");

  assert.equal(usable.credentials.accessToken, "old-token");
  assert.match(usable.warning, /renew/i);
  assert.equal(JSON.stringify(usable).includes("private"), false);
  assert.equal(connections.marked.length, 0);
});

test("ensureUsable marks only the owner connection as needing reconnect when an expired token cannot renew", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-13T00:00:00.000Z" })]);
  const service = createLineChannelService({ connections, now: () => now, fetchImpl: async () => jsonResponse({}, false, 401) });

  await assert.rejects(service.ensureUsable("owner@example.com", "connection-1"), /reconnect/i);

  assert.deepEqual(connections.marked, [["owner@example.com", "connection-1"]]);
  await assert.rejects(service.ensureUsable("other@example.com", "connection-1"), /not available/i);
});

test("expired LINE renewal 503 stays retryable and does not mark reconnect", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-12T00:00:00.000Z" })]);
  const service = createLineChannelService({ connections, now: () => now, fetchImpl: async () => jsonResponse({ private: "body" }, false, 503) });

  await assert.rejects(service.ensureUsable("owner@example.com", "connection-1"), (error) => error.status === 503 && error.retryable === true && !error.message.includes("body"));
  assert.deepEqual(connections.marked, []);
});

test("lost LINE renewal fencing never marks or returns stale expired credentials", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-12T00:00:00.000Z" })]);
  connections.forceCompletionLoss = true;
  const service = createLineChannelService({
    connections, now: () => now, pollDelay: async () => {}, pollAttempts: 2,
    fetchImpl: async (url) => url.endsWith("/oauth/accessToken")
      ? jsonResponse({ access_token: "late-a-token", expires_in: 2_592_000 })
      : jsonResponse({ userId: "U123", displayName: "Owner Official Account" }),
  });

  await assert.rejects(service.ensureUsable("owner@example.com", "connection-1"), (error) => error.status === 503 && error.retryable === true);
  assert.deepEqual(connections.marked, []);
});

test("a LINE renewal loser observes and returns a demonstrably newer fenced winner", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-12T00:00:00.000Z" })]);
  connections.forceCompletionLoss = true;
  const service = createLineChannelService({
    connections, now: () => now, pollAttempts: 2,
    pollDelay: async () => connections.installWinner("connection-1", "winner-token"),
    fetchImpl: async (url) => url.endsWith("/oauth/accessToken")
      ? jsonResponse({ access_token: "late-loser-token", expires_in: 2_592_000 })
      : jsonResponse({ userId: "U123", displayName: "Owner Official Account" }),
  });

  const usable = await service.ensureUsable("owner@example.com", "connection-1");

  assert.equal(usable.credentials.accessToken, "winner-token");
  assert.deepEqual(connections.marked, []);
});

test("LINE provider deadline abort is retryable and releases the lease", async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-12T00:00:00.000Z" })]);
  const service = createLineChannelService({
    connections, now: () => now, requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted private")))),
  });
  await assert.rejects(service.ensureUsable("owner@example.com", "connection-1"), (error) => error.status === 503 && error.retryable === true);
  assert.equal(connections.released.length, 1);
  assert.deepEqual(connections.marked, []);
});

test("LINE deadline remains active while the provider response body stalls", { timeout: 250 }, async () => {
  const connections = createConnections([connection({ expiresAt: "2026-07-12T00:00:00.000Z" })]);
  const service = createLineChannelService({
    connections, now: () => now, requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      ok: true, status: 200,
      json: async () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private stalled body")))),
    }),
  });

  await assert.rejects(service.ensureUsable("owner@example.com", "connection-1"), (error) => error.status === 503 && error.retryable === true);
  assert.equal(connections.released.length, 1);
  assert.deepEqual(connections.marked, []);
});

function connection(overrides = {}) {
  return {
    id: "connection-1", ownerEmail: "owner@example.com", platform: "line", state: "active", displayName: "Owner Official Account",
    expiresAt: new Date("2026-07-20T00:00:00.000Z"), updatedAt: new Date("2026-07-12T00:00:00.000Z"),
    credentials: { channelId: "channel-id", channelSecret: "channel-secret", accessToken: "old-token", expiresAt: "2026-07-20T00:00:00.000Z", officialAccountName: "Owner Official Account", botUserId: "U123" },
    ...overrides,
  };
}

function createConnections(initial = []) {
  const records = new Map(initial.map((item) => [item.id, item]));
  const replaced = [];
  const replaceAttempts = [];
  const marked = [];
  const released = [];
  let resolveLease;
  const leaseAcquired = new Promise((resolve) => { resolveLease = resolve; });
  return {
    replaced, replaceAttempts, marked, released, forceCompletionLoss: false, leaseAcquired,
    installWinner(id, accessToken) {
      const record = records.get(id);
      record.credentials = { ...record.credentials, accessToken, expiresAt: "2026-08-12T00:00:00.000Z" };
      record.expiresAt = new Date(record.credentials.expiresAt);
      record.updatedAt = new Date(record.updatedAt.getTime() + 1);
      record.renewalLeaseId = null;
      record.renewalLeaseExpiresAt = null;
    },
    async replaceDefault(ownerEmail, input) {
      const created = { id: `connection-${replaced.length + 1}`, ownerEmail, platform: input.platform, displayName: input.displayName, state: "active", expiresAt: input.expiresAt, updatedAt: now, credentials: input.credentials };
      records.set(created.id, created); replaced.push({ ownerEmail, input }); return created;
    },
    async getById(ownerEmail, id) { const record = records.get(id); return record?.ownerEmail === ownerEmail ? structuredClone(record) : null; },
    async acquireRenewalLease(ownerEmail, id, leaseId, leaseExpiresAt, acquiredAt) {
      const record = records.get(id);
      if (record?.ownerEmail !== ownerEmail || !["active", "archived"].includes(record.state)) return null;
      if (record.renewalLeaseId && new Date(record.renewalLeaseExpiresAt).getTime() > acquiredAt.getTime()) return null;
      record.renewalLeaseId = leaseId; record.renewalLeaseExpiresAt = leaseExpiresAt; resolveLease();
      return structuredClone(record);
    },
    async completeRenewalLease(ownerEmail, id, leaseId, credentials) {
      const record = records.get(id);
      const updated = !this.forceCompletionLoss && record?.ownerEmail === ownerEmail && record.renewalLeaseId === leaseId;
      replaceAttempts.push({ ownerEmail, id, credentials, updated });
      if (!updated) return null;
      record.credentials = credentials; record.expiresAt = new Date(credentials.expiresAt); record.updatedAt = new Date(record.updatedAt.getTime() + 1);
      record.renewalLeaseId = null; record.renewalLeaseExpiresAt = null;
      return structuredClone(record);
    },
    async releaseRenewalLease(ownerEmail, id, leaseId) { released.push([ownerEmail, id, leaseId]); const record = records.get(id); if (record?.ownerEmail === ownerEmail && record.renewalLeaseId === leaseId) { record.renewalLeaseId = null; record.renewalLeaseExpiresAt = null; } },
    async replaceCredentialsIfUnchanged(ownerEmail, id, previousUpdatedAt, credentials) {
      const record = records.get(id);
      const updated = record?.ownerEmail === ownerEmail && ["active", "archived"].includes(record.state) && record.updatedAt.getTime() === previousUpdatedAt.getTime();
      replaceAttempts.push({ ownerEmail, id, previousUpdatedAt, credentials, updated });
      if (!updated) return null;
      record.credentials = credentials; record.expiresAt = new Date(credentials.expiresAt); record.updatedAt = new Date(record.updatedAt.getTime() + 1); return structuredClone(record);
    },
    async markNeedsReconnect(ownerEmail, id) { const record = records.get(id); if (record?.ownerEmail !== ownerEmail) return null; record.state = "needs_reconnect"; marked.push([ownerEmail, id]); return structuredClone(record); },
  };
}

function jsonResponse(value, ok = true, status = ok ? 200 : 500) { return { ok, status, async json() { return value; } }; }
