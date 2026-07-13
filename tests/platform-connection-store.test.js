import assert from "node:assert/strict";
import { test } from "node:test";

import { createOAuthTransactionStore } from "../src/lib/platform-connections/oauth-transaction-store.js";
import { createPlatformConnectionStore } from "../src/lib/platform-connections/platform-connection-store.js";

function createMemoryRepository() {
  const connections = new Map();
  const transactions = new Map();

  return {
    connections,
    transactions,
    async createConnection(record) {
      connections.set(record.id, { ...record });
      return connections.get(record.id);
    },
    async findDefaultByOwnerAndPlatform(ownerEmail, platform) {
      return [...connections.values()].find((record) => record.ownerEmail === ownerEmail
        && record.platform === platform && record.state === "active") ?? null;
    },
    async findConnectionByIdAndOwner(id, ownerEmail) {
      const record = connections.get(id);
      return record?.ownerEmail === ownerEmail ? record : null;
    },
    async replaceConnectionCredentials(id, ownerEmail, changes) {
      const record = connections.get(id);
      if (!record || record.ownerEmail !== ownerEmail) return null;
      const next = { ...record, ...changes };
      connections.set(id, next);
      return next;
    },
    async archiveConnection(id, ownerEmail, updatedAt) {
      const record = connections.get(id);
      if (!record || record.ownerEmail !== ownerEmail) return null;
      const next = { ...record, state: "archived", updatedAt };
      connections.set(id, next);
      return next;
    },
    async listConnectionAvailability(ownerEmail) {
      return [...connections.values()].filter((record) => record.ownerEmail === ownerEmail);
    },
    async createOAuthTransaction(record) {
      transactions.set(record.id, { ...record });
      return transactions.get(record.id);
    },
    async consumeOAuthTransaction(id, ownerEmail, now) {
      const record = transactions.get(id);
      if (!record || record.ownerEmail !== ownerEmail || record.consumedAt || record.expiresAt <= now) return null;
      const next = { ...record, consumedAt: now };
      transactions.set(id, next);
      return next;
    },
    async purgeExpiredOAuthTransactions(now) {
      for (const [id, record] of transactions) {
        if (record.expiresAt <= now || record.consumedAt) transactions.delete(id);
      }
    },
  };
}

test("connection credentials are encrypted and isolated by owner", async () => {
  const repository = createMemoryRepository();
  const store = createPlatformConnectionStore({ repository, encryptionKey: "test-key" });

  const connection = await store.create("OWNER@example.com", {
    platform: "line",
    displayName: "Owner Official Account",
    credentials: { channelSecret: "line-channel-secret", accessToken: "line-access-token" },
  });

  assert.equal((await store.getById("other@example.com", connection.id)), null);
  const stored = repository.connections.get(connection.id);
  assert.equal(stored.encryptedCredentials.includes("line-channel-secret"), false);
  assert.equal(stored.encryptedCredentials.includes("line-access-token"), false);
  assert.deepEqual((await store.getById("owner@example.com", connection.id)).credentials, {
    channelSecret: "line-channel-secret",
    accessToken: "line-access-token",
  });
  assert.deepEqual(await store.listAvailability("OWNER@example.com"), [{
    platform: "line",
    state: "active",
    displayName: "Owner Official Account",
    expiresAt: null,
  }]);
});

test("connection credentials are replaced and archived only by their owner", async () => {
  const repository = createMemoryRepository();
  const store = createPlatformConnectionStore({ repository, encryptionKey: "test-key" });
  const connection = await store.create("owner@example.com", {
    platform: "meta",
    displayName: "Owner Page",
    credentials: { pageAccessToken: "old-token" },
  });

  assert.equal(await store.replaceCredentials("other@example.com", connection.id, { pageAccessToken: "other-token" }), null);
  const replaced = await store.replaceCredentials("owner@example.com", connection.id, { pageAccessToken: "new-token" });
  assert.equal(replaced.credentials.pageAccessToken, "new-token");
  assert.equal(repository.connections.get(connection.id).encryptedCredentials.includes("new-token"), false);
  assert.equal((await store.archive("other@example.com", connection.id)), null);
  assert.equal((await store.archive("owner@example.com", connection.id)).state, "archived");
  assert.equal(await store.getDefault("owner@example.com", "meta"), null);
});

test("OAuth transactions are single-use, owner-bound, and expire after ten minutes", async () => {
  const repository = createMemoryRepository();
  const store = createOAuthTransactionStore({ repository, encryptionKey: "test-key" });
  const now = new Date("2026-07-13T00:00:00.000Z");
  const transaction = await store.create("owner@example.com", "meta", { pages: [], userToken: "never-store-plain" }, "/settings", now);

  assert.equal(repository.transactions.get(transaction.id).encryptedPayload.includes("never-store-plain"), false);
  await assert.rejects(store.consume("other@example.com", transaction.id, now), /expired or already used/i);
  assert.deepEqual(await store.consume("owner@example.com", transaction.id, now), { pages: [], userToken: "never-store-plain" });
  await assert.rejects(store.consume("owner@example.com", transaction.id, now), /expired or already used/i);

  const expiring = await store.create("owner@example.com", "meta", { pages: [] }, "/settings", now);
  await assert.rejects(
    store.consume("owner@example.com", expiring.id, new Date(now.getTime() + (10 * 60 * 1000))),
    /expired or already used/i,
  );
});

test("OAuth transactions reject protocol-relative return paths", async () => {
  const store = createOAuthTransactionStore({ repository: createMemoryRepository(), encryptionKey: "test-key" });

  await assert.rejects(
    store.create("owner@example.com", "meta", { pages: [] }, "//attacker.example", new Date()),
    /local path/i,
  );
});
