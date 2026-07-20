import assert from "node:assert/strict";
import { test } from "node:test";

import { getLLMModelOptions } from "../src/lib/ai/model-config.js";
import { createSupportStore } from "../src/lib/support/support-store.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const WEBHOOK_KEY_HASH = "a".repeat(64);
const SECOND_WEBHOOK_KEY_HASH = "b".repeat(64);

test("inbox cursors are owner and status scoped while repository pages stay bounded", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 31 }, (_, index) => inboxRecord(index + 1));
  const repository = {
    async listInboxConversations(ownerEmail, options) {
      calls.push(["listInboxConversations", ownerEmail, options]);
      return options.cursor ? [inboxRecord(31), inboxRecord(32)] : firstPage;
    },
    async countInboxAttention(ownerEmail) {
      calls.push(["countInboxAttention", ownerEmail]);
      return 4;
    },
  };
  const store = createStore(repository);

  const first = await store.listConversations(" OWNER@EXAMPLE.COM ", { status: "ai_active" });

  assert.equal(first.conversations.length, 30);
  assert.equal(first.conversations[0].id, "conversation-01");
  assert.equal(first.conversations.at(-1).id, "conversation-30");
  assert.equal(first.attentionCount, 4);
  assert.ok(first.nextCursor);
  assert.equal(Buffer.from(first.nextCursor, "base64url").toString("utf8").includes("owner@example.com"), false);

  const second = await store.listConversations("owner@example.com", {
    status: "ai_active",
    cursor: first.nextCursor,
  });

  assert.deepEqual(second.conversations.map(({ id }) => id), ["conversation-31", "conversation-32"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(calls[2], [
    "listInboxConversations",
    "owner@example.com",
    {
      status: "ai_active",
      cursor: {
        updatedAt: inboxRecord(30).updatedAt.getTime(),
        id: "conversation-30",
      },
    },
  ]);
  await rejectsStatus(store.listConversations("other@example.com", {
    status: "ai_active",
    cursor: first.nextCursor,
  }), 400);
  await rejectsStatus(store.listConversations("owner@example.com", {
    status: "resolved",
    cursor: first.nextCursor,
  }), 400);
});

test("configuration validates the complete allowlist and returns only safe readiness fields", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  const configuration = await store.updateConfiguration(" OWNER@EXAMPLE.COM ", validConfiguration());

  assert.deepEqual(configuration, {
    id: configuration.id,
    platformConnectionId: CONNECTION_ID,
    brandName: "Acme",
    assistantName: "Ada",
    replyTone: "friendly",
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    supportState: "disabled",
    webhookVerified: false,
    redeliveryAcknowledged: true,
    nativeRepliesDisabledAcknowledged: true,
    providerTested: false,
    version: 0,
    createdAt: configuration.createdAt,
    updatedAt: configuration.updatedAt,
  });
  assert.equal(JSON.stringify(configuration).includes("webhook-hash"), false);
  assert.equal(JSON.stringify(configuration).includes("owner@example.com"), false);
  assert.equal(JSON.stringify(configuration).includes("encrypted-credential"), false);
  assert.equal((await store.getConfiguration("owner@example.com")).id, configuration.id);
  assert.equal(repository.calls[0][1], "owner@example.com");
});

test("configuration rejects unknown, invalid, and unacknowledged values with 400", async () => {
  const store = createStore();

  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), secret: "no" }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), platformConnectionId: "not-a-uuid" }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), brandName: 123 }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), brandName: "x".repeat(81) }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), assistantName: "" }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), replyTone: "casual" }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), llmProvider: "other" }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), llmModel: "unsupported" }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), redeliveryAcknowledged: false }), 400);
  await rejectsStatus(store.updateConfiguration("owner@example.com", { ...validConfiguration(), nativeRepliesDisabledAcknowledged: false }), 400);
});

