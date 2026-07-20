import crypto from "node:crypto";

import { and, desc, eq, exists, isNull, lte, or, sql } from "drizzle-orm";

import { getLLMModelOptions } from "../ai/model-config.js";
import { createDbClient } from "../db/index.js";
import {
  platformConnections,
  supportConfigurations,
  supportConversationTransitions,
  supportConversations,
  supportFaqs,
  supportMessages,
  supportWebhookEvents,
  userSettings,
} from "../db/schema.js";
import { normalizeEmail } from "../auth/policy.js";
import { decryptJson } from "../settings/credential-crypto.js";
import {
  customerLookupKey,
  encryptExternalId,
  encryptReplyToken,
} from "./identity-crypto.js";

const PROVIDER_KEY_BY_NAME = Object.freeze({
  google: "googleAiApiKey",
  openai: "openAiApiKey",
});
const DISPATCH_LEASE_MS = 30_000;
const EVENT_PROCESSING_LEASE_MS = 30_000;

export function createSupportRepository(db = createDbClient(), {
  encryptionKey,
  decryptSettings = (encryptedSettings) => decryptJson(encryptedSettings, encryptionKey),
  modelOptions = getLLMModelOptions,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  return {
    async findActiveLineConnectionByWebhookKeyHash(webhookKeyHash) {
      if (typeof webhookKeyHash !== "string" || !/^[a-f0-9]{64}$/.test(webhookKeyHash)) return null;
      const [record] = await db.select({
        id: platformConnections.id,
        ownerEmail: platformConnections.ownerEmail,
        encryptedCredentials: platformConnections.encryptedCredentials,
      }).from(supportConfigurations).innerJoin(platformConnections, and(
        eq(platformConnections.id, supportConfigurations.platformConnectionId),
        eq(platformConnections.ownerEmail, supportConfigurations.ownerEmail),
      )).where(and(
        eq(supportConfigurations.webhookKeyHash, webhookKeyHash),
        eq(platformConnections.platform, "line"),
        eq(platformConnections.state, "active"),
      )).limit(1);
      if (!record) return null;
      try {
        const credentials = decryptJson(record.encryptedCredentials, encryptionKey);
        const channelSecret = typeof credentials?.channelSecret === "string"
          ? credentials.channelSecret
          : "";
        return channelSecret ? { id: record.id, ownerEmail: record.ownerEmail, channelSecret } : null;
      } catch {
        return null;
      }
    },

    async ingestLineUserEvent(input) {
      const event = validateLineUserEvent(input, encryptionKey);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [claimed] = await tx.insert(supportWebhookEvents).values({
          id: randomUUID(),
          platformConnectionId: event.connectionId,
          webhookEventId: event.eventId,
          sourceType: "user",
          processingStatus: "queued",
          encryptedReplyToken: event.encryptedReplyToken,
          replyTokenExpiresAt: event.replyTokenExpiresAt,
          safeErrorCode: null,
          receivedAt: event.receivedAt,
          processedAt: null,
          createdAt: event.receivedAt,
        }).onConflictDoNothing({
          target: [supportWebhookEvents.platformConnectionId, supportWebhookEvents.webhookEventId],
        }).returning({ id: supportWebhookEvents.id });
        if (!claimed) return { inserted: false };

        const [connection] = await tx.select({ id: platformConnections.id }).from(platformConnections).where(and(
          eq(platformConnections.id, event.connectionId),
          eq(platformConnections.ownerEmail, event.ownerEmail),
          eq(platformConnections.platform, "line"),
          eq(platformConnections.state, "active"),
        )).limit(1);
        if (!connection) throw unavailablePersistenceError();

        const [existing] = await tx.select().from(supportConversations).where(and(
          eq(supportConversations.platformConnectionId, event.connectionId),
          eq(supportConversations.customerLookupKey, event.customerLookupKey),
        )).limit(1);
        let conversation;
        if (existing) {
          if (existing.pendingTransitionId) {
            await tx.update(supportConversationTransitions).set({ cancelledAt: event.receivedAt }).where(and(
              eq(supportConversationTransitions.id, existing.pendingTransitionId),
              eq(supportConversationTransitions.conversationId, existing.id),
              isNull(supportConversationTransitions.cancelledAt),
            ));
          }
          [conversation] = await tx.update(supportConversations).set({
            ...(event.message.handoffReasonCode ? {
              status: "waiting_human",
              handoffReasonCode: event.message.handoffReasonCode,
            } : {}),
            unreadCount: existing.unreadCount + 1,
            pendingTransitionId: null,
            pendingAction: null,
            pendingActionEffectiveAt: null,
            version: existing.version + 1,
            lastInboundAt: event.receivedAt,
            updatedAt: event.receivedAt,
          }).where(and(
            eq(supportConversations.id, existing.id),
            eq(supportConversations.ownerEmail, event.ownerEmail),
            eq(supportConversations.platformConnectionId, event.connectionId),
          )).returning();
        } else {
          [conversation] = await tx.insert(supportConversations).values({
            id: randomUUID(),
            ownerEmail: event.ownerEmail,
            platformConnectionId: event.connectionId,
            platform: "line",
            customerLookupKey: event.customerLookupKey,
            encryptedCustomerExternalId: event.encryptedCustomerExternalId,
            status: event.message.handoffReasonCode ? "waiting_human" : "ai_active",
            handoffReasonCode: event.message.handoffReasonCode ?? null,
            unreadCount: 1,
            pendingTransitionId: null,
            pendingAction: null,
            pendingActionEffectiveAt: null,
            processingClaimId: null,
            processingClaimExpiresAt: null,
            version: 0,
            lastInboundAt: event.receivedAt,
            lastOutboundAt: null,
            createdAt: event.receivedAt,
            updatedAt: event.receivedAt,
          }).returning();
        }
        if (!conversation) throw unavailablePersistenceError();
        await tx.insert(supportMessages).values({
          id: randomUUID(),
          conversationId: conversation.id,
          direction: "inbound",
          senderType: "customer",
          messageType: event.message.type,
          textContent: event.message.text,
          safeMetadataJson: JSON.stringify(event.message.safeMetadata),
          providerMessageId: null,
          deliveryStatus: "received",
          idempotencyKey: `${event.connectionId}:${event.eventId}`,
          sentAt: null,
          failedAt: null,
          safeErrorCode: null,
          processedAt: null,
          createdAt: event.receivedAt,
        });
        return { inserted: true, eventId: event.eventId, conversationId: conversation.id };
      }));
    },

    async claimLineWorkflowDispatch({ connectionId, eventId, now = new Date() }) {
      const dispatch = validateDispatchInput({ connectionId, eventId, now });
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const claimId = randomUUID();
        const leaseExpiresAt = new Date(dispatch.now.getTime() + DISPATCH_LEASE_MS);
        const [claimed] = await tx.update(supportWebhookEvents).set({
          processingStatus: "dispatching",
          safeErrorCode: claimId,
          processedAt: leaseExpiresAt,
        }).where(and(
          eq(supportWebhookEvents.platformConnectionId, dispatch.connectionId),
          eq(supportWebhookEvents.webhookEventId, dispatch.eventId),
          or(
            eq(supportWebhookEvents.processingStatus, "queued"),
            eq(supportWebhookEvents.processingStatus, "retryable"),
            and(
              eq(supportWebhookEvents.processingStatus, "dispatching"),
              lte(supportWebhookEvents.processedAt, dispatch.now),
            ),
          ),
        )).returning({ id: supportWebhookEvents.id });
        if (!claimed) return { claimed: false };

        const [message] = await tx.select({ conversationId: supportMessages.conversationId })
          .from(supportMessages).where(eq(
            supportMessages.idempotencyKey,
            `${dispatch.connectionId}:${dispatch.eventId}`,
          )).limit(1);
        if (!message) {
          await tx.update(supportWebhookEvents).set({
            processingStatus: "retryable",
            safeErrorCode: null,
            processedAt: null,
          }).where(and(
            eq(supportWebhookEvents.id, claimed.id),
            eq(supportWebhookEvents.processingStatus, "dispatching"),
            eq(supportWebhookEvents.safeErrorCode, claimId),
          ));
          throw unavailablePersistenceError();
        }
        return {
          claimed: true,
          claimId,
          connectionId: dispatch.connectionId,
          eventId: dispatch.eventId,
          conversationId: message.conversationId,
        };
      }));
    },

    async markLineWorkflowDispatched({ connectionId, eventId, claimId, now = new Date() }) {
      const dispatch = validateDispatchInput({ connectionId, eventId, claimId, now });
      const [updated] = await retryBusyOperation(() => db.update(supportWebhookEvents).set({
        processingStatus: "dispatched",
        safeErrorCode: null,
        processedAt: dispatch.now,
      }).where(and(
        eq(supportWebhookEvents.platformConnectionId, dispatch.connectionId),
        eq(supportWebhookEvents.webhookEventId, dispatch.eventId),
        eq(supportWebhookEvents.processingStatus, "dispatching"),
        eq(supportWebhookEvents.safeErrorCode, dispatch.claimId),
      )).returning({ id: supportWebhookEvents.id }));
      return Boolean(updated);
    },

    async releaseLineWorkflowDispatch({ connectionId, eventId, claimId }) {
      const dispatch = validateDispatchInput({ connectionId, eventId, claimId, now: new Date() });
      const [released] = await retryBusyOperation(() => db.update(supportWebhookEvents).set({
        processingStatus: "retryable",
        safeErrorCode: null,
        processedAt: null,
      }).where(and(
        eq(supportWebhookEvents.platformConnectionId, dispatch.connectionId),
        eq(supportWebhookEvents.webhookEventId, dispatch.eventId),
        eq(supportWebhookEvents.processingStatus, "dispatching"),
        eq(supportWebhookEvents.safeErrorCode, dispatch.claimId),
      )).returning({ id: supportWebhookEvents.id }));
      return Boolean(released);
    },

    async claimLineEventProcessing({ connectionId, eventId, now = new Date() }) {
      const processing = validateDispatchInput({ connectionId, eventId, now });
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const claimId = randomUUID();
        const leaseExpiresAt = new Date(processing.now.getTime() + EVENT_PROCESSING_LEASE_MS);
        const [claimed] = await tx.update(supportWebhookEvents).set({
          processingStatus: "processing",
          safeErrorCode: claimId,
          processedAt: leaseExpiresAt,
        }).where(and(
          eq(supportWebhookEvents.platformConnectionId, processing.connectionId),
          eq(supportWebhookEvents.webhookEventId, processing.eventId),
          eq(supportWebhookEvents.sourceType, "user"),
          or(
            eq(supportWebhookEvents.processingStatus, "dispatched"),
            and(
              eq(supportWebhookEvents.processingStatus, "processing"),
              lte(supportWebhookEvents.processedAt, processing.now),
            ),
          ),
        )).returning({ id: supportWebhookEvents.id });
        if (!claimed) return { claimed: false };
        return {
          claimed: true,
          claimId,
          connectionId: processing.connectionId,
          eventId: processing.eventId,
        };
      }));
    },

    async markLineEventProcessed({ connectionId, eventId, claimId, now = new Date() }) {
      const processing = validateDispatchInput({ connectionId, eventId, claimId, now });
      const [updated] = await retryBusyOperation(() => db.update(supportWebhookEvents).set({
        processingStatus: "processed",
        safeErrorCode: null,
        processedAt: processing.now,
      }).where(and(
        eq(supportWebhookEvents.platformConnectionId, processing.connectionId),
        eq(supportWebhookEvents.webhookEventId, processing.eventId),
        eq(supportWebhookEvents.processingStatus, "processing"),
        eq(supportWebhookEvents.safeErrorCode, processing.claimId),
      )).returning({ id: supportWebhookEvents.id }));
      return Boolean(updated);
    },

    async releaseLineEventProcessing({ connectionId, eventId, claimId }) {
      const processing = validateDispatchInput({ connectionId, eventId, claimId, now: new Date() });
      const [released] = await retryBusyOperation(() => db.update(supportWebhookEvents).set({
        processingStatus: "dispatched",
        safeErrorCode: null,
        processedAt: null,
      }).where(and(
        eq(supportWebhookEvents.platformConnectionId, processing.connectionId),
        eq(supportWebhookEvents.webhookEventId, processing.eventId),
        eq(supportWebhookEvents.processingStatus, "processing"),
        eq(supportWebhookEvents.safeErrorCode, processing.claimId),
      )).returning({ id: supportWebhookEvents.id }));
      return Boolean(released);
    },

    async recordIgnoredLineEvent({ connectionId, eventId, sourceType, receivedAt = new Date() }) {
      const event = validateIgnoredLineEvent({ connectionId, eventId, sourceType, receivedAt });
      return retryBusyOperation(async () => {
        const [claimed] = await db.insert(supportWebhookEvents).values({
          id: randomUUID(),
          platformConnectionId: event.connectionId,
          webhookEventId: event.eventId,
          sourceType: event.sourceType,
          processingStatus: "ignored",
          encryptedReplyToken: null,
          replyTokenExpiresAt: null,
          safeErrorCode: null,
          receivedAt: event.receivedAt,
          processedAt: event.receivedAt,
          createdAt: event.receivedAt,
        }).onConflictDoNothing({
          target: [supportWebhookEvents.platformConnectionId, supportWebhookEvents.webhookEventId],
        }).returning({ id: supportWebhookEvents.id });
        return { inserted: Boolean(claimed) };
      });
    },

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

