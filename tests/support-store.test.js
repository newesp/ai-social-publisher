import assert from "node:assert/strict";
import { test } from "node:test";

import { getLLMModelOptions } from "../src/lib/ai/model-config.js";
import { createSupportStore } from "../src/lib/support/support-store.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

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
    async getConfiguration(ownerEmail) {
      calls.push(["getConfiguration", ownerEmail]);
      return configurations.get(ownerEmail) ?? null;
    },
    async createConfiguration(ownerEmail, record) {
      calls.push(["createConfiguration", ownerEmail, record]);
      const stored = { ...record, ownerEmail, webhookKeyHash: "webhook-hash" };
      configurations.set(ownerEmail, stored);
      return stored;
    },
    async updateConfiguration(ownerEmail, id, changes) {
      calls.push(["updateConfiguration", ownerEmail, id, changes]);
      const current = configurations.get(ownerEmail);
      if (!current || current.id !== id) return null;
      const stored = { ...current, ...changes };
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

function sequenceUuid() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

async function rejectsStatus(promise, status) {
  await assert.rejects(promise, (error) => error.status === status);
}