test("browser configuration binds the owner's active LINE default without accepting internal fields", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  const input = browserConfiguration();

  const configuration = await store.updateConfigurationForActiveDefault(
    " OWNER@EXAMPLE.COM ",
    input,
  );

  assert.equal(configuration.platformConnectionId, CONNECTION_ID);
  assert.equal(configuration.brandName, "Acme");
  assert.equal(repository.configurations.get("owner@example.com").platformConnectionId, CONNECTION_ID);
  await rejectsStatus(
    store.updateConfigurationForActiveDefault("owner@example.com", {
      ...input,
      platformConnectionId: SECOND_CONNECTION_ID,
    }),
    400,
  );
  repository.connections.delete(CONNECTION_ID);
  await rejectsStatus(
    store.updateConfigurationForActiveDefault("owner@example.com", input),
    409,
  );
});

test("configuration cannot bind another owner's LINE connection", async () => {
  const repository = createMemoryRepository();
  repository.connections.set(CONNECTION_ID, "other@example.com");
  const store = createStore(repository);

  await rejectsStatus(store.updateConfiguration("owner@example.com", validConfiguration()), 404);
  assert.equal(repository.configurations.size, 0);
});

test("configuration changes invalidate connection- and provider-dependent readiness", async () => {
  const repository = createMemoryRepository();
  repository.connections.set(SECOND_CONNECTION_ID, "owner@example.com");
  const store = createStore(repository);
  const created = await store.updateConfiguration("owner@example.com", validConfiguration());
  Object.assign(repository.configurations.get("owner@example.com"), {
    supportState: "enabled",
    webhookKeyHash: "webhook-hash",
    webhookVerifiedAt: new Date("2026-07-18T00:00:00.000Z"),
    providerTestedAt: new Date("2026-07-18T00:00:00.000Z"),
  });

  const connectionUpdated = await store.updateConfiguration("owner@example.com", {
    ...validConfiguration(),
    platformConnectionId: SECOND_CONNECTION_ID,
  });

  assert.equal(connectionUpdated.id, created.id);
  assert.equal(connectionUpdated.supportState, "disabled");
  assert.equal(connectionUpdated.webhookVerified, false);
  assert.equal(connectionUpdated.providerTested, false);
  assert.equal(repository.configurations.get("owner@example.com").webhookKeyHash, null);

  Object.assign(repository.configurations.get("owner@example.com"), {
    supportState: "enabled",
    providerTestedAt: new Date("2026-07-18T00:00:00.000Z"),
  });
  const providerUpdated = await store.updateConfiguration("owner@example.com", {
    ...validConfiguration(),
    platformConnectionId: SECOND_CONNECTION_ID,
    llmProvider: "openai",
    llmModel: "gpt-4o",
  });

  assert.equal(providerUpdated.supportState, "disabled");
  assert.equal(providerUpdated.providerTested, false);
});

test("configuration and disable mutations preserve monotonic versions with compare-and-swap", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  await store.updateConfiguration("owner@example.com", validConfiguration());

  await store.updateConfiguration("owner@example.com", {
    ...validConfiguration(),
    brandName: "Updated",
  });
  const configurationWrite = repository.calls
    .filter(([operation]) => operation === "updateConfiguration")
    .at(-1);
  assert.deepEqual(configurationWrite[4], { expectedVersion: 0 });

  await store.setSupportState("owner@example.com", CONNECTION_ID, "disabled");
  const disableWrite = repository.calls
    .filter(([operation]) => operation === "updateConfiguration")
    .at(-1);
  assert.deepEqual(disableWrite[4], { expectedVersion: 1 });
});

