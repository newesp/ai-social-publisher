import crypto from "node:crypto";

import { and, asc, desc, eq, exists, gt, gte, isNull, lte, or, sql } from "drizzle-orm";

import { getLLMModelOptions } from "../ai/model-config.js";
import { createDbClient } from "../db/index.js";
import {
  platformConnections,
  supportConfigurations,
  supportConversationTransitions,
  supportConversations,
  supportAiDecisions,
  supportFaqs,
  supportMessages,
  supportOutboundDeliveries,
  supportWebhookEvents,
  userSettings,
} from "../db/schema.js";
import { normalizeEmail } from "../auth/policy.js";
import { decryptJson } from "../settings/credential-crypto.js";
import {
  customerLookupKey,
  decryptExternalId,
  decryptOutboundCanonicalBody,
  encryptExternalId,
  encryptOutboundCanonicalBody,
  encryptReplyToken,
} from "./identity-crypto.js";

const PROVIDER_KEY_BY_NAME = Object.freeze({
  google: "googleAiApiKey",
  openai: "openAiApiKey",
});
const DISPATCH_LEASE_MS = 30_000;
const EVENT_PROCESSING_LEASE_MS = 30_000;
const OUTBOUND_DELIVERY_LEASE_MS = 30_000;
const OUTBOUND_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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

    async listInboxConversations(ownerEmail, { status } = {}) {
      const owner = normalizeOwner(ownerEmail);
      const conversations = await db.select().from(supportConversations).where(and(
        eq(supportConversations.ownerEmail, owner),
        ...(status ? [eq(supportConversations.status, status)] : []),
      ));
      const summaries = await Promise.all(conversations.map(async (conversation) => {
        const [lastMessage] = await db.select({ text: supportMessages.textContent }).from(supportMessages)
          .where(eq(supportMessages.conversationId, conversation.id)).orderBy(desc(supportMessages.createdAt)).limit(1);
        const [delivery] = await db.select({ id: supportOutboundDeliveries.id }).from(supportOutboundDeliveries)
          .where(and(eq(supportOutboundDeliveries.conversationId, conversation.id), eq(supportOutboundDeliveries.deliveryStatus, "failed"))).limit(1);
        return {
          id: conversation.id,
          customerLabel: "Customer",
          status: conversation.status,
          unreadCount: conversation.unreadCount,
          handoffReason: conversation.handoffReasonCode,
          lastMessagePreview: lastMessage?.text ?? null,
          deliveryFailed: Boolean(delivery),
          lastInboundAt: conversation.lastInboundAt,
          lastOutboundAt: conversation.lastOutboundAt,
          updatedAt: conversation.updatedAt,
        };
      }));
      return summaries.sort((left, right) => inboxPriority(right) - inboxPriority(left)
        || dateValue(right.lastInboundAt) - dateValue(left.lastInboundAt)
        || dateValue(right.updatedAt) - dateValue(left.updatedAt));
    },

    async countInboxAttention(ownerEmail) {
      const owner = normalizeOwner(ownerEmail);
      const [result] = await db.select({ count: sql`count(*)` }).from(supportConversations).where(and(
        eq(supportConversations.ownerEmail, owner),
        or(eq(supportConversations.status, "waiting_human"), gt(supportConversations.unreadCount, 0)),
      ));
      const count = Number(result?.count ?? 0);
      return Number.isSafeInteger(count) && count > 0 ? count : 0;
    },

    async getInboxConversation(ownerEmail, conversationId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(conversationId, "Conversation ID", 100);
      const [conversation] = await db.select().from(supportConversations).where(and(
        eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner),
      )).limit(1);
      if (!conversation) return null;
      const [messages, decisions, faqs, transition, delivery] = await Promise.all([
        db.select().from(supportMessages).where(eq(supportMessages.conversationId, id)).orderBy(asc(supportMessages.createdAt)),
        db.select().from(supportAiDecisions).where(eq(supportAiDecisions.conversationId, id)).orderBy(desc(supportAiDecisions.createdAt)),
        db.select().from(supportFaqs).where(eq(supportFaqs.ownerEmail, owner)),
        conversation.pendingTransitionId ? db.select().from(supportConversationTransitions).where(and(
          eq(supportConversationTransitions.id, conversation.pendingTransitionId),
          eq(supportConversationTransitions.conversationId, id),
          eq(supportConversationTransitions.requestedByOwnerEmail, owner),
        )).limit(1) : [],
        db.select({ id: supportOutboundDeliveries.id }).from(supportOutboundDeliveries).where(and(
          eq(supportOutboundDeliveries.conversationId, id), eq(supportOutboundDeliveries.deliveryStatus, "failed"),
        )).limit(1),
      ]);
      const usedFaqIds = new Set(decisions.flatMap((decision) => parseKeywords(decision.faqIdsJson)));
      const [lastMessage] = messages.slice(-1);
      return {
        id: conversation.id, customerLabel: "Customer", status: conversation.status, unreadCount: conversation.unreadCount,
        handoffReason: conversation.handoffReasonCode, lastMessagePreview: lastMessage?.textContent ?? null,
        deliveryFailed: Boolean(delivery[0]), lastInboundAt: conversation.lastInboundAt, lastOutboundAt: conversation.lastOutboundAt,
        updatedAt: conversation.updatedAt,
        messages: messages.map((message) => ({
          id: message.id, direction: message.direction, senderType: message.senderType, messageType: message.messageType,
          text: message.textContent, deliveryStatus: message.deliveryStatus, safeErrorCode: message.safeErrorCode,
          createdAt: message.createdAt, sentAt: message.sentAt, failedAt: message.failedAt,
        })),
        decisions: decisions.map((decision) => ({
          id: decision.id, action: decision.action, category: decision.category, reasonCode: decision.reasonCode,
          faqSourceIds: parseKeywords(decision.faqIdsJson), createdAt: decision.createdAt,
        })),
        faqSources: faqs.filter((faq) => usedFaqIds.has(faq.id)).map((faq) => ({ id: faq.id, question: faq.question, category: faq.category })),
        pendingTransition: transition[0] ? { id: transition[0].id, action: transition[0].requestedAction, effectiveAt: transition[0].effectiveAt } : null,
      };
    },

    async markInboxConversationRead(ownerEmail, conversationId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(conversationId, "Conversation ID", 100);
      const [updated] = await retryBusyOperation(() => db.update(supportConversations).set({ unreadCount: 0 }).where(and(
        eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner),
      )).returning({ id: supportConversations.id }));
      return updated ? { id: updated.id, unreadCount: 0 } : null;
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

    async markLineEventProcessed({ connectionId, eventId, claimId, conversationId, conversationClaimId, now = new Date() }) {
      const processing = validateDispatchInput({ connectionId, eventId, claimId, now });
      if ((conversationId == null) !== (conversationClaimId == null)) throw unavailablePersistenceError();
      const conversationPredicate = conversationId == null ? null : exists(db.select({ one: sql`1` }).from(supportConversations).where(and(
        eq(supportConversations.id, requiredBoundedText(conversationId, "Conversation ID", 100)),
        eq(supportConversations.platformConnectionId, processing.connectionId),
        eq(supportConversations.processingClaimId, requiredBoundedText(conversationClaimId, "Conversation claim", 100)),
        eq(supportConversations.status, "ai_active"),
        gt(supportConversations.processingClaimExpiresAt, processing.now),
      )));
      const [updated] = await retryBusyOperation(() => db.update(supportWebhookEvents).set({
        processingStatus: "processed",
        safeErrorCode: null,
        processedAt: processing.now,
      }).where(and(
        eq(supportWebhookEvents.platformConnectionId, processing.connectionId),
        eq(supportWebhookEvents.webhookEventId, processing.eventId),
        eq(supportWebhookEvents.processingStatus, "processing"),
        eq(supportWebhookEvents.safeErrorCode, processing.claimId),
        gt(supportWebhookEvents.processedAt, processing.now),
        ...(conversationPredicate ? [conversationPredicate] : []),
      )).returning({ id: supportWebhookEvents.id }));
      return Boolean(updated);
    },

    async renewLineEventProcessing({ connectionId, eventId, claimId, now = new Date() }) {
      const processing = validateDispatchInput({ connectionId, eventId, claimId, now });
      const [renewed] = await retryBusyOperation(() => db.update(supportWebhookEvents).set({
        processedAt: new Date(processing.now.getTime() + EVENT_PROCESSING_LEASE_MS),
      }).where(and(
        eq(supportWebhookEvents.platformConnectionId, processing.connectionId),
        eq(supportWebhookEvents.webhookEventId, processing.eventId),
        eq(supportWebhookEvents.processingStatus, "processing"),
        eq(supportWebhookEvents.safeErrorCode, processing.claimId),
        gt(supportWebhookEvents.processedAt, processing.now),
      )).returning({ id: supportWebhookEvents.id }));
      return Boolean(renewed);
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

    async acquireConversationClaim({ connectionId, conversationId, now = new Date() }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, now });
      const claimId = randomUUID();
      const [claimed] = await retryBusyOperation(() => db.update(supportConversations).set({
        processingClaimId: claimId,
        processingClaimExpiresAt: new Date(claim.now.getTime() + EVENT_PROCESSING_LEASE_MS),
        updatedAt: claim.now,
      }).where(and(
        eq(supportConversations.id, claim.conversationId),
        eq(supportConversations.platformConnectionId, claim.connectionId),
        eq(supportConversations.status, "ai_active"),
        or(
          isNull(supportConversations.processingClaimId),
          isNull(supportConversations.processingClaimExpiresAt),
          lte(supportConversations.processingClaimExpiresAt, claim.now),
        ),
      )).returning({ id: supportConversations.id }));
      return claimed ? { acquired: true, claimId, windowStart: claim.now } : { acquired: false };
    },

    async renewConversationClaim({ connectionId, conversationId, claimId, now = new Date() }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, claimId, now });
      const [renewed] = await retryBusyOperation(() => db.update(supportConversations).set({
        processingClaimExpiresAt: new Date(claim.now.getTime() + EVENT_PROCESSING_LEASE_MS),
        updatedAt: claim.now,
      }).where(and(
        eq(supportConversations.id, claim.conversationId),
        eq(supportConversations.platformConnectionId, claim.connectionId),
        eq(supportConversations.processingClaimId, claim.claimId),
        eq(supportConversations.status, "ai_active"),
        gt(supportConversations.processingClaimExpiresAt, claim.now),
      )).returning({ id: supportConversations.id }));
      return Boolean(renewed);
    },

    async buildClaimedTurn({ connectionId, eventId, conversationId, claimId, cutoff }) {
      const turn = validateClaimedTurnInput({ connectionId, eventId, conversationId, claimId, cutoff });
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [conversation] = await tx.select({ id: supportConversations.id }).from(supportConversations).where(and(
          eq(supportConversations.id, turn.conversationId),
          eq(supportConversations.platformConnectionId, turn.connectionId),
          eq(supportConversations.processingClaimId, turn.claimId),
          eq(supportConversations.status, "ai_active"),
          gt(supportConversations.processingClaimExpiresAt, turn.cutoff),
        )).limit(1);
        if (!conversation) return null;
        const messages = await tx.select({ id: supportMessages.id }).from(supportMessages)
          .where(and(
            eq(supportMessages.conversationId, turn.conversationId),
            eq(supportMessages.direction, "inbound"),
            eq(supportMessages.senderType, "customer"),
            eq(supportMessages.messageType, "text"),
            isNull(supportMessages.processedAt),
            lte(supportMessages.createdAt, turn.cutoff),
          )).orderBy(asc(supportMessages.createdAt));
        if (!messages.length) return null;
        const [inbound] = await tx.select({ id: supportMessages.id }).from(supportMessages).where(and(
          eq(supportMessages.conversationId, turn.conversationId),
          eq(supportMessages.idempotencyKey, `${turn.connectionId}:${turn.eventId}`),
        )).limit(1);
        if (!inbound || !messages.some((message) => message.id === inbound.id)) return null;
        return { inboundMessageId: inbound.id };
      }));
    },

    async loadCurrentProcessingContext({ connectionId, conversationId, claimId, cutoff, now = new Date() }) {
      const current = validateConversationClaimInput({ connectionId, conversationId, claimId, now });
      const batchCutoff = cutoff == null ? current.now : validDate(cutoff);
      const [conversation] = await db.select().from(supportConversations).where(and(
        eq(supportConversations.id, current.conversationId),
        eq(supportConversations.platformConnectionId, current.connectionId),
        eq(supportConversations.processingClaimId, current.claimId),
      )).limit(1);
      if (!conversation) return null;
      const [[configuration], [storedSettings], [activeConnection], faqs, messages, customerMessages, [turnCount]] = await Promise.all([
        db.select().from(supportConfigurations).where(and(
          eq(supportConfigurations.ownerEmail, conversation.ownerEmail),
          eq(supportConfigurations.platformConnectionId, current.connectionId),
        )).limit(1),
        db.select({ encryptedSettings: userSettings.encryptedSettings }).from(userSettings)
          .where(eq(userSettings.ownerEmail, conversation.ownerEmail)).limit(1),
        db.select({ id: platformConnections.id }).from(platformConnections).where(and(
          eq(platformConnections.id, current.connectionId),
          eq(platformConnections.ownerEmail, conversation.ownerEmail),
          eq(platformConnections.platform, "line"),
          eq(platformConnections.state, "active"),
        )).limit(1),
        db.select().from(supportFaqs).where(and(
          eq(supportFaqs.ownerEmail, conversation.ownerEmail), eq(supportFaqs.enabled, true),
        )).orderBy(desc(supportFaqs.priority), desc(supportFaqs.updatedAt)),
        db.select({ senderType: supportMessages.senderType, text: supportMessages.textContent, createdAt: supportMessages.createdAt })
          .from(supportMessages).where(and(
            eq(supportMessages.conversationId, current.conversationId),
            gte(supportMessages.createdAt, new Date(current.now.getTime() - CONTEXT_RETENTION_MS)),
            lte(supportMessages.createdAt, batchCutoff),
          ))
          .orderBy(desc(supportMessages.createdAt)).limit(20),
        db.select({ text: supportMessages.textContent }).from(supportMessages).where(and(
          eq(supportMessages.conversationId, current.conversationId),
          eq(supportMessages.direction, "inbound"),
          eq(supportMessages.senderType, "customer"),
          eq(supportMessages.messageType, "text"),
          isNull(supportMessages.processedAt),
          lte(supportMessages.createdAt, batchCutoff),
        )).orderBy(asc(supportMessages.createdAt)),
        db.select({ count: sql`count(*)` }).from(supportAiDecisions).where(and(
          eq(supportAiDecisions.conversationId, current.conversationId),
          eq(supportAiDecisions.action, "reply"),
          gte(supportAiDecisions.createdAt, new Date(current.now.getTime() - 5 * 60 * 1_000)),
        )).limit(1),
      ]);
      let settings;
      let recipient;
      try {
        settings = storedSettings ? await decryptSettings(storedSettings.encryptedSettings) : null;
        recipient = decryptExternalId(conversation.encryptedCustomerExternalId, encryptionKey);
      } catch {
        return { supportState: configuration?.supportState ?? "disabled", conversationStatus: conversation.status };
      }
      return {
        supportState: configuration?.supportState ?? "disabled",
        conversationStatus: conversation.status,
        configuration: configuration ?? null,
        configurationReady: Boolean(activeConnection && configuration && hasConfiguredProvider(configuration, settings, modelOptions)),
        settings,
        recipient,
        aiTurnsInLastFiveMinutes: Number(turnCount?.count ?? 0),
        faqs: faqs.map((faq) => ({ ...faq, keywords: parseKeywords(faq.keywordsJson) })),
        customerTexts: customerMessages.map(({ text }) => text),
        messages: messages.reverse().map(({ senderType, text }) => ({ senderType, text })),
      };
    },

    async persistDecisionAndOutbound(input) {
      const decision = validatePersistDecisionInput(input);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [event] = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents).where(and(
          eq(supportWebhookEvents.platformConnectionId, decision.connectionId),
          eq(supportWebhookEvents.webhookEventId, decision.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, decision.eventClaimId),
          gt(supportWebhookEvents.processedAt, decision.now),
        )).limit(1);
        const [conversation] = await tx.select().from(supportConversations).where(and(
          eq(supportConversations.id, decision.conversationId),
          eq(supportConversations.platformConnectionId, decision.connectionId),
          eq(supportConversations.processingClaimId, decision.claimId),
          eq(supportConversations.status, "ai_active"),
          gt(supportConversations.processingClaimExpiresAt, decision.now),
        )).limit(1);
        if (!event || !conversation) throw unavailablePersistenceError();
        const [existing] = await tx.select({ id: supportOutboundDeliveries.id }).from(supportOutboundDeliveries)
          .where(eq(supportOutboundDeliveries.webhookEventId, event.id)).limit(1);
        if (existing) return { deliveryId: existing.id };
        const batchMessages = await selectClaimedBatchMessages(tx, decision);
        const inbound = batchMessages.find(({ id }) => id === decision.inboundMessageId);
        if (!inbound) throw unavailablePersistenceError();
        await tx.update(supportMessages).set({ processedAt: decision.cutoff }).where(and(
          eq(supportMessages.conversationId, decision.conversationId),
          eq(supportMessages.direction, "inbound"),
          eq(supportMessages.senderType, "customer"),
          eq(supportMessages.messageType, "text"),
          isNull(supportMessages.processedAt),
          lte(supportMessages.createdAt, decision.cutoff),
        ));
        await completeDispatchedBatchEvents(tx, decision, batchMessages);
        const answerMessageId = randomUUID();
        await tx.insert(supportMessages).values({
          id: answerMessageId, conversationId: decision.conversationId, direction: "outbound", senderType: "ai",
          messageType: "text", textContent: decision.answer, safeMetadataJson: "{}", providerMessageId: null,
          deliveryStatus: "pending", idempotencyKey: `ai:${decision.connectionId}:${decision.eventId}`,
          sentAt: null, failedAt: null, safeErrorCode: null, processedAt: decision.now, createdAt: decision.now,
        });
        await tx.insert(supportAiDecisions).values({
          id: randomUUID(), conversationId: decision.conversationId, inboundMessageId: inbound.id, action: "reply",
          category: decision.category, reasonCode: null, answerMessageId, faqIdsJson: JSON.stringify(decision.knowledgeSourceIds),
          llmProvider: decision.llmProvider, llmModel: decision.llmModel, promptVersion: "support-v1",
          inputTokens: null, outputTokens: null, latencyMs: null, createdAt: decision.now,
        });
        const [created] = await tx.insert(supportOutboundDeliveries).values({
          id: randomUUID(), webhookEventId: event.id, conversationId: decision.conversationId,
          encryptedRecipient: encryptExternalId(decision.recipient, encryptionKey),
          encryptedCanonicalBody: encryptOutboundCanonicalBody(decision.canonicalBody, encryptionKey), retryKey: randomUUID(),
          deliveryStatus: "pending", deliveryClaimId: null, deliveryClaimExpiresAt: null, attemptCount: 0,
          firstAttemptAt: null, lastAttemptAt: null, nextAttemptAt: null, acceptedRequestId: null, safeErrorCode: null,
          sentAt: null, failedAt: null, humanReviewAt: null, createdAt: decision.now,
        }).returning({ id: supportOutboundDeliveries.id });
        if (!created) throw unavailablePersistenceError();
        await tx.update(supportConversations).set({ lastOutboundAt: decision.now, updatedAt: decision.now })
          .where(eq(supportConversations.id, decision.conversationId));
        return { deliveryId: created.id };
      }));
    },

    async persistHandoff({ connectionId, eventId, eventClaimId, conversationId, claimId, cutoff, reasonCode, now = new Date() }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, claimId, now });
      const primaryEventId = eventId == null ? null : requiredBoundedText(eventId, "Webhook event ID", 256);
      const primaryEventClaimId = eventClaimId == null ? null : requiredBoundedText(eventClaimId, "Event processing claim", 100);
      if ((primaryEventId == null) !== (primaryEventClaimId == null)) throw unavailablePersistenceError();
      const batchCutoff = validDate(cutoff ?? claim.now);
      const handoffReason = requiredBoundedText(reasonCode, "Handoff reason", 100);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [conversation] = await tx.select({ id: supportConversations.id }).from(supportConversations).where(and(
          eq(supportConversations.id, claim.conversationId),
          eq(supportConversations.platformConnectionId, claim.connectionId),
          eq(supportConversations.processingClaimId, claim.claimId),
          eq(supportConversations.status, "ai_active"),
          gt(supportConversations.processingClaimExpiresAt, claim.now),
        )).limit(1);
        if (!conversation) return false;
        let eventCompleted = false;
        if (primaryEventId) {
          const [event] = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents).where(and(
            eq(supportWebhookEvents.platformConnectionId, claim.connectionId),
            eq(supportWebhookEvents.webhookEventId, primaryEventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, primaryEventClaimId),
            gt(supportWebhookEvents.processedAt, claim.now),
          )).limit(1);
          if (!event) return false;
          const batch = { ...claim, eventId: primaryEventId, cutoff: batchCutoff };
          const batchMessages = await selectClaimedBatchMessages(tx, batch);
          await tx.update(supportMessages).set({ processedAt: batchCutoff }).where(and(
            eq(supportMessages.conversationId, claim.conversationId),
            eq(supportMessages.direction, "inbound"),
            eq(supportMessages.senderType, "customer"),
            eq(supportMessages.messageType, "text"),
            isNull(supportMessages.processedAt),
            lte(supportMessages.createdAt, batchCutoff),
          ));
          await completeDispatchedBatchEvents(tx, batch, batchMessages);
          const [completed] = await tx.update(supportWebhookEvents).set({
            processingStatus: "processed", safeErrorCode: null, processedAt: claim.now,
          }).where(and(
            eq(supportWebhookEvents.platformConnectionId, claim.connectionId),
            eq(supportWebhookEvents.webhookEventId, primaryEventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, primaryEventClaimId),
            gt(supportWebhookEvents.processedAt, claim.now),
          )).returning({ id: supportWebhookEvents.id });
          if (!completed) throw unavailablePersistenceError();
          eventCompleted = true;
        }
        const [updated] = await tx.update(supportConversations).set({
          status: "waiting_human", handoffReasonCode: handoffReason,
          processingClaimId: null, processingClaimExpiresAt: null, updatedAt: claim.now,
        }).where(and(
          eq(supportConversations.id, claim.conversationId), eq(supportConversations.platformConnectionId, claim.connectionId),
          eq(supportConversations.processingClaimId, claim.claimId),
          eq(supportConversations.status, "ai_active"),
          gt(supportConversations.processingClaimExpiresAt, claim.now),
        )).returning({ id: supportConversations.id });
        if (!updated) throw unavailablePersistenceError();
        return eventCompleted ? { eventCompleted: true } : true;
      }));
    },

    async releaseConversationClaim({ connectionId, conversationId, claimId }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, claimId, now: new Date() });
      const [released] = await retryBusyOperation(() => db.update(supportConversations).set({
        processingClaimId: null, processingClaimExpiresAt: null,
      }).where(and(
        eq(supportConversations.id, claim.conversationId), eq(supportConversations.platformConnectionId, claim.connectionId),
        eq(supportConversations.processingClaimId, claim.claimId),
      )).returning({ id: supportConversations.id }));
      return Boolean(released);
    },

    async findNextUnprocessedEvent({ connectionId, conversationId }) {
      const input = validateConversationClaimInput({ connectionId, conversationId, now: new Date() });
      const [message] = await db.select({ idempotencyKey: supportMessages.idempotencyKey }).from(supportMessages).where(and(
        eq(supportMessages.conversationId, input.conversationId), eq(supportMessages.direction, "inbound"),
        isNull(supportMessages.processedAt),
        exists(db.select({ one: sql`1` }).from(supportConversations).where(and(
          eq(supportConversations.id, input.conversationId),
          eq(supportConversations.platformConnectionId, input.connectionId),
          eq(supportConversations.status, "ai_active"),
        ))),
      )).orderBy(asc(supportMessages.createdAt)).limit(1);
      const prefix = `${input.connectionId}:`;
      if (!message?.idempotencyKey?.startsWith(prefix)) return null;
      return { connectionId: input.connectionId, conversationId: input.conversationId, eventId: message.idempotencyKey.slice(prefix.length) };
    },

    async resolveLineEventAfterConversationLoss({ connectionId, eventId, conversationId, claimId, now = new Date() }) {
      const input = {
        ...validateConversationClaimInput({ connectionId, conversationId, claimId, now }),
        eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
      };
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [message] = await tx.select({ processedAt: supportMessages.processedAt }).from(supportMessages).where(and(
          eq(supportMessages.conversationId, input.conversationId),
          eq(supportMessages.idempotencyKey, `${input.connectionId}:${input.eventId}`),
        )).limit(1);
        if (!message?.processedAt) return false;
        const [resolved] = await tx.update(supportWebhookEvents).set({
          processingStatus: "processed", safeErrorCode: null, processedAt: input.now,
        }).where(and(
          eq(supportWebhookEvents.platformConnectionId, input.connectionId),
          eq(supportWebhookEvents.webhookEventId, input.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
           eq(supportWebhookEvents.safeErrorCode, input.claimId),
           gt(supportWebhookEvents.processedAt, input.now),
        )).returning({ id: supportWebhookEvents.id });
        return Boolean(resolved);
      }));
    },

    async loadLineAccessToken(connectionId) {
      const id = requiredBoundedText(connectionId, "Connection ID", 100);
      const [connection] = await db.select({ encryptedCredentials: platformConnections.encryptedCredentials }).from(platformConnections)
        .where(and(eq(platformConnections.id, id), eq(platformConnections.platform, "line"), eq(platformConnections.state, "active"))).limit(1);
      try {
        const accessToken = decryptJson(connection?.encryptedCredentials, encryptionKey)?.accessToken;
        return requiredBoundedText(accessToken, "LINE access token", 10_000);
      } catch {
        throw unavailablePersistenceError();
      }
    },

    async markLineConnectionNeedsReconnect(connectionId, now = new Date()) {
      const id = requiredBoundedText(connectionId, "Connection ID", 100);
      const [updated] = await retryBusyOperation(() => db.update(platformConnections).set({
        state: "needs_reconnect", updatedAt: validDate(now),
      }).where(and(
        eq(platformConnections.id, id), eq(platformConnections.platform, "line"), eq(platformConnections.state, "active"),
      )).returning({ id: platformConnections.id }));
      return Boolean(updated);
    },

    async handleLineCredentialRejected({ connectionId, conversationId, eventId, eventClaimId, claimId, now = new Date() }) {
      const input = {
        ...validateConversationClaimInput({ connectionId, conversationId, claimId, now }),
        eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
        eventClaimId: requiredBoundedText(eventClaimId, "Event processing claim", 100),
      };
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const eventPredicate = exists(tx.select({ one: sql`1` }).from(supportWebhookEvents).where(and(
          eq(supportWebhookEvents.platformConnectionId, input.connectionId),
          eq(supportWebhookEvents.webhookEventId, input.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, input.eventClaimId),
          gt(supportWebhookEvents.processedAt, input.now),
        )));
        await tx.update(platformConnections).set({ state: "needs_reconnect", updatedAt: input.now }).where(and(
          eq(platformConnections.id, input.connectionId), eq(platformConnections.platform, "line"), eq(platformConnections.state, "active"),
          exists(tx.select({ one: sql`1` }).from(supportConversations).where(and(
            eq(supportConversations.id, input.conversationId),
            eq(supportConversations.platformConnectionId, input.connectionId),
            eq(supportConversations.processingClaimId, input.claimId),
            eq(supportConversations.status, "ai_active"),
            gt(supportConversations.processingClaimExpiresAt, input.now),
          ))),
          eventPredicate,
        ));
        const [handoff] = await tx.update(supportConversations).set({
          status: "waiting_human", handoffReasonCode: "credential_rejected",
          processingClaimId: null, processingClaimExpiresAt: null, updatedAt: input.now,
        }).where(and(
          eq(supportConversations.id, input.conversationId), eq(supportConversations.platformConnectionId, input.connectionId),
          eq(supportConversations.status, "ai_active"),
          eq(supportConversations.processingClaimId, input.claimId),
          gt(supportConversations.processingClaimExpiresAt, input.now),
          eventPredicate,
        )).returning({ id: supportConversations.id });
        if (!handoff) return false;
        const [completed] = await tx.update(supportWebhookEvents).set({
          processingStatus: "processed", safeErrorCode: null, processedAt: input.now,
        }).where(and(
          eq(supportWebhookEvents.platformConnectionId, input.connectionId),
          eq(supportWebhookEvents.webhookEventId, input.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, input.eventClaimId),
          gt(supportWebhookEvents.processedAt, input.now),
        )).returning({ id: supportWebhookEvents.id });
        if (!completed) throw unavailablePersistenceError();
        return { eventCompleted: true };
      }));
    },

    async createLineOutboundDelivery(input) {
      const delivery = validateOutboundDeliveryInput(input);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [event] = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents).where(and(
          eq(supportWebhookEvents.platformConnectionId, delivery.connectionId),
          eq(supportWebhookEvents.webhookEventId, delivery.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, delivery.claimId),
        )).limit(1);
        if (!event) throw unavailablePersistenceError();
        const [inboundMessage] = await tx.select({ id: supportMessages.id }).from(supportMessages).where(and(
          eq(supportMessages.conversationId, delivery.conversationId),
          eq(supportMessages.idempotencyKey, `${delivery.connectionId}:${delivery.eventId}`),
        )).limit(1);
        if (!inboundMessage) throw unavailablePersistenceError();

        const retryKey = randomUUID();
        const deliveryId = randomUUID();
        const [created] = await tx.insert(supportOutboundDeliveries).values({
          id: deliveryId,
          webhookEventId: event.id,
          conversationId: delivery.conversationId,
          encryptedRecipient: encryptExternalId(delivery.recipient, encryptionKey),
          encryptedCanonicalBody: encryptOutboundCanonicalBody(delivery.canonicalBody, encryptionKey),
          retryKey,
          deliveryStatus: "pending",
          deliveryClaimId: null,
          deliveryClaimExpiresAt: null,
          attemptCount: 0,
          firstAttemptAt: null,
          lastAttemptAt: null,
          nextAttemptAt: null,
          acceptedRequestId: null,
          safeErrorCode: null,
          sentAt: null,
          failedAt: null,
          humanReviewAt: null,
          createdAt: delivery.now,
        }).onConflictDoNothing({
          target: supportOutboundDeliveries.webhookEventId,
        }).returning({
          id: supportOutboundDeliveries.id,
          retryKey: supportOutboundDeliveries.retryKey,
        });
        if (created) return { created: true, deliveryId: created.id, retryKey: created.retryKey };

        const [existing] = await tx.select({
          id: supportOutboundDeliveries.id,
          retryKey: supportOutboundDeliveries.retryKey,
        }).from(supportOutboundDeliveries).where(eq(supportOutboundDeliveries.webhookEventId, event.id)).limit(1);
        if (!existing) throw unavailablePersistenceError();
        return { created: false, deliveryId: existing.id, retryKey: existing.retryKey };
      }));
    },

    async claimLineOutboundDelivery({ deliveryId, now = new Date() }) {
      const delivery = { deliveryId: requiredBoundedText(deliveryId, "Outbound delivery ID", 100), now: validDate(now) };
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [existing] = await tx.select().from(supportOutboundDeliveries)
          .where(eq(supportOutboundDeliveries.id, delivery.deliveryId)).limit(1);
        if (!existing) return { claimed: false, status: "duplicate" };
        if (["sent", "failed", "human_review"].includes(existing.deliveryStatus)) {
          return { claimed: false, status: existing.deliveryStatus };
        }
        if (existing.firstAttemptAt
          && delivery.now.getTime() - existing.firstAttemptAt.getTime() > OUTBOUND_REVIEW_WINDOW_MS) {
          await tx.update(supportOutboundDeliveries).set({
            deliveryStatus: "human_review",
            deliveryClaimId: null,
            deliveryClaimExpiresAt: null,
            nextAttemptAt: null,
            humanReviewAt: delivery.now,
            safeErrorCode: "line_push_review_required",
          }).where(and(
            eq(supportOutboundDeliveries.id, delivery.deliveryId),
            or(
              eq(supportOutboundDeliveries.deliveryStatus, "pending"),
              eq(supportOutboundDeliveries.deliveryStatus, "retryable"),
              eq(supportOutboundDeliveries.deliveryStatus, "sending"),
            ),
          ));
          return { claimed: false, status: "human_review" };
        }
        if (existing.nextAttemptAt && existing.nextAttemptAt > delivery.now) {
          return { claimed: false, status: "retryable" };
        }
        const claimId = randomUUID();
        const [claimed] = await tx.update(supportOutboundDeliveries).set({
          deliveryStatus: "sending",
          deliveryClaimId: claimId,
          deliveryClaimExpiresAt: new Date(delivery.now.getTime() + OUTBOUND_DELIVERY_LEASE_MS),
          attemptCount: existing.attemptCount + 1,
          firstAttemptAt: existing.firstAttemptAt ?? delivery.now,
          lastAttemptAt: delivery.now,
          nextAttemptAt: null,
          safeErrorCode: null,
        }).where(and(
          eq(supportOutboundDeliveries.id, delivery.deliveryId),
          or(
            eq(supportOutboundDeliveries.deliveryStatus, "pending"),
            and(
              eq(supportOutboundDeliveries.deliveryStatus, "retryable"),
              or(
                isNull(supportOutboundDeliveries.nextAttemptAt),
                lte(supportOutboundDeliveries.nextAttemptAt, delivery.now),
              ),
            ),
            and(
              eq(supportOutboundDeliveries.deliveryStatus, "sending"),
              lte(supportOutboundDeliveries.deliveryClaimExpiresAt, delivery.now),
            ),
          ),
        )).returning();
        if (!claimed) return { claimed: false, status: "duplicate" };
        return {
          claimed: true,
          claimId,
          retryKey: claimed.retryKey,
          canonicalBody: decryptOutboundCanonicalBody(claimed.encryptedCanonicalBody, encryptionKey),
          connectionId: (await tx.select({ connectionId: supportConversations.platformConnectionId }).from(supportConversations)
            .where(eq(supportConversations.id, claimed.conversationId)).limit(1))[0]?.connectionId,
          conversationId: claimed.conversationId,
          attemptCount: claimed.attemptCount,
        };
      }));
    },

    async markLineOutboundDeliverySent({ deliveryId, claimId, acceptedRequestId = null, now = new Date() }) {
      return updateOutboundDelivery(db, {
        deliveryId, claimId, now, status: "sent", acceptedRequestId,
        changes: { sentAt: validDate(now), safeErrorCode: null, nextAttemptAt: null },
      });
    },

    async markLineOutboundDeliveryRetryable({ deliveryId, claimId, retryAt, safeErrorCode, now = new Date() }) {
      return updateOutboundDelivery(db, {
        deliveryId, claimId, now, status: "retryable",
        changes: {
          nextAttemptAt: validDate(retryAt),
          safeErrorCode: safeOutboundErrorCode(safeErrorCode),
        },
      });
    },

    async markLineOutboundDeliveryFailed({ deliveryId, claimId, safeErrorCode, now = new Date() }) {
      return updateOutboundDelivery(db, {
        deliveryId, claimId, now, status: "failed",
        changes: { failedAt: validDate(now), safeErrorCode: safeOutboundErrorCode(safeErrorCode), nextAttemptAt: null },
      });
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

async function updateOutboundDelivery(db, {
  deliveryId,
  claimId,
  now,
  status,
  acceptedRequestId = undefined,
  changes,
}) {
  validDate(now);
  const safeDeliveryId = requiredBoundedText(deliveryId, "Outbound delivery ID", 100);
  const safeClaimId = requiredBoundedText(claimId, "Outbound delivery claim", 100);
  const [updated] = await retryBusyOperation(() => db.update(supportOutboundDeliveries).set({
    deliveryStatus: status,
    deliveryClaimId: null,
    deliveryClaimExpiresAt: null,
    ...(acceptedRequestId === undefined ? {} : {
      acceptedRequestId: acceptedRequestId == null ? null : requiredBoundedText(
        acceptedRequestId,
        "LINE accepted request ID",
        256,
      ),
    }),
    ...changes,
  }).where(and(
    eq(supportOutboundDeliveries.id, safeDeliveryId),
    eq(supportOutboundDeliveries.deliveryStatus, "sending"),
    eq(supportOutboundDeliveries.deliveryClaimId, safeClaimId),
  )).returning({ id: supportOutboundDeliveries.id }));
  return Boolean(updated);
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

function validateOutboundDeliveryInput({
  connectionId,
  eventId,
  conversationId,
  claimId,
  recipient,
  canonicalBody,
  now,
} = {}) {
  const safeRecipient = requiredBoundedText(recipient, "LINE recipient", 256);
  const safeCanonicalBody = boundedText(canonicalBody, "LINE canonical body", 20_000);
  let payload;
  try {
    payload = JSON.parse(safeCanonicalBody);
  } catch {
    throw unavailablePersistenceError();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.to !== safeRecipient || !Array.isArray(payload.messages) || payload.messages.length < 1) {
    throw unavailablePersistenceError();
  }
  return {
    connectionId: requiredBoundedText(connectionId, "Connection ID", 100),
    eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
    conversationId: requiredBoundedText(conversationId, "Conversation ID", 100),
    claimId: requiredBoundedText(claimId, "Dispatch claim", 100),
    recipient: safeRecipient,
    canonicalBody: safeCanonicalBody,
    now: validDate(now),
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

function validateConversationClaimInput({ connectionId, conversationId, claimId, now }) {
  return {
    connectionId: requiredBoundedText(connectionId, "Connection ID", 100),
    conversationId: requiredBoundedText(conversationId, "Conversation ID", 100),
    ...(claimId == null ? {} : { claimId: requiredBoundedText(claimId, "Conversation claim", 100) }),
    now: validDate(now),
  };
}

async function selectClaimedBatchMessages(tx, { connectionId, conversationId, cutoff }) {
  return tx.select({
    id: supportMessages.id,
    idempotencyKey: supportMessages.idempotencyKey,
  }).from(supportMessages).where(and(
    eq(supportMessages.conversationId, conversationId),
    eq(supportMessages.direction, "inbound"),
    eq(supportMessages.senderType, "customer"),
    eq(supportMessages.messageType, "text"),
    isNull(supportMessages.processedAt),
    lte(supportMessages.createdAt, cutoff),
  )).orderBy(asc(supportMessages.createdAt));
}

async function completeDispatchedBatchEvents(tx, { connectionId, eventId, cutoff }, messages) {
  const prefix = `${connectionId}:`;
  const companionEventIds = [...new Set(messages.map(({ idempotencyKey }) => (
    idempotencyKey?.startsWith(prefix) ? idempotencyKey.slice(prefix.length) : null
  )).filter((candidate) => candidate && candidate !== eventId))];
  for (const companionEventId of companionEventIds) {
    await tx.update(supportWebhookEvents).set({
      processingStatus: "processed",
      safeErrorCode: null,
      processedAt: cutoff,
    }).where(and(
      eq(supportWebhookEvents.platformConnectionId, connectionId),
      eq(supportWebhookEvents.webhookEventId, companionEventId),
      eq(supportWebhookEvents.sourceType, "user"),
      eq(supportWebhookEvents.processingStatus, "dispatched"),
    ));
  }
}

function validateClaimedTurnInput({ connectionId, eventId, conversationId, claimId, cutoff }) {
  return {
    ...validateConversationClaimInput({ connectionId, conversationId, claimId, now: cutoff }),
    eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
    cutoff: validDate(cutoff),
  };
}

function validatePersistDecisionInput(input = {}) {
  const claim = {
    ...validateConversationClaimInput({
      connectionId: input.connectionId,
      conversationId: input.conversationId,
      claimId: input.claimId,
      now: input.now,
    }),
    eventId: requiredBoundedText(input.eventId, "Webhook event ID", 256),
    eventClaimId: requiredBoundedText(input.eventClaimId, "Event processing claim", 100),
  };
  const answer = requiredBoundedText(input?.decision?.answer, "AI answer", 2_000);
  const category = input?.decision?.category == null ? null : requiredBoundedText(input.decision.category, "AI category", 80);
  const knowledgeSourceIds = Array.isArray(input?.decision?.knowledgeSourceIds)
    ? [...new Set(input.decision.knowledgeSourceIds.map((id) => requiredBoundedText(id, "FAQ ID", 100)))]
    : [];
  if (!knowledgeSourceIds.length) throw unavailablePersistenceError();
  const canonicalBody = boundedText(input?.canonicalBody, "LINE canonical body", 20_000);
  let payload;
  try { payload = JSON.parse(canonicalBody); } catch { throw unavailablePersistenceError(); }
  const recipient = requiredBoundedText(payload?.to, "LINE recipient", 256);
  if (!Array.isArray(payload?.messages) || payload.messages.length !== 1 || payload.messages[0]?.type !== "text"
    || payload.messages[0]?.text !== answer) throw unavailablePersistenceError();
  return {
    ...claim,
    inboundMessageId: requiredBoundedText(input.inboundMessageId, "Inbound message ID", 100),
    answer,
    category,
    knowledgeSourceIds,
    canonicalBody,
    recipient,
    llmProvider: input?.decision?.llmProvider ?? null,
    llmModel: input?.decision?.llmModel ?? null,
    cutoff: validDate(input.cutoff),
    now: validDate(input.now),
  };
}

function parseKeywords(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((keyword) => typeof keyword === "string") : [];
  } catch {
    return [];
  }
}

function inboxPriority(conversation) {
  return (conversation.status === "waiting_human" ? 4 : 0)
    + (conversation.unreadCount > 0 ? 2 : 0)
    + (conversation.deliveryFailed ? 1 : 0);
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
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

function safeOutboundErrorCode(value) {
  return requiredBoundedText(value, "Outbound delivery error code", 100);
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