function validateLineUserEvent(input, encryptionKey) {
  const ownerEmail = normalizeOwner(input?.ownerEmail);
  const connectionId = requiredBoundedText(input?.connectionId, "Connection ID", 100);
  const eventId = requiredBoundedText(input?.eventId, "Webhook event ID", 256);
  const externalUserId = requiredBoundedText(input?.externalUserId, "Customer external ID", 256);
  const replyToken = optionalBoundedText(input?.replyToken, "LINE reply token", 512);
  const receivedAt = validDate(input?.receivedAt);
  const message = validateInboundMessage(input?.message);
  return {
    ownerEmail,
    connectionId,
    eventId,
    encryptedReplyToken: replyToken ? encryptReplyToken(replyToken, encryptionKey) : null,
    replyTokenExpiresAt: replyToken ? new Date(receivedAt.getTime() + 60_000) : null,
    customerLookupKey: customerLookupKey(connectionId, externalUserId, encryptionKey),
    encryptedCustomerExternalId: encryptExternalId(externalUserId, encryptionKey),
    message,
    receivedAt,
  };
}

function validateIgnoredLineEvent({ connectionId, eventId, sourceType, receivedAt }) {
  if (sourceType !== "group" && sourceType !== "room") throw unavailablePersistenceError();
  return {
    connectionId: requiredBoundedText(connectionId, "Connection ID", 100),
    eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
    sourceType,
    receivedAt: validDate(receivedAt),
  };
}