test("webhook preparation creates a safe skeleton and persists only the owner-scoped hash", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);

  const configuration = await store.prepareWebhook(
    " OWNER@EXAMPLE.COM ",
    CONNECTION_ID,
    WEBHOOK_KEY_HASH,
  );
  const stored = repository.configurations.get("owner@example.com");

  assert.deepEqual(configuration, {
    id: configuration.id,
    platformConnectionId: CONNECTION_ID,
    brandName: "",
    assistantName: "",
    replyTone: "friendly",
    llmProvider: null,
    llmModel: null,
    supportState: "disabled",
    webhookVerified: false,
    redeliveryAcknowledged: false,
    nativeRepliesDisabledAcknowledged: false,
    providerTested: false,
    version: 0,
    createdAt: configuration.createdAt,
    updatedAt: configuration.updatedAt,
  });
  assert.equal(stored.webhookKeyHash, WEBHOOK_KEY_HASH);
  assert.equal(JSON.stringify(configuration).includes(WEBHOOK_KEY_HASH), false);
  assert.equal(stored.ownerEmail, "owner@example.com");

  await rejectsStatus(
    store.prepareWebhook("other@example.com", CONNECTION_ID, WEBHOOK_KEY_HASH),
    404,
  );
  await rejectsStatus(
    store.prepareWebhook("owner@example.com", CONNECTION_ID, "plaintext-webhook-key"),
    400,
  );
});

test("webhook preparation on a replacement LINE connection preserves settings and invalidates readiness", async () => {
  const repository = createMemoryRepository();
  repository.connections.set(SECOND_CONNECTION_ID, "owner@example.com");
  const store = createStore(repository);
  await store.updateConfiguration("owner@example.com", validConfiguration());
  Object.assign(repository.configurations.get("owner@example.com"), {
    supportState: "enabled",
    webhookKeyHash: "b".repeat(64),
    webhookVerifiedAt: new Date("2026-07-18T00:00:00.000Z"),
    providerTestedAt: new Date("2026-07-18T00:00:00.000Z"),
  });

  const configuration = await store.prepareWebhook(
    "owner@example.com",
    SECOND_CONNECTION_ID,
    WEBHOOK_KEY_HASH,
  );

  assert.equal(configuration.platformConnectionId, SECOND_CONNECTION_ID);
  assert.equal(configuration.brandName, "Acme");
  assert.equal(configuration.llmModel, "gemini-3.1-flash-lite");
  assert.equal(configuration.redeliveryAcknowledged, true);
  assert.equal(configuration.supportState, "disabled");
  assert.equal(configuration.webhookVerified, false);
  assert.equal(configuration.providerTested, false);
  assert.equal(repository.configurations.get("owner@example.com").webhookKeyHash, WEBHOOK_KEY_HASH);
});

test("a stale webhook attempt cannot verify or disable a newer prepared endpoint", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  const first = await store.prepareWebhook(
    "owner@example.com",
    CONNECTION_ID,
    WEBHOOK_KEY_HASH,
  );
  const second = await store.prepareWebhook(
    "owner@example.com",
    CONNECTION_ID,
    SECOND_WEBHOOK_KEY_HASH,
  );

  for (const verified of [true, false]) {
    await assert.rejects(
      store.recordWebhookVerification(
        "owner@example.com",
        CONNECTION_ID,
        verified,
        {
          expectedVersion: first.version,
          expectedWebhookKeyHash: WEBHOOK_KEY_HASH,
        },
      ),
      (error) => error.status === 409,
    );
  }

  const storedAfterStaleAttempts = repository.configurations.get("owner@example.com");
  assert.equal(storedAfterStaleAttempts.webhookKeyHash, SECOND_WEBHOOK_KEY_HASH);
  assert.equal(storedAfterStaleAttempts.webhookVerifiedAt, null);
  assert.equal(storedAfterStaleAttempts.supportState, "disabled");

  const verified = await store.recordWebhookVerification(
    "owner@example.com",
    CONNECTION_ID,
    true,
    {
      expectedVersion: second.version,
      expectedWebhookKeyHash: SECOND_WEBHOOK_KEY_HASH,
    },
  );
  assert.equal(verified.webhookVerified, true);
  assert.equal(repository.configurations.get("owner@example.com").webhookKeyHash, SECOND_WEBHOOK_KEY_HASH);
});

