import { and, desc, eq, exists, sql } from "drizzle-orm";

import { getLLMModelOptions } from "../ai/model-config.js";
import { createDbClient } from "../db/index.js";
import {
  platformConnections,
  supportConfigurations,
  supportFaqs,
  userSettings,
} from "../db/schema.js";
import { normalizeEmail } from "../auth/policy.js";
import { decryptJson } from "../settings/credential-crypto.js";

const PROVIDER_KEY_BY_NAME = Object.freeze({
  google: "googleAiApiKey",
  openai: "openAiApiKey",
});

export function createSupportRepository(db = createDbClient(), {
  encryptionKey,
  decryptSettings = (encryptedSettings) => decryptJson(encryptedSettings, encryptionKey),
  modelOptions = getLLMModelOptions,
} = {}) {
  return {
    async findOwnedLineConnection(ownerEmail, connectionId) {
      return findOwnedLineConnection(db, normalizeOwner(ownerEmail), connectionId);
    },

    async findActiveLineConnection(ownerEmail) {
      return findActiveLineConnection(db, normalizeOwner(ownerEmail));
    },

    async getConfiguration(ownerEmail) {
      const [record] = await db.select().from(supportConfigurations)
        .where(eq(supportConfigurations.ownerEmail, normalizeOwner(ownerEmail)))
        .orderBy(desc(supportConfigurations.updatedAt))
        .limit(1);
      return record ?? null;
    },

    async createConfiguration(ownerEmail, record) {
      const owner = normalizeOwner(ownerEmail);
      if (!await findOwnedLineConnection(db, owner, record.platformConnectionId)) return null;
      const [created] = await db.insert(supportConfigurations).values({
        ...record,
        ownerEmail: owner,
      }).returning();
      return created;
    },

    async updateConfiguration(ownerEmail, id, changes, {
      expectedVersion,
      expectedWebhookKeyHash,
    } = {}) {
      const owner = normalizeOwner(ownerEmail);
      if (expectedVersion != null
        && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) return null;
      if (expectedWebhookKeyHash != null
        && (typeof expectedWebhookKeyHash !== "string" || !expectedWebhookKeyHash)) return null;
      const safeChanges = pickChanges(changes, [
        "platformConnectionId", "brandName", "assistantName", "replyTone", "llmProvider", "llmModel",
        "supportState", "webhookKeyHash", "webhookVerifiedAt", "redeliveryAcknowledgedAt",
        "nativeRepliesDisabledAcknowledgedAt", "providerTestedAt", "version", "updatedAt",
      ]);
      if (safeChanges.platformConnectionId
        && !await findOwnedLineConnection(db, owner, safeChanges.platformConnectionId)) return null;
      const predicates = [
        eq(supportConfigurations.ownerEmail, owner),
        eq(supportConfigurations.id, id),
      ];
      if (expectedVersion != null) {
        predicates.push(eq(supportConfigurations.version, expectedVersion));
      }
      if (expectedWebhookKeyHash != null) {
        predicates.push(eq(supportConfigurations.webhookKeyHash, expectedWebhookKeyHash));
      }
      const [updated] = await db.update(supportConfigurations).set(safeChanges)
        .where(and(...predicates))
        .returning();
      return updated ?? null;
    },

    async enableConfigurationIfReady(ownerEmail, connectionId, now) {
      const owner = normalizeOwner(ownerEmail);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const [[configuration], [connection], [storedSettings], [enabledFaq]] = await Promise.all([
          db.select().from(supportConfigurations).where(and(
            eq(supportConfigurations.ownerEmail, owner),
            eq(supportConfigurations.platformConnectionId, connectionId),
          )).limit(1),
          db.select({ id: platformConnections.id }).from(platformConnections).where(and(
            eq(platformConnections.id, connectionId),
            eq(platformConnections.ownerEmail, owner),
            eq(platformConnections.platform, "line"),
            eq(platformConnections.state, "active"),
          )).limit(1),
          db.select({
            encryptedSettings: userSettings.encryptedSettings,
          }).from(userSettings).where(eq(userSettings.ownerEmail, owner)).limit(1),
          db.select({ id: supportFaqs.id }).from(supportFaqs).where(and(
            eq(supportFaqs.ownerEmail, owner),
            eq(supportFaqs.enabled, true),
          )).limit(1),
        ]);
        if (!configuration || !connection || !storedSettings || !enabledFaq
          || !hasPersistedReadiness(configuration)) return null;

        let settings;
        try {
          settings = await decryptSettings(storedSettings.encryptedSettings);
        } catch {
          return null;
        }
        if (!hasConfiguredProvider(configuration, settings, modelOptions)) return null;

        const settingsUnchanged = db.select({ one: sql`1` }).from(userSettings).where(and(
          eq(userSettings.ownerEmail, owner),
          eq(userSettings.encryptedSettings, storedSettings.encryptedSettings),
        ));
        const lineStillActive = db.select({ one: sql`1` }).from(platformConnections).where(and(
          eq(platformConnections.id, connectionId),
          eq(platformConnections.ownerEmail, owner),
          eq(platformConnections.platform, "line"),
          eq(platformConnections.state, "active"),
        ));
        const faqStillEnabled = db.select({ one: sql`1` }).from(supportFaqs).where(and(
          eq(supportFaqs.ownerEmail, owner),
          eq(supportFaqs.enabled, true),
        ));
        const updated = await retryBusyOperation(() => db.update(supportConfigurations).set({
          supportState: "enabled",
          version: configuration.version + 1,
          updatedAt: now,
        }).where(and(
          eq(supportConfigurations.id, configuration.id),
          eq(supportConfigurations.ownerEmail, owner),
          eq(supportConfigurations.platformConnectionId, connectionId),
          eq(supportConfigurations.version, configuration.version),
          exists(settingsUnchanged),
          exists(lineStillActive),
          exists(faqStillEnabled),
        )).returning());
        if (updated[0]) return updated[0];
      }
      return null;
    },

    async listFaqs(ownerEmail) {
      return db.select().from(supportFaqs)
        .where(eq(supportFaqs.ownerEmail, normalizeOwner(ownerEmail)))
        .orderBy(desc(supportFaqs.priority), desc(supportFaqs.updatedAt));
    },

    async createFaq(ownerEmail, record) {
      const [created] = await db.insert(supportFaqs).values({
        ...record,
        ownerEmail: normalizeOwner(ownerEmail),
      }).returning();
      return created;
    },

    async updateFaq(ownerEmail, id, changes) {
      const safeChanges = pickChanges(changes, [
        "question", "answer", "category", "keywordsJson", "enabled", "priority", "updatedAt",
      ]);
      const [updated] = await db.update(supportFaqs).set(safeChanges).where(and(
        eq(supportFaqs.ownerEmail, normalizeOwner(ownerEmail)),
        eq(supportFaqs.id, id),
      )).returning();
      return updated ?? null;
    },

    async deleteFaq(ownerEmail, id) {
      const [deleted] = await db.delete(supportFaqs).where(and(
        eq(supportFaqs.ownerEmail, normalizeOwner(ownerEmail)),
        eq(supportFaqs.id, id),
      )).returning();
      return deleted ?? null;
    },
  };
}

