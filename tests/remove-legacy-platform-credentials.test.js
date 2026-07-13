import assert from "node:assert/strict";
import { test } from "node:test";

import { decryptJson, encryptJson } from "../src/lib/settings/credential-crypto.js";
import {
  LEGACY_RECONNECTION_MESSAGE,
  migrateLegacyPlatformData,
  removeLegacyPlatformCredentials,
  runLegacyPlatformCleanup,
  shouldFailUnboundTarget,
} from "../scripts/remove-legacy-platform-credentials.mjs";

const ENCRYPTION_KEY = "test-only-legacy-cleanup-key";

function createMemoryRepository({ settings = [], targets = [], posts = [], beforeSave } = {}) {
  const records = settings.map((record) => ({ ...record }));
  const targetRecords = targets.map((target) => ({ ...target }));
  const postRecords = posts.map((post) => ({ ...post }));
  const savedOwners = [];

  return {
    records,
    targetRecords,
    postRecords,
    savedOwners,
    async transaction(work) {
      const snapshot = {
        records: structuredClone(records),
        targets: structuredClone(targetRecords),
        posts: structuredClone(postRecords),
        savedOwners: [...savedOwners],
      };
      try {
        return await work(this);
      } catch (error) {
        records.splice(0, records.length, ...snapshot.records);
        targetRecords.splice(0, targetRecords.length, ...snapshot.targets);
        postRecords.splice(0, postRecords.length, ...snapshot.posts);
        savedOwners.splice(0, savedOwners.length, ...snapshot.savedOwners);
        throw error;
      }
    },
    async listUserSettings() {
      return records;
    },
    async saveUserSetting(record, previousEncryptedSettings) {
      await beforeSave?.({ records, record, previousEncryptedSettings });
      const index = records.findIndex((candidate) => candidate.ownerEmail === record.ownerEmail);
      if (index < 0 || records[index].encryptedSettings !== previousEncryptedSettings) {
        throw new Error("A user settings record changed during legacy credential cleanup.");
      }
      records[index] = { ...record };
      savedOwners.push(record.ownerEmail);
    },
    async failUnboundPendingTargets(now, errorMessage) {
      let changed = 0;
      const postIds = new Set();
      for (const target of targetRecords) {
        if (!shouldFailUnboundTarget(target)) continue;
        Object.assign(target, { status: "failed", errorMessage, updatedAt: now });
        postIds.add(target.postId);
        changed += 1;
      }
      return { count: changed, postIds: [...postIds] };
    },
    async failPendingPosts(postIds, now) {
      for (const post of postRecords) {
        if (postIds.includes(post.id) && ["pending", "draft", "scheduled"].includes(post.status)) {
          Object.assign(post, { status: "failed", updatedAt: now });
        }
      }
    },
  };
}

