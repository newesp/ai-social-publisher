import assert from "node:assert/strict";
import { test } from "node:test";

import { createUserSettingsStore } from "../src/lib/settings/user-settings-store.js";

function createMemoryRepository() {
  const records = new Map();

  return {
    records,
    async findByOwnerEmail(ownerEmail) {
      return records.get(ownerEmail) ?? null;
    },
    async save(record) {
      records.set(record.ownerEmail, record);
    },
  };
}

function createStore(repository = createMemoryRepository()) {
  return {
    repository,
    store: createUserSettingsStore({
      repository,
      encryptionKey: "test-only-settings-encryption-key",
    }),
  };
}

test("keeps each owner's encrypted settings isolated", async () => {
  const { store, repository } = createStore();

  await store.update("owner@example.com", { googleAiApiKey: "owner-google-key" });
  await store.update("other@example.com", { googleAiApiKey: "other-google-key" });
  await store.update("other@example.com", { lineChannelAccessToken: "other-line-token" });

  assert.deepEqual(await store.read("owner@example.com"), { googleAiApiKey: "owner-google-key" });
  assert.deepEqual(await store.read("other@example.com"), {
    googleAiApiKey: "other-google-key",
    lineChannelAccessToken: "other-line-token",
  });
  assert.notEqual(repository.records.get("owner@example.com").encryptedSettings.includes("owner-google-key"), true);
  assert.notEqual(repository.records.get("other@example.com").encryptedSettings.includes("other-google-key"), true);
});

test("returns only masked values and preserves secrets for empty input", async () => {
  const { store } = createStore();

  await store.update("owner@example.com", {
    googleAiApiKey: "google-secret",
    metaPageId: "1234567890",
  });
  await store.update("owner@example.com", { googleAiApiKey: "   " });

  assert.deepEqual(await store.getMasked("owner@example.com"), {
    googleAiApiKey: "goo...ret",
    metaPageId: "1234567890",
  });
  assert.deepEqual(await store.read("owner@example.com"), {
    googleAiApiKey: "google-secret",
    metaPageId: "1234567890",
  });
});

test("rejects masked placeholders instead of persisting them", async () => {
  const { store } = createStore();

  await store.update("owner@example.com", { openAiApiKey: "openai-secret" });

  await assert.rejects(
    store.update("owner@example.com", { openAiApiKey: "ope...ret" }),
    /masked placeholder/i,
  );
  assert.deepEqual(await store.read("owner@example.com"), { openAiApiKey: "openai-secret" });
});