test("readiness mutations require the owner and configured connection and return redacted state", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  const prepared = await store.prepareWebhook("owner@example.com", CONNECTION_ID, WEBHOOK_KEY_HASH);

  const verified = await store.recordWebhookVerification(
    "owner@example.com",
    CONNECTION_ID,
    true,
    {
      expectedVersion: prepared.version,
      expectedWebhookKeyHash: WEBHOOK_KEY_HASH,
    },
  );
  assert.equal(verified.webhookVerified, true);
  assert.equal(
    repository.configurations.get("owner@example.com").webhookVerifiedAt.toISOString(),
    "2026-07-19T00:00:00.000Z",
  );

  const beforeProviderTest = await store.getConfiguration("owner@example.com");
  const tested = await store.recordProviderTest(
    "owner@example.com",
    CONNECTION_ID,
    true,
    { expectedVersion: beforeProviderTest.version },
  );
  assert.equal(tested.providerTested, true);
  assert.equal(
    repository.configurations.get("owner@example.com").providerTestedAt.toISOString(),
    "2026-07-19T00:00:00.000Z",
  );
  await rejectsStatus(
    store.recordProviderTest(
      "owner@example.com",
      CONNECTION_ID,
      false,
      { expectedVersion: beforeProviderTest.version },
    ),
    409,
  );
  assert.equal((await store.getConfiguration("owner@example.com")).providerTested, true);

  await rejectsStatus(
    store.setSupportState(
      "owner@example.com",
      CONNECTION_ID,
      "enabled",
      { expectedVersion: (await store.getConfiguration("owner@example.com")).version },
    ),
    400,
  );

  const beforeUnverify = await store.getConfiguration("owner@example.com");
  const unverified = await store.recordWebhookVerification(
    "owner@example.com",
    CONNECTION_ID,
    false,
    {
      expectedVersion: beforeUnverify.version,
      expectedWebhookKeyHash: WEBHOOK_KEY_HASH,
    },
  );
  assert.equal(unverified.webhookVerified, false);
  assert.equal(unverified.supportState, "disabled");

  repository.configurations.get("owner@example.com").supportState = "enabled";
  const beforeFailedProvider = await store.getConfiguration("owner@example.com");
  const failedProvider = await store.recordProviderTest(
    "owner@example.com",
    CONNECTION_ID,
    false,
    { expectedVersion: beforeFailedProvider.version },
  );
  assert.equal(failedProvider.providerTested, false);
  assert.equal(failedProvider.supportState, "disabled");

  await rejectsStatus(
    store.recordWebhookVerification(
      "owner@example.com",
      SECOND_CONNECTION_ID,
      true,
      {
        expectedVersion: (await store.getConfiguration("owner@example.com")).version,
        expectedWebhookKeyHash: WEBHOOK_KEY_HASH,
      },
    ),
    404,
  );
  await rejectsStatus(
    store.setSupportState("other@example.com", CONNECTION_ID, "disabled"),
    404,
  );
  await rejectsStatus(
    store.setSupportState("owner@example.com", CONNECTION_ID, "paused"),
    400,
  );
});

test("support enable delegates to the repository mutation-authority gate", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  await store.updateConfiguration("owner@example.com", validConfiguration());
  const current = repository.configurations.get("owner@example.com");
  Object.assign(current, {
    supportState: "disabled",
    webhookVerifiedAt: new Date("2026-07-18T00:00:00.000Z"),
  });

  const enabled = await store.enableIfReady(" OWNER@EXAMPLE.COM ", CONNECTION_ID);

  assert.equal(enabled.supportState, "enabled");
  assert.equal(enabled.version, 1);
  assert.equal(JSON.stringify(enabled).includes(WEBHOOK_KEY_HASH), false);
  assert.deepEqual(
    repository.calls.find(([operation]) => operation === "enableConfigurationIfReady").slice(1, 3),
    ["owner@example.com", CONNECTION_ID],
  );

  repository.enableConfigurationIfReady = async () => null;
  current.supportState = "disabled";
  await assert.rejects(
    store.enableIfReady("owner@example.com", CONNECTION_ID),
    (error) => error.status === 409
      && error.message === "AI support is not ready to be enabled.",
  );
  assert.equal(current.supportState, "disabled");
});

