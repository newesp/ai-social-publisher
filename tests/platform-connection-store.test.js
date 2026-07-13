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
    async replaceDefaultConnection(record) {
      for (const [id, current] of connections) {
        if (current.ownerEmail === record.ownerEmail && current.platform === record.platform && current.state === "active") {
          connections.set(id, { ...current, state: "archived", updatedAt: record.updatedAt });
        }
      }
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
    async archiveActiveDefaultConnection(ownerEmail, platform, updatedAt) {
      const active = [...connections.values()].filter((record) => record.ownerEmail === ownerEmail
        && record.platform === platform && record.state === "active");
      for (const record of active) connections.set(record.id, { ...record, state: "archived", updatedAt });
      return active[0] ? connections.get(active[0].id) : null;
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
    async findOAuthTransactionByIdAndOwner(id, ownerEmail, now) {
      const record = transactions.get(id);
      return record && record.ownerEmail === ownerEmail && !record.consumedAt && record.expiresAt > now ? record : null;
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

test("replacing a default connection archives prior active records atomically", async () => {
  const repository = createMemoryRepository();
  const store = createPlatformConnectionStore({ repository, encryptionKey: "test-key" });
  const oldConnection = await store.create("owner@example.com", {
    platform: "meta", displayName: "Old Page", credentials: { pageAccessToken: "old-token" },
  });

  const replacement = await store.replaceDefault("owner@example.com", {
    platform: "meta", displayName: "New Page", credentials: { pageAccessToken: "new-token" },
  });

  assert.equal(repository.connections.get(oldConnection.id).state, "archived");
  assert.equal(repository.connections.get(replacement.id).state, "active");
  assert.deepEqual([...repository.connections.values()].filter((record) => record.ownerEmail === "owner@example.com"
    && record.platform === "meta" && record.state === "active").map((record) => record.id), [replacement.id]);
  assert.equal(repository.connections.get(replacement.id).encryptedCredentials.includes("new-token"), false);
});

test("archiveDefault delegates one owner-platform-state operation without reading a stale connection id", async () => {
  const calls = [];
  const store = createPlatformConnectionStore({
    repository: {
      async archiveActiveDefaultConnection(...args) {
        calls.push(args);
        return { platform: "meta", state: "archived", displayName: "Owner Page", credentialExpiresAt: null };
      },
      async findDefaultByOwnerAndPlatform() { throw new Error("must not read before archive"); },
      async archiveConnection() { throw new Error("must not archive by stale id"); },
    },
    encryptionKey: "test-key",
  });

  assert.deepEqual(await store.archiveDefault("OWNER@example.com", "meta"), {
    platform: "meta", state: "archived", displayName: "Owner Page", expiresAt: null,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["owner@example.com", "meta"]);
  assert.equal(calls[0][2] instanceof Date, true);
});

test("disconnectDefault atomically clears credentials and returns them only to the provider-revoke caller", async () => {
  const calls = [];
  const encryptedOriginal = (await import("../src/lib/settings/credential-crypto.js")).encryptJson({ accessToken: "line-secret" }, "test-key");
  const repository = {
    async disconnectActiveConnection(owner, platform, cleared, updatedAt) {
      calls.push([owner, platform, cleared, updatedAt]);
      return { status: "disconnected", connection: { encryptedCredentials: encryptedOriginal } };
    },
  };
  const result = await createPlatformConnectionStore({ repository, encryptionKey: "test-key" }).disconnectDefault(" OWNER@example.com ", "line");

  assert.equal(result.credentials.accessToken, "line-secret");
  assert.equal(calls[0][0], "owner@example.com");
  assert.equal(calls[0][1], "line");
  assert.equal(calls[0][2].includes("line-secret"), false);
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

test("unconsumed OAuth transactions can be read only by their owner without exposing stored rows", async () => {
  const repository = createMemoryRepository();
  const store = createOAuthTransactionStore({ repository, encryptionKey: "test-key" });
  const now = new Date("2026-07-13T00:00:00.000Z");
  const transaction = await store.create("owner@example.com", "meta", { pages: [{ accessToken: "page-token" }] }, "/settings", now);

  assert.deepEqual(await store.read("owner@example.com", transaction.id, now), { pages: [{ accessToken: "page-token" }] });
  await assert.rejects(store.read("other@example.com", transaction.id, now), /expired or already used/i);
  assert.equal(repository.transactions.get(transaction.id).encryptedPayload.includes("page-token"), false);
});