function hasPersistedReadiness(configuration) {
  return Boolean(
    configuration.webhookVerifiedAt
    && configuration.redeliveryAcknowledgedAt
    && configuration.nativeRepliesDisabledAcknowledgedAt,
  );
}

function hasConfiguredProvider(configuration, settings, modelOptions) {
  const provider = configuration?.llmProvider;
  const model = configuration?.llmModel;
  const keyName = PROVIDER_KEY_BY_NAME[provider];
  const models = provider
    ? (typeof modelOptions === "function" ? modelOptions(provider) : modelOptions?.[provider])
    : [];
  return Boolean(
    keyName
    && typeof model === "string"
    && Array.isArray(models)
    && models.includes(model)
    && typeof settings?.[keyName] === "string"
    && settings[keyName].trim(),
  );
}

async function retryBusyOperation(operation, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!String(error?.code ?? "").startsWith("SQLITE_BUSY") || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

async function findOwnedLineConnection(db, ownerEmail, connectionId) {
  const [record] = await db.select({
    id: platformConnections.id,
    ownerEmail: platformConnections.ownerEmail,
    platform: platformConnections.platform,
    state: platformConnections.state,
  }).from(platformConnections).where(and(
    eq(platformConnections.ownerEmail, ownerEmail),
    eq(platformConnections.id, connectionId),
    eq(platformConnections.platform, "line"),
    eq(platformConnections.state, "active"),
  )).limit(1);
  return record ?? null;
}

async function findActiveLineConnection(db, ownerEmail) {
  const [record] = await db.select({
    id: platformConnections.id,
    ownerEmail: platformConnections.ownerEmail,
    platform: platformConnections.platform,
    state: platformConnections.state,
  }).from(platformConnections).where(and(
    eq(platformConnections.ownerEmail, ownerEmail),
    eq(platformConnections.platform, "line"),
    eq(platformConnections.state, "active"),
  )).limit(1);
  return record ?? null;
}

function pickChanges(changes, keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(changes ?? {}, key)).map((key) => [key, changes[key]]),
  );
}

function normalizeOwner(ownerEmail) {
  const owner = normalizeEmail(ownerEmail);
  if (!owner) throw routeError("Authentication is required.", 401);
  return owner;
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
