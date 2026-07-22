import crypto from "node:crypto";

import { and, asc, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

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
  decryptCustomerDisplayName,
  decryptExternalId,
  encryptCustomerDisplayName,
  decryptOutboundCanonicalBody,
  encryptExternalId,
  encryptOutboundCanonicalBody,
  encryptReplyToken,
} from "./identity-crypto.js";
import {
  buildHandoffAcknowledgementBody,
  HANDOFF_ACKNOWLEDGEMENT_TEXT,
} from "./handoff-acknowledgement.js";

const PROVIDER_KEY_BY_NAME = Object.freeze({
  google: "googleAiApiKey",
  openai: "openAiApiKey",
});
const DISPATCH_LEASE_MS = 30_000;
const EVENT_PROCESSING_LEASE_MS = 30_000;
const OUTBOUND_DELIVERY_LEASE_MS = 30_000;
const OUTBOUND_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CASE_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1_000;
const INBOX_QUERY_LIMIT = 31;
const INBOX_MESSAGE_LIMIT = 100;
const INBOX_DECISION_LIMIT = 50;
const INBOX_FAQ_SOURCE_LIMIT = INBOX_DECISION_LIMIT * 5;
const ACTIVE_PENDING_TRANSITION_LIMIT = 100;
const MAX_CLAIMED_BATCH_MESSAGES = 25;
const AUTOMATED_DELIVERY_STATUSES = Object.freeze(["pending", "retryable"]);

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
        const accessToken = typeof credentials?.accessToken === "string" ? credentials.accessToken : "";
        return channelSecret ? { id: record.id, ownerEmail: record.ownerEmail, channelSecret, accessToken } : null;
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

        let [existing] = await tx.select().from(supportConversations).where(and(
          eq(supportConversations.platformConnectionId, event.connectionId),
          eq(supportConversations.customerLookupKey, event.customerLookupKey),
          ne(supportConversations.status, "resolved"),
        )).orderBy(desc(supportConversations.updatedAt), desc(supportConversations.id)).limit(1);
        let conversation;
        let processWithAi;
        if (existing && conversationIsInactive(existing, event.receivedAt)) {
          if (existing.pendingTransitionId) {
            await tx.update(supportConversationTransitions).set({ cancelledAt: event.receivedAt }).where(and(
              eq(supportConversationTransitions.id, existing.pendingTransitionId),
              eq(supportConversationTransitions.conversationId, existing.id),
              isNull(supportConversationTransitions.cancelledAt),
              isNull(supportConversationTransitions.committedAt),
            ));
          }
          await tx.update(supportConversations).set({
            status: "resolved",
            handoffReasonCode: null,
            pendingTransitionId: null,
            pendingAction: null,
            pendingActionEffectiveAt: null,
            version: existing.version + 1,
            updatedAt: event.receivedAt,
          }).where(and(
            eq(supportConversations.id, existing.id),
            ne(supportConversations.status, "resolved"),
          ));
          existing = null;
        }
        if (existing) {
          let cancelledTransition = null;
          if (existing.pendingTransitionId) {
            [cancelledTransition] = await tx.update(supportConversationTransitions).set({ cancelledAt: event.receivedAt }).where(and(
              eq(supportConversationTransitions.id, existing.pendingTransitionId),
              eq(supportConversationTransitions.conversationId, existing.id),
              isNull(supportConversationTransitions.cancelledAt),
              isNull(supportConversationTransitions.committedAt),
            )).returning({ fromStatus: supportConversationTransitions.fromStatus });
          }
          const restoredStatus = cancelledTransition?.fromStatus ?? existing.status;
          const nextStatus = restoredStatus === "human_active"
            ? "human_active"
            : restoredStatus === "resolved" ? "ai_active" : restoredStatus;
          processWithAi = nextStatus === "ai_active";
          [conversation] = await tx.update(supportConversations).set({
            ...(event.encryptedCustomerDisplayName ? { encryptedCustomerDisplayName: event.encryptedCustomerDisplayName } : {}),
            status: nextStatus,
            handoffReasonCode: nextStatus === "waiting_human" ? existing.handoffReasonCode : null,
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
          processWithAi = true;
          [conversation] = await tx.insert(supportConversations).values({
            id: randomUUID(),
            ownerEmail: event.ownerEmail,
            platformConnectionId: event.connectionId,
            platform: "line",
            customerLookupKey: event.customerLookupKey,
            encryptedCustomerExternalId: event.encryptedCustomerExternalId,
            encryptedCustomerDisplayName: event.encryptedCustomerDisplayName,
            status: "ai_active",
            handoffReasonCode: null,
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
          processedAt: processWithAi ? null : event.receivedAt,
          createdAt: event.receivedAt,
        });
        if (!processWithAi) {
          await tx.update(supportWebhookEvents).set({
            processingStatus: "processed",
            encryptedReplyToken: null,
            replyTokenExpiresAt: null,
            processedAt: event.receivedAt,
          }).where(eq(supportWebhookEvents.id, claimed.id));
        }
        return { inserted: true, eventId: event.eventId, conversationId: conversation.id };
      }));
    },

    async listInboxConversations(ownerEmail, { status, cursor } = {}) {
      const owner = normalizeOwner(ownerEmail);
      const deliveryFailed = exists(
        db.select({ id: supportOutboundDeliveries.id })
          .from(supportOutboundDeliveries)
          .where(and(
            eq(supportOutboundDeliveries.conversationId, supportConversations.id),
            eq(supportOutboundDeliveries.deliveryStatus, "failed"),
          )),
      );
      const pageCursor = normalizeInboxQueryCursor(cursor);
      const keyset = pageCursor ? or(
        lt(supportConversations.updatedAt, new Date(pageCursor.updatedAt)),
        and(
          eq(supportConversations.updatedAt, new Date(pageCursor.updatedAt)),
          lt(supportConversations.id, pageCursor.id),
        ),
      ) : undefined;
      const records = await db.select({
        id: supportConversations.id,
        encryptedCustomerDisplayName: supportConversations.encryptedCustomerDisplayName,
        status: supportConversations.status,
        unreadCount: supportConversations.unreadCount,
        handoffReason: supportConversations.handoffReasonCode,
        lastMessagePreview: sql`(
          SELECT ${supportMessages.textContent}
          FROM ${supportMessages}
          WHERE ${supportMessages.conversationId} = ${supportConversations.id}
          ORDER BY ${supportMessages.createdAt} DESC, ${supportMessages.id} DESC
          LIMIT 1
        )`,
        deliveryFailed,
        lastInboundAt: supportConversations.lastInboundAt,
        lastOutboundAt: supportConversations.lastOutboundAt,
        updatedAt: supportConversations.updatedAt,
        transitionId: supportConversationTransitions.id,
        transitionAction: supportConversationTransitions.requestedAction,
        transitionEffectiveAt: supportConversationTransitions.effectiveAt,
      }).from(supportConversations).leftJoin(supportConversationTransitions, and(
        eq(supportConversationTransitions.id, supportConversations.pendingTransitionId),
        eq(supportConversationTransitions.conversationId, supportConversations.id),
        eq(supportConversationTransitions.requestedByOwnerEmail, owner),
        isNull(supportConversationTransitions.cancelledAt),
        isNull(supportConversationTransitions.committedAt),
      )).where(and(
        eq(supportConversations.ownerEmail, owner),
        ...(status ? [eq(supportConversations.status, status)] : []),
        ...(keyset ? [keyset] : []),
      )).orderBy(
        desc(supportConversations.updatedAt),
        desc(supportConversations.id),
      ).limit(INBOX_QUERY_LIMIT);
      return records.map((record) => ({
        id: record.id,
        customerLabel: customerLabel(record.encryptedCustomerDisplayName, encryptionKey),
        status: record.status,
        unreadCount: record.unreadCount,
        handoffReason: record.handoffReason,
        lastMessagePreview: record.lastMessagePreview ?? null,
        deliveryFailed: Boolean(record.deliveryFailed),
        lastInboundAt: record.lastInboundAt,
        lastOutboundAt: record.lastOutboundAt,
        updatedAt: record.updatedAt,
        pendingTransition: record.transitionId ? {
          id: record.transitionId,
          action: record.transitionAction,
          effectiveAt: record.transitionEffectiveAt,
        } : null,
      }));
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

    async listActivePendingSupportTransitions(ownerEmail) {
      const owner = normalizeOwner(ownerEmail);
      await commitDueTransitionsInternal(db, owner);
      const transitions = await db.select({ id: supportConversationTransitions.id, conversationId: supportConversationTransitions.conversationId, action: supportConversationTransitions.requestedAction, effectiveAt: supportConversationTransitions.effectiveAt, encryptedCustomerDisplayName: supportConversations.encryptedCustomerDisplayName }).from(supportConversationTransitions).innerJoin(supportConversations, and(eq(supportConversations.pendingTransitionId, supportConversationTransitions.id), eq(supportConversations.id, supportConversationTransitions.conversationId))).where(and(
        eq(supportConversations.ownerEmail, owner),
        or(eq(supportConversations.status, "return_to_ai_pending"), eq(supportConversations.status, "resolve_pending")),
        eq(supportConversationTransitions.requestedByOwnerEmail, owner), isNull(supportConversationTransitions.cancelledAt), isNull(supportConversationTransitions.committedAt),
      )).orderBy(asc(supportConversationTransitions.effectiveAt), asc(supportConversationTransitions.id)).limit(ACTIVE_PENDING_TRANSITION_LIMIT + 1);
      return { transitions: transitions.slice(0, ACTIVE_PENDING_TRANSITION_LIMIT).map((transition) => ({ ...transition, customerLabel: customerLabel(transition.encryptedCustomerDisplayName, encryptionKey) })), batchLimitExceeded: transitions.length > ACTIVE_PENDING_TRANSITION_LIMIT };
    },

    async clearExpiredSupportContent({ contentBefore, replyTokenBefore, batchSize }) {
      const contentCutoff = validDate(contentBefore);
      const replyTokenCutoff = validDate(replyTokenBefore);
      const limit = validRetentionBatchSize(batchSize);
      return db.transaction(async (tx) => {
        const messages = await tx.select({ id: supportMessages.id }).from(supportMessages).where(and(
          lt(supportMessages.createdAt, contentCutoff),
          isNotNull(supportMessages.textContent),
        )).orderBy(asc(supportMessages.createdAt), asc(supportMessages.id)).limit(limit);
        const events = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents).where(and(
          lte(supportWebhookEvents.replyTokenExpiresAt, replyTokenCutoff),
          isNotNull(supportWebhookEvents.encryptedReplyToken),
        )).orderBy(asc(supportWebhookEvents.replyTokenExpiresAt), asc(supportWebhookEvents.id)).limit(limit);
        const outboundBatches = await Promise.all(["sent", "failed", "human_review"].map((deliveryStatus) => (
          tx.select({ id: supportOutboundDeliveries.id, createdAt: supportOutboundDeliveries.createdAt })
            .from(supportOutboundDeliveries).where(and(
              lt(supportOutboundDeliveries.createdAt, contentCutoff),
              eq(supportOutboundDeliveries.deliveryStatus, deliveryStatus),
              ne(supportOutboundDeliveries.encryptedCanonicalBody, ""),
            )).orderBy(asc(supportOutboundDeliveries.createdAt), asc(supportOutboundDeliveries.id)).limit(limit)
        )));
        const outboundBodies = outboundBatches.flat().sort((left, right) => (
          dateValue(left.createdAt) - dateValue(right.createdAt) || left.id.localeCompare(right.id)
        )).slice(0, limit);
        if (messages.length) {
          await tx.update(supportMessages).set({ textContent: null }).where(inArray(
            supportMessages.id,
            messages.map(({ id }) => id),
          ));
        }
        if (events.length) {
          await tx.update(supportWebhookEvents).set({
            encryptedReplyToken: null,
            replyTokenExpiresAt: null,
          }).where(inArray(
            supportWebhookEvents.id,
            events.map(({ id }) => id),
          ));
        }
        if (outboundBodies.length) {
          await tx.update(supportOutboundDeliveries).set({ encryptedCanonicalBody: "" }).where(inArray(
            supportOutboundDeliveries.id,
            outboundBodies.map(({ id }) => id),
          ));
        }
        return {
          messagesCleared: messages.length,
          replyTokensCleared: events.length,
          outboundBodiesCleared: outboundBodies.length,
        };
      });
    },

    async getInboxConversation(ownerEmail, conversationId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(conversationId, "Conversation ID", 100);
      await commitDueTransitionsInternal(db, owner);
      const [conversation] = await db.select({
        id: supportConversations.id,
        encryptedCustomerDisplayName: supportConversations.encryptedCustomerDisplayName,
        status: supportConversations.status,
        unreadCount: supportConversations.unreadCount,
        version: supportConversations.version,
        handoffReasonCode: supportConversations.handoffReasonCode,
        pendingTransitionId: supportConversations.pendingTransitionId,
        lastInboundAt: supportConversations.lastInboundAt,
        lastOutboundAt: supportConversations.lastOutboundAt,
        updatedAt: supportConversations.updatedAt,
      }).from(supportConversations).where(and(
        eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner),
      )).limit(1);
      if (!conversation) return null;
      const [messages, decisions, transition, delivery] = await Promise.all([
        db.select({
          id: supportMessages.id,
          direction: supportMessages.direction,
          senderType: supportMessages.senderType,
          messageType: supportMessages.messageType,
          textContent: supportMessages.textContent,
          deliveryStatus: supportMessages.deliveryStatus,
          safeErrorCode: supportMessages.safeErrorCode,
          createdAt: supportMessages.createdAt,
          sentAt: supportMessages.sentAt,
          failedAt: supportMessages.failedAt,
        }).from(supportMessages).where(eq(supportMessages.conversationId, id))
          .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
          .limit(INBOX_MESSAGE_LIMIT),
        db.select({
          id: supportAiDecisions.id,
          action: supportAiDecisions.action,
          category: supportAiDecisions.category,
          reasonCode: supportAiDecisions.reasonCode,
          faqIdsJson: supportAiDecisions.faqIdsJson,
          conversationDisposition: supportAiDecisions.conversationDisposition,
          handoffSummary: supportAiDecisions.handoffSummary,
          humanChecklistJson: supportAiDecisions.humanChecklistJson,
          prohibitedCommitmentsJson: supportAiDecisions.prohibitedCommitmentsJson,
          createdAt: supportAiDecisions.createdAt,
        }).from(supportAiDecisions).where(eq(supportAiDecisions.conversationId, id))
          .orderBy(desc(supportAiDecisions.createdAt), desc(supportAiDecisions.id))
          .limit(INBOX_DECISION_LIMIT),
        conversation.pendingTransitionId ? db.select({
          id: supportConversationTransitions.id,
          requestedAction: supportConversationTransitions.requestedAction,
          effectiveAt: supportConversationTransitions.effectiveAt,
        }).from(supportConversationTransitions).where(and(
          eq(supportConversationTransitions.id, conversation.pendingTransitionId),
          eq(supportConversationTransitions.conversationId, id),
          eq(supportConversationTransitions.requestedByOwnerEmail, owner),
          isNull(supportConversationTransitions.cancelledAt),
          isNull(supportConversationTransitions.committedAt),
        )).limit(1) : [],
        db.select({ id: supportOutboundDeliveries.id }).from(supportOutboundDeliveries).where(and(
          eq(supportOutboundDeliveries.conversationId, id), eq(supportOutboundDeliveries.deliveryStatus, "failed"),
        )).limit(1),
      ]);
      const usedFaqIds = [...new Set(
        decisions.flatMap((decision) => parseKeywords(decision.faqIdsJson)),
      )].slice(0, INBOX_FAQ_SOURCE_LIMIT);
      const faqs = usedFaqIds.length ? await db.select({
        id: supportFaqs.id,
        question: supportFaqs.question,
        category: supportFaqs.category,
      }).from(supportFaqs).where(and(
        eq(supportFaqs.ownerEmail, owner),
        inArray(supportFaqs.id, usedFaqIds),
      )).limit(INBOX_FAQ_SOURCE_LIMIT) : [];
      messages.reverse();
      const [lastMessage] = messages.slice(-1);
      return {
        id: conversation.id, customerLabel: customerLabel(conversation.encryptedCustomerDisplayName, encryptionKey), status: conversation.status, unreadCount: conversation.unreadCount,
        version: conversation.version,
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
          faqSourceIds: parseKeywords(decision.faqIdsJson),
          conversationDisposition: decision.conversationDisposition,
          handoffSummary: decision.handoffSummary,
          humanChecklist: parseKeywords(decision.humanChecklistJson),
          prohibitedCommitments: parseKeywords(decision.prohibitedCommitmentsJson),
          createdAt: decision.createdAt,
        })),
        faqSources: faqs.map((faq) => ({ id: faq.id, question: faq.question, category: faq.category })),
        pendingTransition: transition[0] ? { id: transition[0].id, action: transition[0].requestedAction, effectiveAt: transition[0].effectiveAt } : null,
      };
    },

    async deleteSupportConversation(ownerEmail, conversationId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(conversationId, "Conversation ID", 100);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [conversation] = await tx.select({ id: supportConversations.id }).from(supportConversations).where(and(
          eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner),
        )).limit(1);
        if (!conversation) return false;

        await tx.update(supportConversations).set({
          pendingTransitionId: null,
          aiClosureConfirmationMessageId: null,
        }).where(and(
          eq(supportConversations.id, id),
          eq(supportConversations.ownerEmail, owner),
        ));
        await tx.delete(supportAiDecisions).where(eq(supportAiDecisions.conversationId, id));
        await tx.delete(supportConversationTransitions).where(eq(supportConversationTransitions.conversationId, id));
        await tx.delete(supportOutboundDeliveries).where(eq(supportOutboundDeliveries.conversationId, id));
        await tx.delete(supportMessages).where(eq(supportMessages.conversationId, id));
        await tx.delete(supportConversations).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner)));

        return true;
      }));
    },

    async markInboxConversationRead(ownerEmail, conversationId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(conversationId, "Conversation ID", 100);
      const [updated] = await retryBusyOperation(() => db.update(supportConversations).set({ unreadCount: 0 }).where(and(
        eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner),
      )).returning({ id: supportConversations.id }));
      return updated ? { id: updated.id, unreadCount: 0 } : null;
    },

    async takeOverSupportConversation(ownerEmail, conversationId, expectedVersion, now = new Date()) {
      const owner = normalizeOwner(ownerEmail); const id = requiredBoundedText(conversationId, "Conversation ID", 100); const timestamp = validDate(now);
      const [updated] = await retryBusyOperation(() => db.transaction(async (tx) => {
        const [current] = await tx.select().from(supportConversations).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner))).limit(1);
        if (!current || current.version !== expectedVersion) return [];
        const [sending] = await tx.select({ id: supportOutboundDeliveries.id }).from(supportOutboundDeliveries).where(and(eq(supportOutboundDeliveries.conversationId, id), eq(supportOutboundDeliveries.deliveryStatus, "sending"), gt(supportOutboundDeliveries.deliveryClaimExpiresAt, timestamp))).limit(1);
        if (sending) return [];
        await terminalizeAutomatedDeliveries(tx, id, timestamp);
        if (current.pendingTransitionId) await tx.update(supportConversationTransitions).set({ cancelledAt: timestamp }).where(and(eq(supportConversationTransitions.id, current.pendingTransitionId), isNull(supportConversationTransitions.cancelledAt)));
        return tx.update(supportConversations).set({ status: "human_active", handoffReasonCode: null, pendingTransitionId: null, pendingAction: null, pendingActionEffectiveAt: null, processingClaimId: null, processingClaimExpiresAt: null, version: current.version + 1, updatedAt: timestamp }).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner), eq(supportConversations.version, expectedVersion))).returning({ id: supportConversations.id, status: supportConversations.status, version: supportConversations.version });
      }));
      return updated ?? null;
    },

    async prepareHumanMessage(ownerEmail, conversationId, { text, idempotencyKey }, now = new Date()) {
      const owner = normalizeOwner(ownerEmail); const id = requiredBoundedText(conversationId, "Conversation ID", 100); const messageText = boundedText(text, "Human reply", 5_000); const key = requiredBoundedText(idempotencyKey, "Human reply key", 100); const timestamp = validDate(now);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [conversation] = await tx.select().from(supportConversations).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner))).limit(1);
        if (!conversation || conversation.status !== "human_active") return null;
        const scopedKey = `human:${owner}:${id}:${key}`;
        let [message] = await tx.select().from(supportMessages).where(eq(supportMessages.idempotencyKey, scopedKey)).limit(1);
        if (message && (message.conversationId !== id || message.textContent !== messageText)) return null;
        if (!message) {
          const messageId = randomUUID();
          [message] = await tx.insert(supportMessages).values({ id: messageId, conversationId: id, direction: "outbound", senderType: "human", messageType: "text", textContent: messageText, safeMetadataJson: "{}", providerMessageId: null, deliveryStatus: "pending", idempotencyKey: scopedKey, sentAt: null, failedAt: null, safeErrorCode: null, processedAt: null, createdAt: timestamp }).returning();
        } else if (message.deliveryStatus !== "sent") {
          [message] = await tx.update(supportMessages).set({ deliveryStatus: "pending", failedAt: null, safeErrorCode: null }).where(eq(supportMessages.id, message.id)).returning();
        }
        return { id: message.id, conversationId: id, deliveryStatus: message.deliveryStatus, safeErrorCode: message.safeErrorCode, retryKey: message.id, connectionId: conversation.platformConnectionId, canonicalBody: JSON.stringify({ to: decryptExternalId(conversation.encryptedCustomerExternalId, encryptionKey), messages: [{ type: "text", text: message.textContent }] }) };
      }));
    },

    async prepareHumanMessageRetry(ownerEmail, messageId, now = new Date()) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(messageId, "Human message ID", 100);
      validDate(now);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [message] = await tx.select().from(supportMessages).where(and(
          eq(supportMessages.id, id),
          eq(supportMessages.senderType, "human"),
          eq(supportMessages.direction, "outbound"),
          eq(supportMessages.deliveryStatus, "failed"),
          exists(tx.select({ one: sql`1` }).from(supportConversations).where(and(
            eq(supportConversations.id, supportMessages.conversationId),
            eq(supportConversations.ownerEmail, owner),
            eq(supportConversations.status, "human_active"),
          ))),
        )).limit(1);
        if (!message) return null;
        const [conversation] = await tx.select().from(supportConversations).where(and(
          eq(supportConversations.id, message.conversationId),
          eq(supportConversations.ownerEmail, owner),
          eq(supportConversations.status, "human_active"),
        )).limit(1);
        if (!conversation) return null;
        const [prepared] = await tx.update(supportMessages).set({
          deliveryStatus: "pending",
          failedAt: null,
          safeErrorCode: null,
        }).where(and(
          eq(supportMessages.id, id),
          eq(supportMessages.deliveryStatus, "failed"),
        )).returning();
        if (!prepared) return null;
        return {
          id: prepared.id,
          conversationId: prepared.conversationId,
          deliveryStatus: prepared.deliveryStatus,
          safeErrorCode: prepared.safeErrorCode,
          retryKey: prepared.id,
          connectionId: conversation.platformConnectionId,
          canonicalBody: JSON.stringify({
            to: decryptExternalId(conversation.encryptedCustomerExternalId, encryptionKey),
            messages: [{ type: "text", text: prepared.textContent }],
          }),
        };
      }));
    },

    async markHumanMessageDelivery(ownerEmail, messageId, status, safeErrorCode, now = new Date()) {
      const owner = normalizeOwner(ownerEmail); const id = requiredBoundedText(messageId, "Human message ID", 100); const timestamp = validDate(now);
      if (status !== "sent" && status !== "failed") throw unavailablePersistenceError();
      const [message] = await retryBusyOperation(() => db.transaction(async (tx) => {
        const ownerPredicate = exists(tx.select({ one: sql`1` }).from(supportConversations).where(and(
          eq(supportConversations.id, supportMessages.conversationId),
          eq(supportConversations.ownerEmail, owner),
        )));
        const [current] = await tx.select().from(supportMessages).where(and(
          eq(supportMessages.id, id),
          eq(supportMessages.senderType, "human"),
          ownerPredicate,
        )).limit(1);
        if (!current) return [];
        if (current.deliveryStatus === "sent") {
          return [{ id: current.id, deliveryStatus: current.deliveryStatus, safeErrorCode: current.safeErrorCode }];
        }
        const [updated] = await tx.update(supportMessages).set({
          deliveryStatus: status,
          sentAt: status === "sent" ? timestamp : null,
          failedAt: status === "failed" ? timestamp : null,
          safeErrorCode: safeErrorCode == null ? null : safeOutboundErrorCode(safeErrorCode),
        }).where(and(
          eq(supportMessages.id, id),
          eq(supportMessages.senderType, "human"),
          ne(supportMessages.deliveryStatus, "sent"),
          ownerPredicate,
        )).returning();
        if (updated?.deliveryStatus === "sent") await tx.update(supportConversations).set({ lastOutboundAt: timestamp, updatedAt: timestamp }).where(eq(supportConversations.id, updated.conversationId));
        return updated ? [{ id: updated.id, deliveryStatus: updated.deliveryStatus, safeErrorCode: updated.safeErrorCode }] : [];
      }));
      return message ?? null;
    },

    async requestSupportTransition(ownerEmail, conversationId, action, expectedVersion, now = new Date(), transitionId = randomUUID()) {
      const owner = normalizeOwner(ownerEmail); const id = requiredBoundedText(conversationId, "Conversation ID", 100); const timestamp = validDate(now); const transition = requiredBoundedText(transitionId, "Transition ID", 100);
      const toStatus = action === "return_to_ai" ? "ai_active" : action === "resolve" ? "resolved" : null;
      if (!toStatus || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw unavailablePersistenceError();
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [current] = await tx.select().from(supportConversations).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner))).limit(1);
        if (!current || current.status !== "human_active"
          || current.version !== expectedVersion || current.pendingTransitionId) return null;
        const effectiveAt = new Date(timestamp.getTime() + 10_000);
        await tx.insert(supportConversationTransitions).values({ id: transition, conversationId: id, requestedAction: action, fromStatus: current.status, toStatus, requestedByOwnerEmail: owner, expectedVersion, requestedAt: timestamp, effectiveAt, cancelledAt: null, committedAt: null, createdAt: timestamp });
        const [updated] = await tx.update(supportConversations).set({ status: `${action}_pending`, pendingTransitionId: transition, pendingAction: action, pendingActionEffectiveAt: effectiveAt, version: current.version + 1, updatedAt: timestamp }).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner), eq(supportConversations.status, "human_active"), eq(supportConversations.version, expectedVersion), isNull(supportConversations.pendingTransitionId))).returning({ id: supportConversations.id });
        if (!updated) throw unavailablePersistenceError();
        return { id: transition, conversationId: id, requestedAction: action, effectiveAt };
      }));
    },

    async commitSupportTransition({ transitionId, conversationId, now = new Date() }) {
      const transitionIdValue = requiredBoundedText(transitionId, "Transition ID", 100); const conversationIdValue = requiredBoundedText(conversationId, "Conversation ID", 100); const timestamp = validDate(now);
      return commitSupportTransitionInternal(db, transitionIdValue, conversationIdValue, timestamp);
    },

    async undoSupportTransition(ownerEmail, conversationId, transitionId, now = new Date()) {
      const owner = normalizeOwner(ownerEmail); const id = requiredBoundedText(conversationId, "Conversation ID", 100); const transitionIdValue = requiredBoundedText(transitionId, "Transition ID", 100); const timestamp = validDate(now);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [transition] = await tx.select().from(supportConversationTransitions).where(and(eq(supportConversationTransitions.id, transitionIdValue), eq(supportConversationTransitions.conversationId, id), eq(supportConversationTransitions.requestedByOwnerEmail, owner), isNull(supportConversationTransitions.cancelledAt), isNull(supportConversationTransitions.committedAt))).limit(1);
        if (!transition) return null;
        const [conversation] = await tx.update(supportConversations).set({ status: transition.fromStatus, handoffReasonCode: null, pendingTransitionId: null, pendingAction: null, pendingActionEffectiveAt: null, version: transition.expectedVersion + 2, updatedAt: timestamp }).where(and(eq(supportConversations.id, id), eq(supportConversations.ownerEmail, owner), eq(supportConversations.pendingTransitionId, transitionIdValue), eq(supportConversations.version, transition.expectedVersion + 1))).returning({ id: supportConversations.id, status: supportConversations.status, version: supportConversations.version });
        if (!conversation) return null;
        const [cancelled] = await tx.update(supportConversationTransitions).set({ cancelledAt: timestamp }).where(and(eq(supportConversationTransitions.id, transitionIdValue), isNull(supportConversationTransitions.cancelledAt), isNull(supportConversationTransitions.committedAt))).returning({ id: supportConversationTransitions.id });
        if (!cancelled) throw unavailablePersistenceError();
        return conversation;
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

    async markLineEventProcessed({ connectionId, eventId, claimId, conversationId, conversationClaimId, now = new Date() }) {
      const processing = validateDispatchInput({ connectionId, eventId, claimId, now });
      if ((conversationId == null) !== (conversationClaimId == null)) throw unavailablePersistenceError();
      const conversationPredicate = conversationId == null ? null : exists(db.select({ one: sql`1` }).from(supportConversations).where(and(
        eq(supportConversations.id, requiredBoundedText(conversationId, "Conversation ID", 100)),
        eq(supportConversations.platformConnectionId, processing.connectionId),
        eq(supportConversations.processingClaimId, requiredBoundedText(conversationClaimId, "Conversation claim", 100)),
        inArray(supportConversations.status, ["ai_active", "resolved"]),
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

    async acquireConversationClaim({
      connectionId, eventId, eventClaimId, conversationId, now = new Date(),
    }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, now });
      const recoveryEventId = eventId == null
        ? null
        : requiredBoundedText(eventId, "Webhook event ID", 256);
      const recoveryEventClaimId = eventClaimId == null
        ? null
        : requiredBoundedText(eventClaimId, "Event processing claim", 100);
      if ((recoveryEventId == null) !== (recoveryEventClaimId == null)) throw unavailablePersistenceError();
      const recoverableHandoff = recoveryEventId == null
        ? sql`0`
        : exists(db.select({ one: sql`1` }).from(supportOutboundDeliveries)
          .innerJoin(supportWebhookEvents, eq(
            supportWebhookEvents.id,
            supportOutboundDeliveries.webhookEventId,
          ))
          .innerJoin(supportMessages, and(
            eq(supportMessages.conversationId, supportOutboundDeliveries.conversationId),
            eq(supportMessages.idempotencyKey, `${claim.connectionId}:${recoveryEventId}`),
            eq(supportMessages.direction, "inbound"),
          ))
          .innerJoin(supportAiDecisions, and(
            eq(supportAiDecisions.conversationId, supportOutboundDeliveries.conversationId),
            eq(supportAiDecisions.inboundMessageId, supportMessages.id),
            eq(supportAiDecisions.action, "handoff"),
          ))
          .where(and(
            eq(supportOutboundDeliveries.conversationId, claim.conversationId),
            eq(supportWebhookEvents.platformConnectionId, claim.connectionId),
            eq(supportWebhookEvents.webhookEventId, recoveryEventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, recoveryEventClaimId),
            gt(supportWebhookEvents.processedAt, claim.now),
          )));
      const claimId = randomUUID();
      const [claimed] = await retryBusyOperation(() => db.update(supportConversations).set({
        processingClaimId: claimId,
        processingClaimExpiresAt: new Date(claim.now.getTime() + EVENT_PROCESSING_LEASE_MS),
        updatedAt: claim.now,
      }).where(and(
        eq(supportConversations.id, claim.conversationId),
        eq(supportConversations.platformConnectionId, claim.connectionId),
        or(
          eq(supportConversations.status, "ai_active"),
          and(eq(supportConversations.status, "waiting_human"), recoverableHandoff),
        ),
        or(
          isNull(supportConversations.processingClaimId),
          isNull(supportConversations.processingClaimExpiresAt),
          lte(supportConversations.processingClaimExpiresAt, claim.now),
        ),
      )).returning({ id: supportConversations.id }));
      return claimed ? { acquired: true, claimId, windowStart: claim.now } : { acquired: false };
    },

    async recoverExistingDelivery({
      connectionId, eventId, eventClaimId, conversationId, conversationClaimId, now = new Date(),
    }) {
      const input = {
        ...validateConversationClaimInput({
          connectionId,
          conversationId,
          claimId: conversationClaimId,
          now,
        }),
        eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
        eventClaimId: requiredBoundedText(eventClaimId, "Event processing claim", 100),
      };
      const [recovered] = await db.select({
        deliveryId: supportOutboundDeliveries.id,
        action: supportAiDecisions.action,
      }).from(supportOutboundDeliveries)
        .innerJoin(supportWebhookEvents, eq(
          supportWebhookEvents.id,
          supportOutboundDeliveries.webhookEventId,
        ))
        .innerJoin(supportMessages, and(
          eq(supportMessages.conversationId, supportOutboundDeliveries.conversationId),
          eq(supportMessages.idempotencyKey, `${input.connectionId}:${input.eventId}`),
          eq(supportMessages.direction, "inbound"),
        ))
        .innerJoin(supportAiDecisions, and(
          eq(supportAiDecisions.conversationId, supportOutboundDeliveries.conversationId),
          eq(supportAiDecisions.inboundMessageId, supportMessages.id),
        ))
        .innerJoin(supportConversations, and(
          eq(supportConversations.id, supportOutboundDeliveries.conversationId),
          eq(supportConversations.platformConnectionId, input.connectionId),
          eq(supportConversations.processingClaimId, input.claimId),
          gt(supportConversations.processingClaimExpiresAt, input.now),
          or(
            and(
              eq(supportConversations.status, "ai_active"),
              inArray(supportAiDecisions.action, ["reply", "clarify"]),
            ),
            and(
              eq(supportConversations.status, "waiting_human"),
              eq(supportAiDecisions.action, "handoff"),
            ),
          ),
        ))
        .where(and(
          eq(supportOutboundDeliveries.conversationId, input.conversationId),
          eq(supportWebhookEvents.platformConnectionId, input.connectionId),
          eq(supportWebhookEvents.webhookEventId, input.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, input.eventClaimId),
          gt(supportWebhookEvents.processedAt, input.now),
        )).limit(1);
      return recovered ? {
        deliveryId: recovered.deliveryId,
        ...(recovered.action === "handoff" ? { handoffAcknowledgement: true } : {}),
      } : null;
    },

    async renewConversationClaim({
      connectionId, eventId, eventClaimId, conversationId, claimId, now = new Date(),
    }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, claimId, now });
      const activeHandoffEventId = eventId == null
        ? null
        : requiredBoundedText(eventId, "Webhook event ID", 256);
      const activeHandoffEventClaimId = eventClaimId == null
        ? null
        : requiredBoundedText(eventClaimId, "Event processing claim", 100);
      const activeHandoff = activeHandoffEventId == null || activeHandoffEventClaimId == null
        ? sql`0`
        : exists(db.select({ one: sql`1` }).from(supportOutboundDeliveries)
          .innerJoin(supportWebhookEvents, eq(
            supportWebhookEvents.id,
            supportOutboundDeliveries.webhookEventId,
          )).where(and(
            eq(supportOutboundDeliveries.conversationId, claim.conversationId),
            eq(supportWebhookEvents.platformConnectionId, claim.connectionId),
            eq(supportWebhookEvents.webhookEventId, activeHandoffEventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, activeHandoffEventClaimId),
            gt(supportWebhookEvents.processedAt, claim.now),
          )));
      const [renewed] = await retryBusyOperation(() => db.update(supportConversations).set({
        processingClaimExpiresAt: new Date(claim.now.getTime() + EVENT_PROCESSING_LEASE_MS),
        updatedAt: claim.now,
      }).where(and(
        eq(supportConversations.id, claim.conversationId),
        eq(supportConversations.platformConnectionId, claim.connectionId),
        eq(supportConversations.processingClaimId, claim.claimId),
        or(
          eq(supportConversations.status, "ai_active"),
          eq(supportConversations.status, "resolved"),
          and(eq(supportConversations.status, "waiting_human"), activeHandoff),
        ),
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
        const messages = await tx.select({ id: supportMessages.id, messageType: supportMessages.messageType }).from(supportMessages)
          .where(and(
            eq(supportMessages.conversationId, turn.conversationId),
            eq(supportMessages.direction, "inbound"),
            eq(supportMessages.senderType, "customer"),
            isNull(supportMessages.processedAt),
            lte(supportMessages.createdAt, turn.cutoff),
          )).orderBy(asc(supportMessages.createdAt), asc(supportMessages.id))
          .limit(MAX_CLAIMED_BATCH_MESSAGES);
        if (!messages.length) return null;
        const [inbound] = await tx.select({ id: supportMessages.id, messageType: supportMessages.messageType }).from(supportMessages).where(and(
          eq(supportMessages.conversationId, turn.conversationId),
          eq(supportMessages.idempotencyKey, `${turn.connectionId}:${turn.eventId}`),
        )).limit(1);
        if (!inbound || !messages.some((message) => message.id === inbound.id)) return null;
        return messages.every(({ messageType }) => messageType === "text")
          ? { inboundMessageId: inbound.id }
          : { inboundMessageId: inbound.id, handoffReasonCode: "non_text" };
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
        )).orderBy(asc(supportMessages.createdAt), asc(supportMessages.id))
          .limit(MAX_CLAIMED_BATCH_MESSAGES),
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
        aiClosureConfirmationMessageId: conversation.aiClosureConfirmationMessageId,
        aiClosureConfirmationExpiresAt: conversation.aiClosureConfirmationExpiresAt,
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
          inArray(supportMessages.id, batchMessages.map(({ id }) => id)),
          isNull(supportMessages.processedAt),
        ));
        await completeDispatchedBatchEvents(tx, decision, batchMessages);
        const answerMessageId = randomUUID();
        await tx.insert(supportMessages).values({
          id: answerMessageId, conversationId: decision.conversationId, direction: "outbound", senderType: "ai",
          messageType: "text", textContent: decision.answer, safeMetadataJson: "{}", providerMessageId: null,
          deliveryStatus: "pending", idempotencyKey: `ai:${decision.connectionId}:${decision.eventId}`,
          sentAt: null, failedAt: null, safeErrorCode: null, processedAt: decision.now, createdAt: decision.now,
        });
        const [configuration] = await tx.select({ llmProvider: supportConfigurations.llmProvider, llmModel: supportConfigurations.llmModel }).from(supportConfigurations).where(and(eq(supportConfigurations.ownerEmail, conversation.ownerEmail), eq(supportConfigurations.platformConnectionId, decision.connectionId))).limit(1);
        await tx.insert(supportAiDecisions).values({
          id: randomUUID(), conversationId: decision.conversationId, inboundMessageId: inbound.id, action: decision.action,
          category: decision.category, reasonCode: null, answerMessageId, faqIdsJson: JSON.stringify(decision.knowledgeSourceIds),
          conversationDisposition: decision.conversationDisposition,
          handoffSummary: null,
          humanChecklistJson: "[]",
          prohibitedCommitmentsJson: "[]",
          llmProvider: configuration?.llmProvider ?? null, llmModel: configuration?.llmModel ?? null, promptVersion: "support-v1",
          inputTokens: null, outputTokens: null, latencyMs: null, createdAt: decision.now,
        });
        await tx.update(supportConversations).set({
          aiClosureConfirmationMessageId: decision.conversationDisposition === "ask_close_confirmation"
            ? answerMessageId
            : null,
          aiClosureConfirmationExpiresAt: decision.conversationDisposition === "ask_close_confirmation"
            ? new Date(decision.now.getTime() + 24 * 60 * 60 * 1_000)
            : null,
          updatedAt: decision.now,
        }).where(and(
          eq(supportConversations.id, decision.conversationId),
          eq(supportConversations.processingClaimId, decision.claimId),
          eq(supportConversations.status, "ai_active"),
        ));
        const [created] = await tx.insert(supportOutboundDeliveries).values({
          id: randomUUID(), webhookEventId: event.id, conversationId: decision.conversationId,
          encryptedRecipient: encryptExternalId(decision.recipient, encryptionKey),
          encryptedCanonicalBody: encryptOutboundCanonicalBody(decision.canonicalBody, encryptionKey), retryKey: randomUUID(),
          deliveryStatus: "pending", deliveryClaimId: null, deliveryClaimExpiresAt: null, attemptCount: 0,
          firstAttemptAt: null, lastAttemptAt: null, nextAttemptAt: null, acceptedRequestId: null, safeErrorCode: null,
          sentAt: null, failedAt: null, humanReviewAt: null, createdAt: decision.now,
        }).returning({ id: supportOutboundDeliveries.id });
        if (!created) throw unavailablePersistenceError();
        return { deliveryId: created.id };
      }));
    },

    async persistHandoff({
      connectionId, eventId, eventClaimId, conversationId, claimId, inboundMessageId,
      cutoff, reasonCode, now = new Date(),
    }) {
      const claim = validateConversationClaimInput({ connectionId, conversationId, claimId, now });
      const primaryEventId = eventId == null ? null : requiredBoundedText(eventId, "Webhook event ID", 256);
      const primaryEventClaimId = eventClaimId == null ? null : requiredBoundedText(eventClaimId, "Event processing claim", 100);
      if ((primaryEventId == null) !== (primaryEventClaimId == null)) throw unavailablePersistenceError();
      const triggeringMessageId = requiredBoundedText(inboundMessageId, "Inbound message ID", 100);
      const batchCutoff = validDate(cutoff ?? claim.now);
      const handoffReason = requiredBoundedText(reasonCode, "Handoff reason", 100);
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [conversation] = await tx.select().from(supportConversations).where(and(
          eq(supportConversations.id, claim.conversationId),
          eq(supportConversations.platformConnectionId, claim.connectionId),
          eq(supportConversations.processingClaimId, claim.claimId),
          inArray(supportConversations.status, ["ai_active", "waiting_human"]),
          gt(supportConversations.processingClaimExpiresAt, claim.now),
        )).limit(1);
        if (!conversation) return false;
        if (conversation.status === "waiting_human") {
          if (!primaryEventId || !primaryEventClaimId
            || conversation.handoffReasonCode !== handoffReason) return false;
          const [existingDelivery] = await tx.select({
            deliveryId: supportOutboundDeliveries.id,
          }).from(supportOutboundDeliveries).innerJoin(
            supportWebhookEvents,
            eq(supportWebhookEvents.id, supportOutboundDeliveries.webhookEventId),
          ).where(and(
            eq(supportOutboundDeliveries.conversationId, claim.conversationId),
            eq(supportWebhookEvents.platformConnectionId, claim.connectionId),
            eq(supportWebhookEvents.webhookEventId, primaryEventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, primaryEventClaimId),
            gt(supportWebhookEvents.processedAt, claim.now),
            exists(tx.select({ one: sql`1` }).from(supportAiDecisions).where(and(
              eq(supportAiDecisions.conversationId, claim.conversationId),
              eq(supportAiDecisions.inboundMessageId, triggeringMessageId),
              eq(supportAiDecisions.action, "handoff"),
              eq(supportAiDecisions.reasonCode, handoffReason),
              isNull(supportAiDecisions.answerMessageId),
            ))),
          )).limit(1);
          return existingDelivery
            ? { deliveryId: existingDelivery.deliveryId, handoffAcknowledgement: true }
            : false;
        }
        const [configuration] = await tx.select({
          llmProvider: supportConfigurations.llmProvider,
          llmModel: supportConfigurations.llmModel,
        }).from(supportConfigurations).where(and(
          eq(supportConfigurations.ownerEmail, conversation.ownerEmail),
          eq(supportConfigurations.platformConnectionId, claim.connectionId),
        )).limit(1);
        let eventCompleted = false;
        let primaryEvent;
        let batchMessages = [];
        if (primaryEventId) {
          [primaryEvent] = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents).where(and(
            eq(supportWebhookEvents.platformConnectionId, claim.connectionId),
            eq(supportWebhookEvents.webhookEventId, primaryEventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, primaryEventClaimId),
            gt(supportWebhookEvents.processedAt, claim.now),
          )).limit(1);
          if (!primaryEvent) return false;
          const batch = { ...claim, eventId: primaryEventId, cutoff: batchCutoff };
          batchMessages = await selectClaimedBatchMessages(tx, { ...batch, includeNonText: true });
          if (!batchMessages.some(({ id }) => id === triggeringMessageId)) return false;
          await tx.update(supportMessages).set({ processedAt: batchCutoff }).where(and(
            eq(supportMessages.conversationId, claim.conversationId),
            inArray(supportMessages.id, batchMessages.map(({ id }) => id)),
            isNull(supportMessages.processedAt),
          ));
          await completeDispatchedBatchEvents(tx, batch, batchMessages);
        }
        const handoffDetails = handoffDetailsFor(handoffReason);
        await tx.insert(supportAiDecisions).values({
          id: randomUUID(),
          conversationId: claim.conversationId,
          inboundMessageId: triggeringMessageId,
          action: "handoff",
          category: null,
          reasonCode: handoffReason,
          answerMessageId: null,
          faqIdsJson: "[]",
          conversationDisposition: "handoff_human",
          handoffSummary: handoffDetails.summary,
          humanChecklistJson: JSON.stringify(handoffDetails.checklist),
          prohibitedCommitmentsJson: JSON.stringify(handoffDetails.prohibitedCommitments),
          llmProvider: configuration?.llmProvider ?? null,
          llmModel: configuration?.llmModel ?? null,
          promptVersion: "support-v1",
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          createdAt: claim.now,
        });
        let recipient = null;
        const [activeConnection] = await tx.select({
          id: platformConnections.id,
          encryptedCredentials: platformConnections.encryptedCredentials,
        }).from(platformConnections)
          .where(and(
            eq(platformConnections.id, claim.connectionId),
            eq(platformConnections.ownerEmail, conversation.ownerEmail),
            eq(platformConnections.platform, "line"),
            eq(platformConnections.state, "active"),
          )).limit(1);
        let lineDeliveryUsable = false;
        if (activeConnection) {
          try {
            lineDeliveryUsable = Boolean(
              requiredBoundedText(
                decryptJson(activeConnection.encryptedCredentials, encryptionKey)?.accessToken,
                "LINE access token",
                10_000,
              ),
            );
          } catch {
            lineDeliveryUsable = false;
          }
        }
        if (lineDeliveryUsable && primaryEvent) {
          try {
            recipient = decryptExternalId(conversation.encryptedCustomerExternalId, encryptionKey);
          } catch {
            recipient = null;
          }
        }
        let deliveryId = null;
        if (recipient && primaryEvent) {
          const acknowledgementMessageId = randomUUID();
          await tx.insert(supportMessages).values({
            id: acknowledgementMessageId,
            conversationId: claim.conversationId,
            direction: "outbound",
            senderType: "ai",
            messageType: "text",
            textContent: HANDOFF_ACKNOWLEDGEMENT_TEXT,
            safeMetadataJson: "{}",
            providerMessageId: null,
            deliveryStatus: "pending",
            idempotencyKey: `ai:${claim.connectionId}:${primaryEventId}`,
            sentAt: null,
            failedAt: null,
            safeErrorCode: null,
            processedAt: claim.now,
            createdAt: claim.now,
          });
          deliveryId = randomUUID();
          const canonicalBody = buildHandoffAcknowledgementBody(recipient);
          await tx.insert(supportOutboundDeliveries).values({
            id: deliveryId,
            webhookEventId: primaryEvent.id,
            conversationId: claim.conversationId,
            encryptedRecipient: encryptExternalId(recipient, encryptionKey),
            encryptedCanonicalBody: encryptOutboundCanonicalBody(canonicalBody, encryptionKey),
            retryKey: randomUUID(),
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
            createdAt: claim.now,
          });
        } else if (primaryEvent) {
          const [completed] = await tx.update(supportWebhookEvents).set({
            processingStatus: "processed",
            safeErrorCode: null,
            processedAt: claim.now,
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
          processingClaimId: deliveryId ? claim.claimId : null,
          processingClaimExpiresAt: deliveryId
            ? new Date(claim.now.getTime() + EVENT_PROCESSING_LEASE_MS)
            : null,
          version: conversation.version + 1,
          updatedAt: claim.now,
        }).where(and(
          eq(supportConversations.id, claim.conversationId), eq(supportConversations.platformConnectionId, claim.connectionId),
          eq(supportConversations.processingClaimId, claim.claimId),
          eq(supportConversations.status, "ai_active"),
          gt(supportConversations.processingClaimExpiresAt, claim.now),
        )).returning({ id: supportConversations.id });
        if (!updated) throw unavailablePersistenceError();
        return deliveryId
          ? { deliveryId, handoffAcknowledgement: true }
          : eventCompleted ? { eventCompleted: true } : true;
      }));
    },

    async finalizeHandoffDelivery({
      connectionId, eventId, eventClaimId, conversationId, claimId, deliveryId, now = new Date(),
    }) {
      const input = {
        ...validateConversationClaimInput({ connectionId, conversationId, claimId, now }),
        eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
        eventClaimId: requiredBoundedText(eventClaimId, "Event processing claim", 100),
        deliveryId: requiredBoundedText(deliveryId, "Outbound delivery ID", 100),
      };
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const terminalDelivery = exists(tx.select({ one: sql`1` }).from(supportOutboundDeliveries)
          .innerJoin(supportWebhookEvents, eq(
            supportWebhookEvents.id,
            supportOutboundDeliveries.webhookEventId,
          )).where(and(
            eq(supportOutboundDeliveries.id, input.deliveryId),
            eq(supportOutboundDeliveries.conversationId, input.conversationId),
            inArray(supportOutboundDeliveries.deliveryStatus, ["sent", "failed", "human_review"]),
            eq(supportWebhookEvents.platformConnectionId, input.connectionId),
            eq(supportWebhookEvents.webhookEventId, input.eventId),
          )));
        const [conversation] = await tx.update(supportConversations).set({
          processingClaimId: null,
          processingClaimExpiresAt: null,
          updatedAt: input.now,
        }).where(and(
          eq(supportConversations.id, input.conversationId),
          eq(supportConversations.platformConnectionId, input.connectionId),
          eq(supportConversations.status, "waiting_human"),
          eq(supportConversations.processingClaimId, input.claimId),
          gt(supportConversations.processingClaimExpiresAt, input.now),
          terminalDelivery,
        )).returning({ id: supportConversations.id });
        if (!conversation) return false;
        const [completed] = await tx.update(supportWebhookEvents).set({
          processingStatus: "processed",
          safeErrorCode: null,
          processedAt: input.now,
        }).where(and(
          eq(supportWebhookEvents.platformConnectionId, input.connectionId),
          eq(supportWebhookEvents.webhookEventId, input.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, input.eventClaimId),
          gt(supportWebhookEvents.processedAt, input.now),
        )).returning({ id: supportWebhookEvents.id });
        if (!completed) throw unavailablePersistenceError();
        return true;
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

    async markOwnedLineConnectionNeedsReconnect(ownerEmail, connectionId, conversationId, now = new Date()) {
      const owner = normalizeOwner(ownerEmail);
      const id = requiredBoundedText(connectionId, "Connection ID", 100);
      const conversation = requiredBoundedText(conversationId, "Conversation ID", 100);
      const [updated] = await retryBusyOperation(() => db.update(platformConnections).set({
        state: "needs_reconnect",
        updatedAt: validDate(now),
      }).where(and(
        eq(platformConnections.id, id),
        eq(platformConnections.ownerEmail, owner),
        eq(platformConnections.platform, "line"),
        eq(platformConnections.state, "active"),
        exists(db.select({ one: sql`1` }).from(supportConversations).where(and(
          eq(supportConversations.id, conversation),
          eq(supportConversations.ownerEmail, owner),
          eq(supportConversations.platformConnectionId, id),
        ))),
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
        const [event] = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents).where(and(
          eq(supportWebhookEvents.platformConnectionId, input.connectionId),
          eq(supportWebhookEvents.webhookEventId, input.eventId),
          eq(supportWebhookEvents.processingStatus, "processing"),
          eq(supportWebhookEvents.safeErrorCode, input.eventClaimId),
          gt(supportWebhookEvents.processedAt, input.now),
        )).limit(1);
        const [conversation] = await tx.select().from(supportConversations).where(and(
          eq(supportConversations.id, input.conversationId),
          eq(supportConversations.platformConnectionId, input.connectionId),
          eq(supportConversations.processingClaimId, input.claimId),
          inArray(supportConversations.status, ["ai_active", "waiting_human"]),
          gt(supportConversations.processingClaimExpiresAt, input.now),
        )).limit(1);
        if (!event || !conversation) return false;
        const [inbound] = await tx.select({ id: supportMessages.id }).from(supportMessages).where(and(
          eq(supportMessages.conversationId, input.conversationId),
          eq(supportMessages.idempotencyKey, `${input.connectionId}:${input.eventId}`),
          eq(supportMessages.direction, "inbound"),
        )).limit(1);
        if (!inbound) return false;
        await tx.update(platformConnections).set({ state: "needs_reconnect", updatedAt: input.now }).where(and(
          eq(platformConnections.id, input.connectionId), eq(platformConnections.platform, "line"), eq(platformConnections.state, "active"),
          eq(platformConnections.ownerEmail, conversation.ownerEmail),
        ));
        if (conversation.status === "ai_active") {
          const [configuration] = await tx.select({
            llmProvider: supportConfigurations.llmProvider,
            llmModel: supportConfigurations.llmModel,
          }).from(supportConfigurations).where(and(
            eq(supportConfigurations.ownerEmail, conversation.ownerEmail),
            eq(supportConfigurations.platformConnectionId, input.connectionId),
          )).limit(1);
          await tx.insert(supportAiDecisions).values({
            id: randomUUID(),
            conversationId: input.conversationId,
            inboundMessageId: inbound.id,
            action: "handoff",
            category: null,
            reasonCode: "credential_rejected",
            answerMessageId: null,
            faqIdsJson: "[]",
            llmProvider: configuration?.llmProvider ?? null,
            llmModel: configuration?.llmModel ?? null,
            promptVersion: "support-v1",
            inputTokens: null,
            outputTokens: null,
            latencyMs: null,
            createdAt: input.now,
          });
        }
        const [handoff] = await tx.update(supportConversations).set({
          status: "waiting_human",
          handoffReasonCode: conversation.status === "ai_active"
            ? "credential_rejected"
            : conversation.handoffReasonCode,
          processingClaimId: null,
          processingClaimExpiresAt: null,
          version: conversation.status === "ai_active"
            ? conversation.version + 1
            : conversation.version,
          updatedAt: input.now,
        }).where(and(
          eq(supportConversations.id, input.conversationId), eq(supportConversations.platformConnectionId, input.connectionId),
          eq(supportConversations.status, conversation.status),
          eq(supportConversations.processingClaimId, input.claimId),
          gt(supportConversations.processingClaimExpiresAt, input.now),
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

    async claimLineOutboundDelivery({
      deliveryId,
      connectionId,
      eventId,
      eventClaimId,
      conversationId,
      conversationClaimId,
      now = new Date(),
    }) {
      const delivery = {
        deliveryId: requiredBoundedText(deliveryId, "Outbound delivery ID", 100),
        connectionId: requiredBoundedText(connectionId, "Connection ID", 100),
        eventId: requiredBoundedText(eventId, "Webhook event ID", 256),
        eventClaimId: requiredBoundedText(eventClaimId, "Event processing claim", 100),
        conversationId: requiredBoundedText(conversationId, "Conversation ID", 100),
        conversationClaimId: requiredBoundedText(conversationClaimId, "Conversation claim", 100),
        now: validDate(now),
      };
      return retryBusyOperation(() => db.transaction(async (tx) => {
        const [existing] = await tx.select().from(supportOutboundDeliveries)
          .where(eq(supportOutboundDeliveries.id, delivery.deliveryId)).limit(1);
        if (!existing) return { claimed: false, status: "duplicate" };
        if (existing.conversationId !== delivery.conversationId) {
          return { claimed: false, status: existing.deliveryStatus };
        }
        const [owned] = await tx.select({ id: supportWebhookEvents.id }).from(supportWebhookEvents)
          .innerJoin(supportConversations, and(
            eq(supportConversations.id, delivery.conversationId),
            eq(supportConversations.platformConnectionId, delivery.connectionId),
            eq(supportConversations.processingClaimId, delivery.conversationClaimId),
            gt(supportConversations.processingClaimExpiresAt, delivery.now),
            inArray(supportConversations.status, ["ai_active", "waiting_human"]),
          ))
          .where(and(
            eq(supportWebhookEvents.id, existing.webhookEventId),
            eq(supportWebhookEvents.platformConnectionId, delivery.connectionId),
            eq(supportWebhookEvents.webhookEventId, delivery.eventId),
            eq(supportWebhookEvents.processingStatus, "processing"),
            eq(supportWebhookEvents.safeErrorCode, delivery.eventClaimId),
            gt(supportWebhookEvents.processedAt, delivery.now),
          )).limit(1);
        if (!owned) return { claimed: false, status: existing.deliveryStatus };
        if (["sent", "failed", "human_review"].includes(existing.deliveryStatus)) {
          return { claimed: false, status: existing.deliveryStatus };
        }
        if (existing.firstAttemptAt
          && delivery.now.getTime() - existing.firstAttemptAt.getTime() > OUTBOUND_REVIEW_WINDOW_MS) {
          const [reviewed] = await tx.update(supportOutboundDeliveries).set({
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
              and(
                eq(supportOutboundDeliveries.deliveryStatus, "sending"),
                lte(supportOutboundDeliveries.deliveryClaimExpiresAt, delivery.now),
              ),
            ),
          )).returning();
          if (reviewed) {
            await synchronizeLinkedAiMessage(tx, reviewed, "human_review", delivery.now, "line_push_review_required");
            return { claimed: false, status: "human_review" };
          }
          const [authoritative] = await tx.select({ status: supportOutboundDeliveries.deliveryStatus })
            .from(supportOutboundDeliveries)
            .where(eq(supportOutboundDeliveries.id, delivery.deliveryId))
            .limit(1);
          return { claimed: false, status: authoritative?.status ?? "duplicate" };
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

    async getLineOutboundDeliveryStatus(deliveryId) {
      const id = requiredBoundedText(deliveryId, "Outbound delivery ID", 100);
      const [delivery] = await db.select({ status: supportOutboundDeliveries.deliveryStatus })
        .from(supportOutboundDeliveries)
        .where(eq(supportOutboundDeliveries.id, id))
        .limit(1);
      return delivery?.status ?? "duplicate";
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
        "question", "answer", "internalNotes", "category", "keywordsJson", "enabled", "priority", "updatedAt",
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
  const timestamp = validDate(now);
  const safeDeliveryId = requiredBoundedText(deliveryId, "Outbound delivery ID", 100);
  const safeClaimId = requiredBoundedText(claimId, "Outbound delivery claim", 100);
  return retryBusyOperation(() => db.transaction(async (tx) => {
    const [updated] = await tx.update(supportOutboundDeliveries).set({
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
      gt(supportOutboundDeliveries.deliveryClaimExpiresAt, timestamp),
    )).returning();
    if (!updated) return false;
    if (status === "sent" || status === "failed" || status === "human_review") {
      await synchronizeLinkedAiMessage(
        tx,
        updated,
        status,
        timestamp,
        changes.safeErrorCode ?? null,
      );
    }
    return true;
  }));
}

async function synchronizeLinkedAiMessage(tx, delivery, status, timestamp, safeErrorCode) {
  const [event] = await tx.select({
    connectionId: supportWebhookEvents.platformConnectionId,
    eventId: supportWebhookEvents.webhookEventId,
  }).from(supportWebhookEvents).where(eq(
    supportWebhookEvents.id,
    delivery.webhookEventId,
  )).limit(1);
  if (!event) throw unavailablePersistenceError();
  const messageChanges = {
    deliveryStatus: status,
    sentAt: status === "sent" ? timestamp : null,
    failedAt: status === "sent" ? null : timestamp,
    safeErrorCode: status === "sent"
      ? null
      : safeErrorCode == null ? null : safeOutboundErrorCode(safeErrorCode),
  };
  const [message] = await tx.update(supportMessages).set(messageChanges).where(and(
    eq(supportMessages.conversationId, delivery.conversationId),
    eq(supportMessages.senderType, "ai"),
    eq(supportMessages.direction, "outbound"),
    eq(supportMessages.idempotencyKey, `ai:${event.connectionId}:${event.eventId}`),
    ne(supportMessages.deliveryStatus, "sent"),
  )).returning({ id: supportMessages.id });
  if (status === "sent") {
    const deliveredMessageId = message?.id;
    if (!message) {
      const [alreadySent] = await tx.select({ id: supportMessages.id }).from(supportMessages).where(and(
        eq(supportMessages.conversationId, delivery.conversationId),
        eq(supportMessages.senderType, "ai"),
        eq(supportMessages.idempotencyKey, `ai:${event.connectionId}:${event.eventId}`),
        eq(supportMessages.deliveryStatus, "sent"),
      )).limit(1);
      if (!alreadySent) return;
      await finalizeAiResolutionAfterDelivery(tx, delivery.conversationId, alreadySent.id, timestamp);
    } else {
      await finalizeAiResolutionAfterDelivery(tx, delivery.conversationId, deliveredMessageId, timestamp);
    }
    await tx.update(supportConversations).set({
      lastOutboundAt: timestamp,
      updatedAt: timestamp,
    }).where(eq(supportConversations.id, delivery.conversationId));
  }
}

async function finalizeAiResolutionAfterDelivery(tx, conversationId, answerMessageId, timestamp) {
  const [decision] = await tx.select({ id: supportAiDecisions.id }).from(supportAiDecisions).where(and(
    eq(supportAiDecisions.conversationId, conversationId),
    eq(supportAiDecisions.answerMessageId, answerMessageId),
    eq(supportAiDecisions.conversationDisposition, "resolve_after_delivery"),
  )).limit(1);
  if (!decision) return;
  await tx.update(supportConversations).set({
    status: "resolved",
    handoffReasonCode: null,
    aiClosureConfirmationMessageId: null,
    aiClosureConfirmationExpiresAt: null,
    updatedAt: timestamp,
  }).where(and(
    eq(supportConversations.id, conversationId),
    eq(supportConversations.status, "ai_active"),
  ));
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
  const customerDisplayName = optionalBoundedText(input?.customerDisplayName, "Customer display name", 512);
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
    encryptedCustomerDisplayName: customerDisplayName ? encryptCustomerDisplayName(customerDisplayName, encryptionKey) : null,
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
  if (sourceType !== "group" && sourceType !== "room" && sourceType !== "user_event") {
    throw unavailablePersistenceError();
  }
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

async function selectClaimedBatchMessages(tx, {
  connectionId, conversationId, cutoff, includeNonText = false,
}) {
  return tx.select({
    id: supportMessages.id,
    idempotencyKey: supportMessages.idempotencyKey,
  }).from(supportMessages).where(and(
    eq(supportMessages.conversationId, conversationId),
    eq(supportMessages.direction, "inbound"),
    eq(supportMessages.senderType, "customer"),
    ...(includeNonText ? [] : [eq(supportMessages.messageType, "text")]),
    isNull(supportMessages.processedAt),
    lte(supportMessages.createdAt, cutoff),
  )).orderBy(asc(supportMessages.createdAt), asc(supportMessages.id)).limit(MAX_CLAIMED_BATCH_MESSAGES);
}

async function terminalizeAutomatedDeliveries(tx, conversationId, now) {
  const deliveries = await tx.update(supportOutboundDeliveries).set({
    deliveryStatus: "human_review", deliveryClaimId: null, deliveryClaimExpiresAt: null,
    nextAttemptAt: null, humanReviewAt: now, safeErrorCode: "human_takeover",
  }).where(and(
    eq(supportOutboundDeliveries.conversationId, conversationId),
    inArray(supportOutboundDeliveries.deliveryStatus, AUTOMATED_DELIVERY_STATUSES),
  )).returning();
  for (const delivery of deliveries) {
    await synchronizeLinkedAiMessage(tx, delivery, "human_review", now, "human_takeover");
  }
}

async function completeDispatchedBatchEvents(tx, { connectionId, eventId, cutoff }, messages) {
  const prefix = `${connectionId}:`;
  const companionEventIds = [...new Set(messages.map(({ idempotencyKey }) => (
    idempotencyKey?.startsWith(prefix) ? idempotencyKey.slice(prefix.length) : null
  )).filter((candidate) => candidate && candidate !== eventId))];
  if (companionEventIds.length) {
    await tx.update(supportWebhookEvents).set({
      processingStatus: "processed",
      safeErrorCode: null,
      processedAt: cutoff,
    }).where(and(
      eq(supportWebhookEvents.platformConnectionId, connectionId),
      inArray(supportWebhookEvents.webhookEventId, companionEventIds),
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

function customerLabel(encryptedDisplayName, encryptionKey) {
  if (!encryptedDisplayName) return "Customer";
  try {
    return decryptCustomerDisplayName(encryptedDisplayName, encryptionKey) || "Customer";
  } catch {
    return "Customer";
  }
}

function conversationIsInactive(conversation, receivedAt) {
  const activityAt = [conversation?.lastInboundAt, conversation?.lastOutboundAt]
    .map((value) => value instanceof Date ? value : new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .reduce((latest, value) => !latest || value > latest ? value : latest, null);
  return activityAt != null && receivedAt.getTime() - activityAt.getTime() >= CASE_INACTIVITY_MS;
}

function handoffDetailsFor(reasonCode) {
  if (reasonCode === "high_risk_refund") {
    return {
      summary: "Customer is asking about a return, refund, exchange, pickup, delivery, warranty, or repair. Confirm the order and product condition before making any commitment.",
      checklist: [
        "Confirm the order number and delivery date.",
        "Confirm whether the product has been opened, assembled, or used.",
        "Confirm the condition of the box, accessories, and packaging.",
      ],
      prohibitedCommitments: [
        "Do not state that pickup or a courier has already been arranged.",
        "Do not state that a refund has already been approved or completed.",
        "Do not quote a fixed refurbishment or handling fee before review.",
      ],
    };
  }
  return {
    summary: "AI paused this conversation because it needs human review before a customer-facing commitment is made.",
    checklist: [
      "Review the customer's latest request and the relevant FAQ source.",
      "Confirm the facts needed to answer the request before replying.",
    ],
    prohibitedCommitments: [
      "Do not claim that an operational action has already been completed unless it is verified in the relevant system.",
    ],
  };
}

function validatePersistDecisionInput(input = {}) {
  const decision = input?.decision;
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
  if (decision.action !== "reply" && decision.action !== "clarify") throw unavailablePersistenceError();
  const answer = requiredBoundedText(input?.decision?.answer, "AI answer", 2_000);
  const category = input?.decision?.category == null ? null : requiredBoundedText(input.decision.category, "AI category", 80);
  const conversationDisposition = new Set([
    "continue_ai",
    "ask_close_confirmation",
    "resolve_after_delivery",
  ]).has(input?.decision?.conversationDisposition)
    ? input.decision.conversationDisposition
    : "continue_ai";
  const knowledgeSourceIds = Array.isArray(input?.decision?.knowledgeSourceIds)
    ? [...new Set(input.decision.knowledgeSourceIds.map((id) => requiredBoundedText(id, "FAQ ID", 100)))]
    : [];
  if (!knowledgeSourceIds.length && conversationDisposition !== "resolve_after_delivery") {
    throw unavailablePersistenceError();
  }
  const canonicalBody = boundedText(input?.canonicalBody, "LINE canonical body", 20_000);
  let payload;
  try { payload = JSON.parse(canonicalBody); } catch { throw unavailablePersistenceError(); }
  const recipient = requiredBoundedText(payload?.to, "LINE recipient", 256);
  if (!Array.isArray(payload?.messages) || payload.messages.length !== 1 || payload.messages[0]?.type !== "text"
    || payload.messages[0]?.text !== answer) throw unavailablePersistenceError();
  return {
    ...claim,
    action: decision.action,
    inboundMessageId: requiredBoundedText(input.inboundMessageId, "Inbound message ID", 100),
    answer,
    category,
    conversationDisposition,
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

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeInboxQueryCursor(cursor) {
  if (cursor == null) return null;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
    || !Number.isSafeInteger(cursor.updatedAt) || cursor.updatedAt < 0
    || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 100) {
    throw unavailablePersistenceError();
  }
  return cursor;
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

function validRetentionBatchSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) throw unavailablePersistenceError();
  return value;
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

async function commitSupportTransitionInternal(db, transitionIdValue, conversationIdValue, timestamp) {
  return retryBusyOperation(() => db.transaction(async (tx) => {
    const [transition] = await tx.select().from(supportConversationTransitions).where(and(
      eq(supportConversationTransitions.id, transitionIdValue),
      eq(supportConversationTransitions.conversationId, conversationIdValue),
    )).limit(1);
    if (!transition || transition.cancelledAt || transition.committedAt) return { status: "stale" };
    const [conversation] = await tx.update(supportConversations).set({
      status: transition.toStatus,
      handoffReasonCode: null,
      pendingTransitionId: null,
      pendingAction: null,
      pendingActionEffectiveAt: null,
      version: transition.expectedVersion + 2,
      updatedAt: timestamp,
    }).where(and(
      eq(supportConversations.id, conversationIdValue),
      eq(supportConversations.pendingTransitionId, transitionIdValue),
      eq(supportConversations.version, transition.expectedVersion + 1),
    )).returning({ id: supportConversations.id });
    if (!conversation) return { status: "stale" };
    const [committed] = await tx.update(supportConversationTransitions).set({
      committedAt: timestamp,
    }).where(and(
      eq(supportConversationTransitions.id, transitionIdValue),
      isNull(supportConversationTransitions.cancelledAt),
      isNull(supportConversationTransitions.committedAt),
    )).returning({ id: supportConversationTransitions.id });
    if (!committed) throw unavailablePersistenceError();
    return { status: "committed" };
  }));
}

async function commitDueTransitionsInternal(db, owner, now = new Date()) {
  try {
    const dueTransitions = await db.select({
      id: supportConversationTransitions.id,
      conversationId: supportConversationTransitions.conversationId,
    }).from(supportConversationTransitions).where(and(
      eq(supportConversationTransitions.requestedByOwnerEmail, owner),
      isNull(supportConversationTransitions.committedAt),
      isNull(supportConversationTransitions.cancelledAt),
      lte(supportConversationTransitions.effectiveAt, now),
    ));

    for (const transition of dueTransitions) {
      await commitSupportTransitionInternal(db, transition.id, transition.conversationId, now);
    }
  } catch {
    // Non-blocking auto-commit fallback
  }
}