function encryptedRecord(ownerEmail, settings) {
  return {
    ownerEmail,
    encryptedSettings: encryptJson(settings, ENCRYPTION_KEY),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
}

test("legacy cleanup removes publishing credentials and aliases while preserving AI and unrelated settings", () => {
  const cleaned = removeLegacyPlatformCredentials({
    googleAiApiKey: "google-key",
    openAiApiKey: "openai-key",
    preferredModel: "gemini-custom",
    unrelatedSetting: { nested: true },
    metaPageId: "page-id",
    metaPageAccessToken: "page-token",
    lineChannelAccessToken: "line-token",
    META_PAGE_ID: "page-id-alias",
    META_PAGE_ACCESS_TOKEN: "page-token-alias",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token-alias",
  });

  assert.deepEqual(cleaned, {
    googleAiApiKey: "google-key",
    openAiApiKey: "openai-key",
    preferredModel: "gemini-custom",
    unrelatedSetting: { nested: true },
  });
});

test("migration decrypts and re-encrypts only legacy settings rows and is idempotent", async () => {
  const legacy = encryptedRecord("owner@example.com", {
    googleAiApiKey: "google-key",
    metaPageAccessToken: "legacy-token",
    unrelatedSetting: "keep-me",
  });
  const current = encryptedRecord("other@example.com", { openAiApiKey: "openai-key", theme: "dark" });
  const currentCiphertext = current.encryptedSettings;
  const repository = createMemoryRepository({ settings: [legacy, current] });
  const now = new Date("2026-07-13T08:00:00.000Z");

  assert.deepEqual(await migrateLegacyPlatformData({ repository, encryptionKey: ENCRYPTION_KEY, now }), {
    cleanedSettings: 1,
    failedTargets: 0,
  });
  assert.deepEqual(decryptJson(repository.records[0].encryptedSettings, ENCRYPTION_KEY), {
    googleAiApiKey: "google-key",
    unrelatedSetting: "keep-me",
  });
  assert.equal(repository.records[1].encryptedSettings, currentCiphertext);
  assert.deepEqual(repository.savedOwners, ["owner@example.com"]);

  assert.deepEqual(await migrateLegacyPlatformData({ repository, encryptionKey: ENCRYPTION_KEY, now }), {
    cleanedSettings: 0,
    failedTargets: 0,
  });
  assert.deepEqual(repository.savedOwners, ["owner@example.com"]);
});

test("changed settings ciphertext aborts and rolls back the cleanup transaction", async () => {
  const first = encryptedRecord("first@example.com", { metaPageAccessToken: "first-legacy-token" });
  const conflicted = encryptedRecord("conflicted@example.com", { lineChannelAccessToken: "line-legacy-token" });
  const repository = createMemoryRepository({
    settings: [first, conflicted],
    beforeSave({ records, record }) {
      if (record.ownerEmail !== conflicted.ownerEmail) return;
      const stored = records.find((candidate) => candidate.ownerEmail === conflicted.ownerEmail);
      stored.encryptedSettings = encryptJson({
        lineChannelAccessToken: "concurrently-changed-token",
      }, ENCRYPTION_KEY);
    },
  });

  await assert.rejects(
    migrateLegacyPlatformData({ repository, encryptionKey: ENCRYPTION_KEY }),
    /changed during legacy credential cleanup/i,
  );
  assert.deepEqual(repository.records, [first, conflicted]);
  assert.deepEqual(repository.savedOwners, []);
});

test("only unbound pending, draft, and scheduled targets become terminal failed", async () => {
  const now = new Date("2026-07-13T08:00:00.000Z");
  const targets = [
    { id: 1, postId: 11, status: "pending", platformConnectionId: null },
    { id: 2, postId: 12, status: "draft", platformConnectionId: null },
    { id: 3, postId: 13, status: "scheduled", platformConnectionId: null },
    { id: 4, postId: 13, status: "scheduled", platformConnectionId: "connection-1" },
    { id: 5, postId: 14, status: "publishing", platformConnectionId: null },
    { id: 6, postId: 15, status: "published", platformConnectionId: null },
    { id: 7, postId: 16, status: "failed", platformConnectionId: null, errorMessage: "Existing failure" },
    { id: 8, postId: 17, status: "cancelled", platformConnectionId: null },
  ];
  const posts = [
    { id: 11, status: "pending" },
    { id: 12, status: "draft" },
    { id: 13, status: "scheduled" },
    { id: 14, status: "publishing" },
    { id: 15, status: "published" },
    { id: 16, status: "failed" },
    { id: 17, status: "cancelled" },
  ];
  const repository = createMemoryRepository({ targets, posts });

  const result = await migrateLegacyPlatformData({ repository, encryptionKey: ENCRYPTION_KEY, now });

  assert.equal(result.failedTargets, 3);
  assert.deepEqual(repository.targetRecords.slice(0, 3).map(({ status, errorMessage, updatedAt }) => ({ status, errorMessage, updatedAt })), [
    { status: "failed", errorMessage: LEGACY_RECONNECTION_MESSAGE, updatedAt: now },
    { status: "failed", errorMessage: LEGACY_RECONNECTION_MESSAGE, updatedAt: now },
    { status: "failed", errorMessage: LEGACY_RECONNECTION_MESSAGE, updatedAt: now },
  ]);
  assert.deepEqual(repository.targetRecords.slice(3), targets.slice(3));
  assert.deepEqual(repository.postRecords.map(({ status }) => status), [
    "failed", "failed", "failed", "publishing", "published", "failed", "cancelled",
  ]);

  assert.equal((await migrateLegacyPlatformData({ repository, encryptionKey: ENCRYPTION_KEY, now })).failedTargets, 0);
});

test("importing the module does not validate configuration or create a database repository", async () => {
  let created = false;
  const result = await runLegacyPlatformCleanup({
    directExecution: false,
    env: {},
    createRepository: async () => {
      created = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result, null);
  assert.equal(created, false);
});

test("direct execution requires migration credentials before creating a database repository", async () => {
  let created = false;

  await assert.rejects(runLegacyPlatformCleanup({
    directExecution: true,
    env: {},
    createRepository: async () => {
      created = true;
      throw new Error("must not connect");
    },
  }), /TURSO_DATABASE_URL/);
  assert.equal(created, false);
});