function validateDispatchInput({ connectionId, eventId, claimId, now }) {
  return {
    connectionId: requiredBoundedText(connectionId, "Connection ID", 100),
    eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
    ...(claimId == null ? {} : { claimId: requiredBoundedText(claimId, "Dispatch claim", 100) }),
    now: validDate(now),
  };
}

function validateInboundMessage(message) {
  const type = requiredBoundedText(message?.type, "LINE message type", 64);
  const handoffReasonCode = message?.handoffReasonCode === "non_text" ? "non_text" : null;
  const text = message?.text == null ? null : boundedText(message.text, "LINE message text", 5_000);
  if (type === "text" && text == null) throw unavailablePersistenceError();
  const safeMetadata = message?.safeMetadata && typeof message.safeMetadata === "object"
    && !Array.isArray(message.safeMetadata) ? message.safeMetadata : {};
  const serialized = JSON.stringify(safeMetadata);
  if (serialized.length > 512) throw unavailablePersistenceError();
  return { type, text: type === "text" ? text : null, safeMetadata, handoffReasonCode };
}

function requiredBoundedText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) throw unavailablePersistenceError();
  return text;
}

function optionalBoundedText(value, label, maxLength) {
  if (value == null) return null;
  return requiredBoundedText(value, label, maxLength);
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) throw unavailablePersistenceError();
  return value;
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw unavailablePersistenceError();
  return date;
}

function unavailablePersistenceError() {
  const error = new Error("Webhook persistence is unavailable.");
  error.status = 503;
  return error;
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