test("FAQ CRUD normalizes content, deduplicates keywords, and stays owner scoped", async () => {
  const repository = createMemoryRepository();
  const store = createStore(repository);
  const faq = await store.createFaq(" OWNER@EXAMPLE.COM ", {
    question: " Q ",
    answer: " A ",
    category: " general ",
    keywords: [" q ", "Q", "shipping"],
  });

  assert.deepEqual(faq, {
    id: faq.id,
    question: "Q",
    answer: "A",
    category: "general",
    keywords: ["q", "shipping"],
    enabled: true,
    priority: 0,
    createdAt: faq.createdAt,
    updatedAt: faq.updatedAt,
  });
  assert.deepEqual((await store.listFaqs("owner@example.com")).map(({ id }) => id), [faq.id]);

  await assert.rejects(
    store.updateFaq("other@example.com", faq.id, { answer: "stolen" }),
    (error) => error.status === 404,
  );
  const updated = await store.updateFaq("owner@example.com", faq.id, { answer: "Updated", enabled: false, priority: -100 });
  assert.equal(updated.answer, "Updated");
  assert.equal(updated.enabled, false);
  assert.equal(updated.priority, -100);
  assert.equal(await store.deleteFaq("other@example.com", faq.id).catch((error) => error.status), 404);
  await store.deleteFaq("owner@example.com", faq.id);
  assert.deepEqual(await store.listFaqs("owner@example.com"), []);
});

test("FAQ validation enforces content, keyword, and priority bounds", async () => {
  const store = createStore();

  await rejectsStatus(store.createFaq("owner@example.com", { question: "", answer: "A" }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: 123, answer: "A" }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "x".repeat(4001) }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "A", category: "x".repeat(81) }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "A", keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "A", keywords: ["x".repeat(81)] }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "A", priority: 101 }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "A", enabled: "yes" }), 400);
  await rejectsStatus(store.createFaq("owner@example.com", { question: "Q", answer: "A", extra: true }), 400);
});

test("FAQ create defaults only absent optional fields and rejects explicit invalid values", async () => {
  const store = createStore();
  const faq = await store.createFaq("owner@example.com", { question: "Q", answer: "A" });

  assert.equal(faq.category, "");
  assert.deepEqual(faq.keywords, []);
  assert.equal(faq.enabled, true);
  assert.equal(faq.priority, 0);

  for (const invalid of [
    { category: null },
    { category: 123 },
    { category: {} },
    { keywords: null },
    { keywords: "keyword" },
    { enabled: null },
    { enabled: "true" },
    { priority: null },
    { priority: "0" },
  ]) {
    await rejectsStatus(store.createFaq("owner@example.com", {
      question: "Q",
      answer: "A",
      ...invalid,
    }), 400);
  }
});

test("FAQ update preserves absent optional fields and rejects explicit invalid values", async () => {
  const store = createStore();
  const faq = await store.createFaq("owner@example.com", {
    question: "Q",
    answer: "A",
    category: "billing",
    keywords: ["invoice"],
    enabled: false,
    priority: 7,
  });
  const updated = await store.updateFaq("owner@example.com", faq.id, { answer: "Updated" });

  assert.equal(updated.category, "billing");
  assert.deepEqual(updated.keywords, ["invoice"]);
  assert.equal(updated.enabled, false);
  assert.equal(updated.priority, 7);

  for (const invalid of [
    { category: null },
    { category: 123 },
    { keywords: null },
    { keywords: {} },
    { enabled: null },
    { enabled: 1 },
    { priority: null },
    { priority: "7" },
  ]) {
    await rejectsStatus(store.updateFaq("owner@example.com", faq.id, invalid), 400);
  }
});

test("FAQ keyword limits apply after trimming and deduplication", async () => {
  const store = createStore();
  const duplicateKeywords = Array.from({ length: 21 }, (_, index) => (
    index % 2 === 0 ? " repeated " : "REPEATED"
  ));
  const faq = await store.createFaq("owner@example.com", {
    question: "Q",
    answer: "A",
    keywords: duplicateKeywords,
  });

  assert.deepEqual(faq.keywords, ["repeated"]);
  await rejectsStatus(store.createFaq("owner@example.com", {
    question: "Q",
    answer: "A",
    keywords: Array.from({ length: 21 }, (_, index) => `keyword-${index}`),
  }), 400);
});

