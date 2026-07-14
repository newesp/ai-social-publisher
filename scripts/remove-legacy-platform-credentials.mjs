import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { postTargets, posts, userSettings } from "../src/lib/db/schema.js";
import { decryptJson, encryptJson } from "../src/lib/settings/credential-crypto.js";

export const LEGACY_RECONNECTION_MESSAGE = "Platform reconnection is required.";

const LEGACY_PLATFORM_SETTING_KEYS = new Set([
  "metaPageId",
  "metaPageAccessToken",
  "lineChannelAccessToken",
  "META_PAGE_ID",
  "META_PAGE_ACCESS_TOKEN",
  "LINE_CHANNEL_ACCESS_TOKEN",
]);
const UNBOUND_TARGET_STATUSES = new Set(["pending", "draft", "scheduled"]);
const REQUIRED_MIGRATION_CONFIG_KEYS = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "SETTINGS_ENCRYPTION_KEY"];

export function removeLegacyPlatformCredentials(settings) {
  return Object.fromEntries(
    Object.entries(settings ?? {}).filter(([key]) => !LEGACY_PLATFORM_SETTING_KEYS.has(key)),
  );
}

export function shouldFailUnboundTarget(target) {
  return !target?.platformConnectionId && UNBOUND_TARGET_STATUSES.has(target?.status);
}

export async function migrateLegacyPlatformData({ repository, encryptionKey, now = new Date() }) {
  return repository.transaction(async (transaction) => {
    let cleanedSettings = 0;
    const records = await transaction.listUserSettings();

    for (const record of records) {
      const settings = decryptJson(record.encryptedSettings, encryptionKey);
      const cleaned = removeLegacyPlatformCredentials(settings);
      if (Object.keys(cleaned).length === Object.keys(settings ?? {}).length) continue;

      await transaction.saveUserSetting({
        ...record,
        encryptedSettings: encryptJson(cleaned, encryptionKey),
        updatedAt: now,
      }, record.encryptedSettings);
      cleanedSettings += 1;
    }

    const { count: failedTargets, postIds } = await transaction.failUnboundPendingTargets(now, LEGACY_RECONNECTION_MESSAGE);
    if (postIds.length > 0) await transaction.failPendingPosts(postIds, now);
    return { cleanedSettings, failedTargets };
  });
}

export async function runLegacyPlatformCleanup({
  directExecution = isDirectExecution(import.meta.url, process.argv[1]),
  env = process.env,
  createRepository = createDatabaseRepository,
  now = new Date(),
} = {}) {
  if (!directExecution) return null;
  validateMigrationConfig(env);
  const repository = await createRepository(env);
  return migrateLegacyPlatformData({ repository, encryptionKey: env.SETTINGS_ENCRYPTION_KEY, now });
}

export function isDirectExecution(moduleUrl, argvPath) {
  if (!argvPath) return false;
  return resolve(fileURLToPath(moduleUrl)) === resolve(argvPath);
}

export function validateMigrationConfig(env) {
  for (const key of REQUIRED_MIGRATION_CONFIG_KEYS) {
    if (!String(env[key] ?? "").trim()) throw new Error(`${key} must be configured.`);
  }
}

export function createLegacyCleanupRepository(db) {
  return {
    async transaction(work) {
      return db.transaction((tx) => work(createLegacyCleanupRepository(tx)));
    },
    async listUserSettings() {
      return db.select().from(userSettings);
    },
    async saveUserSetting(record, previousEncryptedSettings) {
      const updated = await db.update(userSettings).set({
        encryptedSettings: record.encryptedSettings,
        updatedAt: record.updatedAt,
      }).where(and(
        eq(userSettings.ownerEmail, record.ownerEmail),
        eq(userSettings.encryptedSettings, previousEncryptedSettings),
      )).returning({ ownerEmail: userSettings.ownerEmail });
      if (updated.length !== 1) throw new Error("A user settings record changed during legacy credential cleanup.");
    },
    async failUnboundPendingTargets(now, errorMessage) {
      const updated = await db.update(postTargets).set({
        status: "failed",
        errorMessage,
        updatedAt: now,
      }).where(and(
        isNull(postTargets.platformConnectionId),
        inArray(postTargets.status, [...UNBOUND_TARGET_STATUSES]),
      )).returning({ postId: postTargets.postId });
      return { count: updated.length, postIds: [...new Set(updated.map((target) => target.postId))] };
    },
    async failPendingPosts(postIds, now) {
      await db.update(posts).set({
        status: "failed",
        updatedAt: now,
      }).where(and(
        inArray(posts.id, postIds),
        inArray(posts.status, [...UNBOUND_TARGET_STATUSES]),
      ));
    },
  };
}

async function createDatabaseRepository(env) {
  const { createDbClient } = await import("../src/lib/db/index.js");
  return createLegacyCleanupRepository(createDbClient(env));
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runLegacyPlatformCleanup({ directExecution: true })
    .then(({ cleanedSettings, failedTargets }) => {
      console.log(`Legacy platform credential cleanup complete: ${cleanedSettings} settings row(s), ${failedTargets} target(s).`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
