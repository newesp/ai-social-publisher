import assert from "node:assert/strict";
import { test } from "node:test";

import { createUserSettingsStore } from "../src/lib/settings/user-settings-store.js";
import { encryptJson } from "../src/lib/settings/credential-crypto.js";

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

  assert.deepEqual(await store.read("owner@example.com"), { googleAiApiKey: "owner-google-key" });
  assert.deepEqual(await store.read("other@example.com"), { googleAiApiKey: "other-google-key" });
  assert.notEqual(repository.records.get("owner@example.com").encryptedSettings.includes("owner-google-key"), true);
  assert.notEqual(repository.records.get("other@example.com").encryptedSettings.includes("other-google-key"), true);
});

test("returns only masked AI values and preserves secrets for empty input", async () => {
  const { store } = createStore();

  await store.update("owner@example.com", {
    googleAiApiKey: "google-secret",
  });
  await store.update("owner@example.com", { googleAiApiKey: "   " });

  assert.deepEqual(await store.getMasked("owner@example.com"), {
    googleAiApiKey: "goo...ret",
  });
  assert.deepEqual(await store.read("owner@example.com"), {
    googleAiApiKey: "google-secret",
  });
});

test("rejects legacy platform credentials from writable settings", async () => {
  const { store } = createStore();

  for (const key of ["metaPageId", "metaPageAccessToken", "lineChannelAccessToken"]) {
    await assert.rejects(store.update("owner@example.com", { [key]: "legacy-secret" }), /unsupported settings key/i);
  }
  assert.deepEqual(await store.read("owner@example.com"), {});
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

test("legacy records expose only current AI settings and drop platform credentials on update", async () => {
  const { store, repository } = createStore();
  const encryptionKey = "test-only-settings-encryption-key";
  repository.records.set("owner@example.com", {
    ownerEmail: "owner@example.com",
    encryptedSettings: encryptJson({
      googleAiApiKey: "google-secret",
      openAiApiKey: "openai-secret",
      metaPageId: "legacy-page-id",
      metaPageAccessToken: "legacy-meta-token",
      lineChannelAccessToken: "legacy-line-token",
      unexpectedLegacySetting: "legacy-value",
    }, encryptionKey),
    updatedAt: new Date(),
  });

  assert.deepEqual(await store.read("owner@example.com"), {
    googleAiApiKey: "google-secret",
    openAiApiKey: "openai-secret",
  });
  assert.deepEqual(await store.getMasked("owner@example.com"), {
    googleAiApiKey: "goo...ret",
    openAiApiKey: "ope...ret",
  });

  await store.update("owner@example.com", { googleAiApiKey: "new-google-secret" });
  assert.deepEqual(await store.read("owner@example.com"), {
    googleAiApiKey: "new-google-secret",
    openAiApiKey: "openai-secret",
  });
});