test("human Push 401 marks the owned connection for reconnect and leaves a safe failed message", async () => {
  const calls = [];
  const repository = {
    async prepareHumanMessage(owner, conversationId, message) {
      calls.push(["prepare", owner, conversationId, message]);
      return {
        id: "11111111-1111-4111-8111-111111111111", deliveryStatus: "pending",
        connectionId: CONNECTION_ID, canonicalBody: '{"to":"private","messages":[{"type":"text","text":"Hello"}]}',
        retryKey: "11111111-1111-4111-8111-111111111111",
      };
    },
    async loadLineAccessToken() { return "private-token"; },
    async markOwnedLineConnectionNeedsReconnect(owner, connectionId, conversationId) {
      calls.push(["reconnect", owner, connectionId, conversationId]);
      return true;
    },
    async markHumanMessageDelivery(owner, messageId, status, safeErrorCode) {
      calls.push(["mark", owner, messageId, status, safeErrorCode]);
      return { id: messageId, deliveryStatus: status, safeErrorCode };
    },
  };
  const store = createSupportStore({
    repository, encryptionKey: "support-store-test-key",
    lineAdapter: { pushCanonical: async () => ({ status: 401, headers: {} }) },
  });

  assert.deepEqual(await store.sendHumanMessage("OWNER@EXAMPLE.COM", "conversation-1", {
    text: "Hello", idempotencyKey: "stable-key",
  }), {
    id: "11111111-1111-4111-8111-111111111111",
    deliveryStatus: "failed",
    safeErrorCode: "line_push_4xx",
  });
  assert.equal(calls.some(([name]) => name === "reconnect"), true);
  assert.deepEqual(calls.find(([name]) => name === "reconnect"), [
    "reconnect", "owner@example.com", CONNECTION_ID, "conversation-1",
  ]);
});

test("human retry loads immutable server-stored content and reuses the original message UUID", async () => {
  const calls = [];
  const repository = {
    async prepareHumanMessageRetry(owner, messageId) {
      calls.push(["prepare-retry", owner, messageId]);
      return {
        id: messageId, deliveryStatus: "pending", connectionId: CONNECTION_ID,
        canonicalBody: '{"to":"stored-recipient","messages":[{"type":"text","text":"Stored text"}]}',
        retryKey: messageId,
      };
    },
    async loadLineAccessToken() { return "private-token"; },
    async markHumanMessageDelivery(owner, messageId, status, safeErrorCode) {
      calls.push(["mark", owner, messageId, status, safeErrorCode]);
      return { id: messageId, deliveryStatus: status, safeErrorCode };
    },
  };
  const pushes = [];
  const store = createSupportStore({
    repository, encryptionKey: "support-store-test-key",
    lineAdapter: { pushCanonical: async (input) => { pushes.push(input); return { status: 200, headers: {} }; } },
  });

  const result = await store.retryHumanMessage(
    "owner@example.com",
    "11111111-1111-4111-8111-111111111111",
  );

  assert.equal(result.deliveryStatus, "sent");
  assert.deepEqual(pushes, [{
    accessToken: "private-token",
    canonicalBody: '{"to":"stored-recipient","messages":[{"type":"text","text":"Stored text"}]}',
    retryKey: "11111111-1111-4111-8111-111111111111",
  }]);
});

function createStore(repository = createMemoryRepository()) {
  return createSupportStore({
    repository,
    encryptionKey: "support-store-test-key",
    modelOptions: getLLMModelOptions,
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    randomUUID: sequenceUuid(),
  });
}

function createMemoryRepository() {
  const configurations = new Map();
  const faqs = new Map();
  const connections = new Map([[CONNECTION_ID, "owner@example.com"]]);
  const calls = [];
  return {
    configurations,
    connections,
    faqs,
    calls,
    async findOwnedLineConnection(ownerEmail, id) {
      calls.push(["findOwnedLineConnection", ownerEmail, id]);
      return connections.get(id) === ownerEmail ? { id, ownerEmail, encryptedCredentials: "encrypted-credential" } : null;
    },
    async findActiveLineConnection(ownerEmail) {
      calls.push(["findActiveLineConnection", ownerEmail]);
      const entry = [...connections.entries()].find(([, connectionOwner]) => (
        connectionOwner === ownerEmail
      ));
      return entry ? { id: entry[0], ownerEmail, state: "active", platform: "line" } : null;
    },
    async getConfiguration(ownerEmail) {
      calls.push(["getConfiguration", ownerEmail]);
      return configurations.get(ownerEmail) ?? null;
    },
    async createConfiguration(ownerEmail, record) {
      calls.push(["createConfiguration", ownerEmail, record]);
      const stored = { ...record, ownerEmail };
      configurations.set(ownerEmail, stored);
      return stored;
    },
    async updateConfiguration(ownerEmail, id, changes, options = {}) {
      calls.push(["updateConfiguration", ownerEmail, id, changes, options]);
      const current = configurations.get(ownerEmail);
      if (!current || current.id !== id) return null;
      if (options.expectedVersion != null && current.version !== options.expectedVersion) return null;
      if (options.expectedWebhookKeyHash != null
        && current.webhookKeyHash !== options.expectedWebhookKeyHash) return null;
      const stored = { ...current, ...changes };
      configurations.set(ownerEmail, stored);
      return stored;
    },
    async enableConfigurationIfReady(ownerEmail, connectionId, now) {
      calls.push(["enableConfigurationIfReady", ownerEmail, connectionId, now]);
      const current = configurations.get(ownerEmail);
      if (!current || current.platformConnectionId !== connectionId) return null;
      const stored = {
        ...current,
        supportState: "enabled",
        version: current.version + 1,
        updatedAt: now,
      };
      configurations.set(ownerEmail, stored);
      return stored;
    },
    async listFaqs(ownerEmail) {
      calls.push(["listFaqs", ownerEmail]);
      return [...faqs.values()].filter((record) => record.ownerEmail === ownerEmail);
    },
    async createFaq(ownerEmail, record) {
      calls.push(["createFaq", ownerEmail, record]);
      const stored = { ...record, ownerEmail };
      faqs.set(record.id, stored);
      return stored;
    },
    async updateFaq(ownerEmail, id, changes) {
      calls.push(["updateFaq", ownerEmail, id, changes]);
      const current = faqs.get(id);
      if (!current || current.ownerEmail !== ownerEmail) return null;
      const stored = { ...current, ...changes };
      faqs.set(id, stored);
      return stored;
    },
    async deleteFaq(ownerEmail, id) {
      calls.push(["deleteFaq", ownerEmail, id]);
      const current = faqs.get(id);
      if (!current || current.ownerEmail !== ownerEmail) return null;
      faqs.delete(id);
      return current;
    },
  };
}

function validConfiguration() {
  return {
    platformConnectionId: CONNECTION_ID,
    brandName: "Acme",
    assistantName: "Ada",
    replyTone: "friendly",
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    redeliveryAcknowledged: true,
    nativeRepliesDisabledAcknowledged: true,
  };
}

function browserConfiguration() {
  const { platformConnectionId: _platformConnectionId, ...configuration } = validConfiguration();
  return configuration;
}

function sequenceUuid() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function inboxRecord(index) {
  const timestamp = new Date(Date.UTC(2026, 6, 19, 0, 0, index));
  return {
    id: `conversation-${String(index).padStart(2, "0")}`,
    customerLabel: "Customer",
    status: "ai_active",
    unreadCount: 0,
    handoffReason: null,
    lastMessagePreview: `message ${index}`,
    deliveryFailed: false,
    lastInboundAt: timestamp,
    lastOutboundAt: null,
    updatedAt: timestamp,
    pendingTransition: null,
  };
}

async function rejectsStatus(promise, status) {
  await assert.rejects(promise, (error) => error.status === status);
}
