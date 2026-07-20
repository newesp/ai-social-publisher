import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

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
} from "../src/lib/db/schema.js";
import { decryptJson, encryptJson } from "../src/lib/settings/credential-crypto.js";
import { encryptExternalId, encryptOutboundCanonicalBody } from "../src/lib/support/identity-crypto.js";
import { createLineOutboundDeliveryService } from "../src/lib/support/outbox/line-outbound-delivery-service.js";
import { createSupportProcessingService } from "../src/lib/support/support-processing-service.js";
import { createSupportRepository } from "../src/lib/support/support-repository.js";
import { createLineMessageWorkflow } from "../src/lib/support/workflows/line-message-workflow.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const LATER = new Date("2026-07-19T00:01:00.000Z");
const SETTINGS_ENCRYPTION_KEY = "support-repository-test-key";

test("inbox pagination is owner scoped, deterministic, and bounded to 31 rows", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    await db.insert(platformConnections).values([
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
      connection("22222222-2222-4222-8222-222222222222", "other@example.com"),
    ]);
    const conversations = Array.from({ length: 36 }, (_, index) => ({
      id: `conversation-${String(index + 1).padStart(2, "0")}`,
      ownerEmail: "owner@example.com",
      platformConnectionId: "11111111-1111-4111-8111-111111111111",
      platform: "line",
      customerLookupKey: `owner-customer-${index + 1}`,
      encryptedCustomerExternalId: `encrypted-owner-${index + 1}`,
      status: index === 0 ? "waiting_human" : "ai_active",
      unreadCount: index === 1 ? 1 : 0,
      lastInboundAt: new Date(NOW.getTime() + index * 1_000),
      createdAt: NOW,
      updatedAt: new Date(NOW.getTime() + index * 1_000),
    }));
    await db.insert(supportConversations).values([
      ...conversations,
      {
        id: "other-owner-conversation",
        ownerEmail: "other@example.com",
        platformConnectionId: "22222222-2222-4222-8222-222222222222",
        platform: "line",
        customerLookupKey: "other-customer",
        encryptedCustomerExternalId: "encrypted-other",
        status: "waiting_human",
        unreadCount: 99,
        lastInboundAt: LATER,
        createdAt: NOW,
        updatedAt: LATER,
      },
    ]);

    const firstPage = await repository.listInboxConversations(" OWNER@EXAMPLE.COM ");

    assert.equal(firstPage.length, 31);
    assert.equal(firstPage[0].id, "conversation-36");
    assert.equal(firstPage[1].id, "conversation-35");
    assert.equal(firstPage.some(({ id }) => id === "other-owner-conversation"), false);
    const lastVisible = firstPage[29];
    const secondPage = await repository.listInboxConversations("owner@example.com", {
      cursor: {
        updatedAt: lastVisible.updatedAt.getTime(),
        id: lastVisible.id,
      },
    });
    assert.equal(secondPage.length, 6);
    assert.deepEqual(
      secondPage.map(({ id }) => id),
      conversations.map(({ id }) => id)
        .filter((id) => !firstPage.slice(0, 30).some((row) => row.id === id))
        .reverse(),
    );
  });
});

test("inbox summaries enrich a bounded page in one query without exposing persistence-only fields", async () => {
  await withDatabase(async (db, { createLoggedDb }) => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    await db.insert(supportConversations).values({
      id: "conversation-summary",
      ownerEmail: "owner@example.com",
      platformConnectionId: connectionId,
      platform: "line",
      customerLookupKey: "customer-summary",
      encryptedCustomerExternalId: "encrypted-customer-id",
      status: "resolve_pending",
      unreadCount: 2,
      pendingTransitionId: "transition-summary",
      lastInboundAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(supportMessages).values([
      messageRecord("message-old", "conversation-summary", NOW, "old"),
      messageRecord("message-new", "conversation-summary", LATER, "latest"),
    ]);
    await db.insert(supportWebhookEvents).values({
      id: "event-summary",
      platformConnectionId: connectionId,
      webhookEventId: "webhook-summary",
      sourceType: "user",
      processingStatus: "processed",
      receivedAt: NOW,
      createdAt: NOW,
    });
    await db.insert(supportOutboundDeliveries).values({
      id: "delivery-summary",
      webhookEventId: "event-summary",
      conversationId: "conversation-summary",
      encryptedRecipient: "encrypted-recipient",
      encryptedCanonicalBody: "encrypted-body",
      retryKey: "retry-summary",
      deliveryStatus: "failed",
      createdAt: NOW,
    });
    await db.insert(supportConversationTransitions).values({
      id: "transition-summary",
      conversationId: "conversation-summary",
      requestedAction: "resolve",
      fromStatus: "human_active",
      toStatus: "resolve_pending",
      requestedByOwnerEmail: "owner@example.com",
      expectedVersion: 0,
      requestedAt: NOW,
      effectiveAt: LATER,
      createdAt: NOW,
    });
    const queries = [];
    const repository = createSupportRepository(createLoggedDb({
      logQuery(query) {
        queries.push(query);
      },
    }), { encryptionKey: SETTINGS_ENCRYPTION_KEY });

    const [summary] = await repository.listInboxConversations("owner@example.com");

    assert.equal(queries.length, 1);
    assert.match(queries[0], /limit\s+\?/i);
    assert.equal(summary.lastMessagePreview, "latest");
    assert.equal(summary.deliveryFailed, true);
    assert.deepEqual(summary.pendingTransition, {
      id: "transition-summary",
      action: "resolve",
      effectiveAt: LATER,
    });
    for (const forbidden of [
      "ownerEmail",
      "platformConnectionId",
      "customerLookupKey",
      "encryptedCustomerExternalId",
      "encryptedRecipient",
      "encryptedCanonicalBody",
    ]) {
      assert.equal(Object.hasOwn(summary, forbidden), false);
    }
  });
});

test("conversation detail returns only the 100 most recent messages and 50 decisions", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const connectionId = "11111111-1111-4111-8111-111111111111";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    await db.insert(supportConversations).values({
      id: "conversation-detail",
      ownerEmail: "owner@example.com",
      platformConnectionId: connectionId,
      platform: "line",
      customerLookupKey: "customer-detail",
      encryptedCustomerExternalId: "encrypted-detail",
      status: "ai_active",
      unreadCount: 0,
      lastInboundAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const messages = Array.from({ length: 105 }, (_, index) => (
      messageRecord(
        `message-${String(index + 1).padStart(3, "0")}`,
        "conversation-detail",
        new Date(NOW.getTime() + index * 1_000),
        `message ${index + 1}`,
      )
    ));
    await db.insert(supportMessages).values(messages);
    await db.insert(supportAiDecisions).values(Array.from({ length: 55 }, (_, index) => ({
      id: `decision-${String(index + 1).padStart(3, "0")}`,
      conversationId: "conversation-detail",
      inboundMessageId: messages[index].id,
      action: "reply",
      category: "general",
      reasonCode: "faq_match",
      faqIdsJson: "[]",
      promptVersion: "v1",
      createdAt: new Date(NOW.getTime() + index * 1_000),
    })));

    const detail = await repository.getInboxConversation("owner@example.com", "conversation-detail");

    assert.equal(detail.messages.length, 100);
    assert.equal(detail.messages[0].id, "message-006");
    assert.equal(detail.messages.at(-1).id, "message-105");
    assert.equal(detail.lastMessagePreview, "message 105");
    assert.equal(detail.decisions.length, 50);
    assert.equal(detail.decisions[0].id, "decision-055");
    assert.equal(detail.decisions.at(-1).id, "decision-006");
    assert.equal(JSON.stringify(detail).includes("encrypted-detail"), false);
  });
});

test("configuration lookups and mutations stay scoped to the normalized owner", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db);
    await db.insert(platformConnections).values([
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
      connection("22222222-2222-4222-8222-222222222222", "other@example.com"),
    ]);

    assert.equal(
      (await repository.findOwnedLineConnection(" OWNER@EXAMPLE.COM ", "11111111-1111-4111-8111-111111111111")).id,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(
      await repository.findOwnedLineConnection("owner@example.com", "22222222-2222-4222-8222-222222222222"),
      null,
    );
    assert.equal(await repository.createConfiguration("owner@example.com", {
      ...configurationRecord(),
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      platformConnectionId: "22222222-2222-4222-8222-222222222222",
    }), null);

    const created = await repository.createConfiguration(" OWNER@EXAMPLE.COM ", configurationRecord());
    assert.equal(created.ownerEmail, "owner@example.com");
    assert.equal(await repository.getConfiguration("other@example.com"), null);
    assert.equal((await repository.getConfiguration("owner@example.com")).id, created.id);

    assert.equal(
      await repository.updateConfiguration("other@example.com", created.id, { brandName: "Stolen" }),
      null,
    );
    assert.equal(
      (await repository.updateConfiguration("owner@example.com", created.id, { brandName: "Updated" })).brandName,
      "Updated",
    );
    const versioned = await repository.updateConfiguration(
      "owner@example.com",
      created.id,
      { brandName: "Version one", version: 1 },
      { expectedVersion: 0 },
    );
    assert.equal(versioned.brandName, "Version one");
    assert.equal(versioned.version, 1);
    assert.equal(
      await repository.updateConfiguration(
        "owner@example.com",
        created.id,
        { brandName: "Stale write", version: 2 },
        { expectedVersion: 0 },
      ),
      null,
    );
    assert.equal((await repository.getConfiguration("owner@example.com")).brandName, "Version one");
    const protectedRecord = await repository.updateConfiguration("owner@example.com", created.id, {
      id: "changed-id",
      ownerEmail: "other@example.com",
      brandName: "Still owned",
    });
    assert.equal(protectedRecord.id, created.id);
    assert.equal(protectedRecord.ownerEmail, "owner@example.com");
    assert.equal(protectedRecord.brandName, "Still owned");
    assert.equal(
      await repository.updateConfiguration("owner@example.com", created.id, {
        platformConnectionId: "22222222-2222-4222-8222-222222222222",
      }),
      null,
    );
    assert.equal((await repository.getConfiguration("owner@example.com")).platformConnectionId, created.platformConnectionId);
  });
});

test("LINE ingress persists encrypted identities atomically and cancels only the affected conversation transition", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    await db.insert(platformConnections).values([
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
      connection("22222222-2222-4222-8222-222222222222", "owner@example.com"),
    ]);

    const first = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-1",
      externalUserId: "private-user-id",
      replyToken: "private-reply-token",
      message: { type: "text", text: "private message", safeMetadata: {} },
      receivedAt: NOW,
    });
    assert.equal(first.inserted, true);

    const [event] = await db.select().from(supportWebhookEvents);
    const [conversation] = await db.select().from(supportConversations);
    const [message] = await db.select().from(supportMessages);
    assert.equal(event.encryptedReplyToken.includes("private-reply-token"), false);
    assert.equal(conversation.encryptedCustomerExternalId.includes("private-user-id"), false);
    assert.equal(message.textContent, "private message");

    const transition = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      conversationId: conversation.id,
      requestedAction: "resolve",
      fromStatus: "ai_active",
      toStatus: "resolve_pending",
      requestedByOwnerEmail: "owner@example.com",
      expectedVersion: 0,
      requestedAt: NOW,
      effectiveAt: LATER,
      cancelledAt: null,
      committedAt: null,
      createdAt: NOW,
    };
    await db.insert(supportConversationTransitions).values(transition);
    await db.update(supportConversations).set({
      pendingTransitionId: transition.id,
      pendingAction: "resolve",
      pendingActionEffectiveAt: LATER,
    }).where(eq(supportConversations.id, conversation.id));

    const second = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-2",
      externalUserId: "private-user-id",
      replyToken: "private-reply-token-2",
      message: { type: "image", text: null, safeMetadata: { type: "image" }, handoffReasonCode: "non_text" },
      receivedAt: LATER,
    });
    assert.equal(second.inserted, true);
    assert.equal((await db.select().from(supportConversationTransitions))[0].cancelledAt.toISOString(), LATER.toISOString());
    const updated = (await db.select().from(supportConversations))[0];
    assert.equal(updated.pendingTransitionId, null);
    assert.equal(updated.status, "ai_active");
    assert.equal(updated.version, 1);

    const otherConnection = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "22222222-2222-4222-8222-222222222222",
      eventId: "evt-1",
      externalUserId: "private-user-id",
      replyToken: "another-private-reply-token",
      message: { type: "text", text: "other connection", safeMetadata: {} },
      receivedAt: LATER,
    });
    assert.notEqual(otherConnection.conversationId, first.conversationId);
    assert.equal((await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-1",
      externalUserId: "private-user-id",
      replyToken: "duplicate-private-reply-token",
      message: { type: "text", text: "must not persist", safeMetadata: {} },
      receivedAt: LATER,
    })).inserted, false);
    assert.equal((await db.select().from(supportMessages)).length, 3);
  });
});

test("human-owned inbound stays human-owned and cannot be replayed after return to AI", async () => {
  await withDatabase(async (db) => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const initial = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-human-initial",
      externalUserId: "private-user-id", replyToken: "reply-token",
      message: { type: "text", text: "initial", safeMetadata: {} }, receivedAt: NOW,
    });
    await db.update(supportConversations).set({ status: "human_active" })
      .where(eq(supportConversations.id, initial.conversationId));

    const pending = await repository.requestSupportTransition(
      "owner@example.com", initial.conversationId, "resolve", 0, NOW, "transition-resolve",
    );
    assert.ok(pending);
    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-during-pending",
      externalUserId: "private-user-id", replyToken: "reply-token-2",
      message: { type: "text", text: "human-owned pending", safeMetadata: {} }, receivedAt: LATER,
    });

    let [conversation] = await db.select().from(supportConversations)
      .where(eq(supportConversations.id, initial.conversationId));
    assert.equal(conversation.status, "human_active");
    assert.equal(conversation.pendingTransitionId, null);
    let [pendingMessage] = await db.select().from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `${connectionId}:evt-during-pending`));
    assert.equal(pendingMessage.processedAt.toISOString(), LATER.toISOString());
    let [pendingEvent] = await db.select().from(supportWebhookEvents)
      .where(eq(supportWebhookEvents.webhookEventId, "evt-during-pending"));
    assert.equal(pendingEvent.processingStatus, "processed");
    assert.equal((await repository.claimLineWorkflowDispatch({
      connectionId, eventId: "evt-during-pending", now: LATER,
    })).claimed, false);

    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-human-active",
      externalUserId: "private-user-id", replyToken: "reply-token-3",
      message: { type: "text", text: "still human-owned", safeMetadata: {} }, receivedAt: LATER,
    });
    const [humanMessage] = await db.select().from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `${connectionId}:evt-human-active`));
    assert.ok(humanMessage.processedAt);

    await db.update(supportConversations).set({ status: "resolved" })
      .where(eq(supportConversations.id, initial.conversationId));
    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-reopen",
      externalUserId: "private-user-id", replyToken: "reply-token-4",
      message: { type: "text", text: "new AI turn", safeMetadata: {} }, receivedAt: LATER,
    });
    [conversation] = await db.select().from(supportConversations)
      .where(eq(supportConversations.id, initial.conversationId));
    assert.equal(conversation.status, "ai_active");
    const [reopenedMessage] = await db.select().from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `${connectionId}:evt-reopen`));
    assert.equal(reopenedMessage.processedAt, null);
  });
});

test("support transitions require an unfenced human-active conversation", async () => {
  await withDatabase(async (db) => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-transition-matrix",
      externalUserId: "private-user-id", replyToken: "reply-token",
      message: { type: "text", text: "question", safeMetadata: {} }, receivedAt: NOW,
    });

    for (const status of ["ai_active", "waiting_human", "resolved"]) {
      await db.update(supportConversations).set({ status, pendingTransitionId: null })
        .where(eq(supportConversations.id, ingested.conversationId));
      assert.equal(await repository.requestSupportTransition(
        "owner@example.com", ingested.conversationId, "resolve", 0, NOW, `transition-${status}`,
      ), null);
    }
    await db.update(supportConversations).set({ status: "human_active" })
      .where(eq(supportConversations.id, ingested.conversationId));
    assert.ok(await repository.requestSupportTransition(
      "owner@example.com", ingested.conversationId, "return_to_ai", 0, NOW, "transition-valid",
    ));
  });
});

test("workflow dispatch claims are retryable, exclusive, and safely recover after lease expiry", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    await db.insert(platformConnections).values(
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
    );
    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      externalUserId: "private-user-id",
      replyToken: "private-reply-token",
      message: { type: "text", text: "private message", safeMetadata: {} },
      receivedAt: NOW,
    });

    const first = await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      now: NOW,
    });
    assert.equal(first.claimed, true);
    assert.equal((await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      now: NOW,
    })).claimed, false);
    await repository.releaseLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      claimId: first.claimId,
    });

    const retry = await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      now: LATER,
    });
    assert.equal(retry.claimed, true);
    await repository.markLineWorkflowDispatched({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      claimId: retry.claimId,
      now: LATER,
    });
    assert.equal((await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-1",
      now: LATER,
    })).claimed, false);

    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-stale",
      externalUserId: "private-user-2",
      replyToken: "private-reply-token-2",
      message: { type: "text", text: "private message", safeMetadata: {} },
      receivedAt: NOW,
    });
    const stale = await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-stale",
      now: NOW,
    });
    const reclaimed = await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-stale",
      now: new Date(NOW.getTime() + 31_000),
    });
    assert.equal(reclaimed.claimed, true);
    assert.notEqual(reclaimed.claimId, stale.claimId);
    await repository.releaseLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-stale",
      claimId: stale.claimId,
    });
    await repository.markLineWorkflowDispatched({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-dispatch-stale",
      claimId: reclaimed.claimId,
      now: LATER,
    });
    const events = await db.select().from(supportWebhookEvents);
    assert.deepEqual(events.map(({ processingStatus }) => processingStatus).sort(), ["dispatched", "dispatched"]);
  });
});

test("event-processing claims fence duplicate workflow runs, release failures, and completed events", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    await db.insert(platformConnections).values(
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
    );
    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-process-1",
      externalUserId: "private-user-id",
      replyToken: "private-reply-token",
      message: { type: "text", text: "private message", safeMetadata: {} },
      receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-process-1",
      now: NOW,
    });
    await repository.markLineWorkflowDispatched({
      connectionId: dispatch.connectionId,
      eventId: dispatch.eventId,
      claimId: dispatch.claimId,
      now: NOW,
    });

    const first = await repository.claimLineEventProcessing({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-process-1",
      now: NOW,
    });
    assert.equal(first.claimed, true);
    assert.equal((await repository.claimLineEventProcessing({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-process-1",
      now: NOW,
    })).claimed, false);
    assert.equal(await repository.releaseLineEventProcessing({
      connectionId: first.connectionId,
      eventId: first.eventId,
      claimId: first.claimId,
    }), true);

    const retry = await repository.claimLineEventProcessing({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-process-1",
      now: LATER,
    });
    assert.equal(retry.claimed, true);
    assert.equal(await repository.markLineEventProcessed({
      connectionId: retry.connectionId,
      eventId: retry.eventId,
      claimId: retry.claimId,
      now: LATER,
    }), true);
    assert.equal((await repository.claimLineEventProcessing({
      connectionId: "11111111-1111-4111-8111-111111111111",
      eventId: "evt-process-1",
      now: LATER,
    })).claimed, false);
  });
});

test("an expired duplicate workflow reuses one immutable UUID outbound delivery and routes a 24-hour unknown to review", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const eventId = "evt-outbox-1";
    const body = "{\"to\":\"private-user-id\",\"messages\":[{\"type\":\"text\",\"text\":\"first decision\"}]}";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId,
      externalUserId: "private-user-id", replyToken: "private-reply-token",
      message: { type: "text", text: "private message", safeMetadata: {} }, receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const firstProcessing = await repository.claimLineEventProcessing({ connectionId, eventId, now: NOW });
    const first = await repository.createLineOutboundDelivery({
      connectionId, eventId, conversationId: ingested.conversationId, claimId: firstProcessing.claimId,
      recipient: "private-user-id", canonicalBody: body, now: NOW,
    });
    assert.equal(first.created, true);
    assert.match(first.retryKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const resumedAt = new Date(NOW.getTime() + 31_000);
    const resumedProcessing = await repository.claimLineEventProcessing({ connectionId, eventId, now: resumedAt });
    const duplicate = await repository.createLineOutboundDelivery({
      connectionId, eventId, conversationId: ingested.conversationId, claimId: resumedProcessing.claimId,
      recipient: "private-user-id",
      canonicalBody: "{\"to\":\"private-user-id\",\"messages\":[{\"type\":\"text\",\"text\":\"second decision must not replace first\"}]}",
      now: resumedAt,
    });
    assert.deepEqual(duplicate, { created: false, deliveryId: first.deliveryId, retryKey: first.retryKey });
    assert.equal((await db.select().from(supportOutboundDeliveries)).length, 1);
    const [stored] = await db.select().from(supportOutboundDeliveries);
    assert.equal(stored.encryptedRecipient.includes("private-user-id"), false);
    assert.equal(stored.encryptedCanonicalBody.includes("first decision"), false);

    const conversationClaim = await repository.acquireConversationClaim({
      connectionId,
      eventId,
      eventClaimId: resumedProcessing.claimId,
      conversationId: ingested.conversationId,
      now: resumedAt,
    });
    const reviewAt = new Date(resumedAt.getTime() + (24 * 60 * 60 * 1_000) + 1);
    await db.update(supportWebhookEvents).set({ processedAt: new Date(reviewAt.getTime() + 30_000) })
      .where(eq(supportWebhookEvents.webhookEventId, eventId));
    await db.update(supportConversations).set({ processingClaimExpiresAt: new Date(reviewAt.getTime() + 30_000) })
      .where(eq(supportConversations.id, ingested.conversationId));
    const ownership = automatedDeliveryOwnership({
      connectionId,
      eventId,
      eventClaimId: resumedProcessing.claimId,
      conversationId: ingested.conversationId,
      conversationClaimId: conversationClaim.claimId,
    });
    const delivery = await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: first.deliveryId, now: resumedAt,
    });
    assert.equal(delivery.claimed, true);
    assert.equal(delivery.retryKey, first.retryKey);
    assert.equal(delivery.canonicalBody, body);
    assert.equal((await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: first.deliveryId, now: reviewAt,
    })).status, "human_review");
    assert.equal((await db.select().from(supportOutboundDeliveries))[0].retryKey, first.retryKey);
  });
});

test("FAQ mutations require both normalized owner and FAQ id", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db);
    const faq = await repository.createFaq(" OWNER@EXAMPLE.COM ", faqRecord());
    await repository.createFaq("other@example.com", {
      ...faqRecord(),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      question: "Other question",
    });

    assert.deepEqual((await repository.listFaqs("owner@example.com")).map(({ id }) => id), [faq.id]);
    assert.equal(await repository.updateFaq("other@example.com", faq.id, { answer: "stolen" }), null);
    const protectedFaq = await repository.updateFaq("owner@example.com", faq.id, {
      id: "changed-id",
      ownerEmail: "other@example.com",
      answer: "updated",
    });
    assert.equal(protectedFaq.id, faq.id);
    assert.equal(protectedFaq.ownerEmail, "owner@example.com");
    assert.equal(protectedFaq.answer, "updated");
    assert.equal(await repository.deleteFaq("other@example.com", faq.id), null);
    assert.equal((await repository.deleteFaq("owner@example.com", faq.id)).id, faq.id);
    assert.deepEqual(await repository.listFaqs("owner@example.com"), []);
  });
});

test("webhook verification writes require the prepared version and key hash", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db);
    await db.insert(platformConnections).values(
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
    );
    await repository.createConfiguration("owner@example.com", configurationRecord());

    assert.equal(
      await repository.updateConfiguration(
        "owner@example.com",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { webhookVerifiedAt: LATER, version: 1 },
        { expectedVersion: 0, expectedWebhookKeyHash: "wrong-hash" },
      ),
      null,
    );
    const updated = await repository.updateConfiguration(
      "owner@example.com",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { webhookVerifiedAt: LATER, version: 1 },
      { expectedVersion: 0, expectedWebhookKeyHash: "secret-hash" },
    );
    assert.equal(updated.webhookVerifiedAt.toISOString(), LATER.toISOString());
    assert.equal(updated.version, 1);
  });
});

test("atomic enable rejects an FAQ disabled after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(supportFaqs).set({ enabled: false, updatedAt: LATER })
      .where(eq(supportFaqs.id, "ffffffff-ffff-4fff-8fff-ffffffffffff"));
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable rejects a provider key removed after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(userSettings).set({
      encryptedSettings: encryptJson({}, SETTINGS_ENCRYPTION_KEY),
      updatedAt: LATER,
    }).where(eq(userSettings.ownerEmail, "owner@example.com"));
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable rejects the configured LINE connection becoming inactive after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(platformConnections).set({
      state: "needs_reconnect",
      updatedAt: LATER,
    }).where(eq(platformConnections.id, "11111111-1111-4111-8111-111111111111"));
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable rejects replacement of the configured LINE default after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(platformConnections).set({
      state: "archived",
      updatedAt: LATER,
    }).where(eq(platformConnections.id, "11111111-1111-4111-8111-111111111111"));
    await secondaryDb.insert(platformConnections).values(
      connection("22222222-2222-4222-8222-222222222222", "owner@example.com"),
    );
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable accepts rotation to another current non-empty provider key", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(userSettings).set({
      encryptedSettings: encryptJson({ googleAiApiKey: "rotated-key" }, SETTINGS_ENCRYPTION_KEY),
      updatedAt: LATER,
    }).where(eq(userSettings.ownerEmail, "owner@example.com"));
    interleaving.release();

    const enabled = await enabling;
    assert.equal(enabled.supportState, "enabled");
    assert.equal(enabled.version, 1);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "enabled");
  });
});

test("processing claims batch current protected data and atomically persist one decision with its immutable Push outbox", async () => {
  await withDatabase(async (db) => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    await db.insert(platformConnections).values({
      ...connection(connectionId, "owner@example.com"),
      encryptedCredentials: encryptJson({ accessToken: "private-line-token" }, SETTINGS_ENCRYPTION_KEY),
    });
    await db.insert(supportConfigurations).values({ ...configurationRecord(), supportState: "enabled" });
    await db.insert(userSettings).values({
      ownerEmail: "owner@example.com",
      encryptedSettings: encryptJson({ googleAiApiKey: "private-ai-key" }, SETTINGS_ENCRYPTION_KEY),
      updatedAt: NOW,
    });
    await db.insert(supportFaqs).values({ ...faqRecord(), ownerEmail: "owner@example.com" });
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-turn-1", externalUserId: "U-private",
      replyToken: "reply-token", message: { type: "text", text: "Question", safeMetadata: {} }, receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId: "evt-turn-1", now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId: "evt-turn-1", now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({ connectionId, conversationId: ingested.conversationId, now: NOW });
    assert.equal(conversationClaim.acquired, true);
    assert.equal((await repository.acquireConversationClaim({ connectionId, conversationId: ingested.conversationId, now: NOW })).acquired, false);
    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-turn-2", externalUserId: "U-private",
      replyToken: "reply-token-2", message: { type: "text", text: "Second question", safeMetadata: {} },
      receivedAt: new Date(NOW.getTime() + 1_000),
    });
    const dispatchTwo = await repository.claimLineWorkflowDispatch({ connectionId, eventId: "evt-turn-2", now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatchTwo, now: NOW });
    const competingEventClaim = await repository.claimLineEventProcessing({ connectionId, eventId: "evt-turn-2", now: NOW });

    const turn = await repository.buildClaimedTurn({
      connectionId, eventId: "evt-turn-1", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      cutoff: new Date(NOW.getTime() + 3_000),
    });
    assert.deepEqual(turn, { inboundMessageId: turn.inboundMessageId });
    const context = await repository.loadCurrentProcessingContext({
      connectionId, eventId: "evt-turn-1", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      cutoff: new Date(NOW.getTime() + 3_000),
    });
    assert.equal(context.settings.googleAiApiKey, "private-ai-key");
    assert.equal(context.recipient, "U-private");
    assert.deepEqual(context.faqs.map(({ id }) => id), ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    assert.deepEqual(context.customerTexts, ["Question", "Second question"]);
    await db.insert(supportMessages).values({
      id: "old-context-message", conversationId: ingested.conversationId, direction: "inbound", senderType: "customer",
      messageType: "text", textContent: "outside retention", safeMetadataJson: "{}", providerMessageId: null,
      deliveryStatus: "received", idempotencyKey: "old-context-event", sentAt: null, failedAt: null,
      safeErrorCode: null, processedAt: NOW, createdAt: new Date(NOW.getTime() - (31 * 24 * 60 * 60 * 1_000)),
    });
    const retainedContext = await repository.loadCurrentProcessingContext({
      connectionId, conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      cutoff: new Date(NOW.getTime() + 3_000), now: NOW,
    });
    assert.equal(retainedContext.messages.some(({ text }) => text === "outside retention"), false);

    const persisted = await repository.persistDecisionAndOutbound({
      connectionId, eventId: "evt-turn-1", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      eventClaimId: eventClaim.claimId,
      inboundMessageId: turn.inboundMessageId,
      cutoff: new Date(NOW.getTime() + 3_000),
      decision: { action: "reply", answer: "Answer", category: "general", handoffReasonCode: null, knowledgeSourceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      canonicalBody: "{\"to\":\"U-private\",\"messages\":[{\"type\":\"text\",\"text\":\"Answer\"}]}", now: NOW,
    });
    assert.ok(persisted.deliveryId);
    assert.equal((await db.select().from(supportAiDecisions)).length, 1);
    assert.equal((await db.select().from(supportOutboundDeliveries)).length, 1);
    const [ownedCompanion] = await db.select().from(supportWebhookEvents)
      .where(eq(supportWebhookEvents.webhookEventId, "evt-turn-2"));
    assert.equal(ownedCompanion.processingStatus, "processing");
    assert.equal(await repository.resolveLineEventAfterConversationLoss({
      connectionId, eventId: "evt-turn-2", conversationId: ingested.conversationId,
      claimId: competingEventClaim.claimId, now: NOW,
    }), true);
    assert.equal(await repository.markLineEventProcessed({
      connectionId, eventId: "evt-turn-2", claimId: competingEventClaim.claimId, now: NOW,
    }), false);
    assert.equal(await repository.loadLineAccessToken(connectionId), "private-line-token");
    assert.deepEqual(await repository.handleLineCredentialRejected({
      connectionId, conversationId: ingested.conversationId, eventId: "evt-turn-1", eventClaimId: eventClaim.claimId,
      claimId: conversationClaim.claimId, now: NOW,
    }), { eventCompleted: true });
    assert.equal((await db.select().from(platformConnections).where(eq(platformConnections.id, connectionId)))[0].state, "needs_reconnect");
    const [handoffConversation] = await db.select().from(supportConversations).where(eq(supportConversations.id, ingested.conversationId));
    assert.equal(handoffConversation.status, "waiting_human");
    assert.equal(handoffConversation.handoffReasonCode, "credential_rejected");
    assert.equal(handoffConversation.version, 2);
    const credentialAudit = (await db.select().from(supportAiDecisions))
      .find(({ action }) => action === "handoff");
    assert.equal(credentialAudit.reasonCode, "credential_rejected");
    assert.equal(credentialAudit.answerMessageId, null);
    assert.equal(await repository.handleLineCredentialRejected({
      connectionId, conversationId: ingested.conversationId, eventId: "evt-turn-1", eventClaimId: eventClaim.claimId,
      claimId: conversationClaim.claimId, now: NOW,
    }), false);
    assert.equal(await repository.markLineEventProcessed({ connectionId, eventId: "evt-turn-1", claimId: eventClaim.claimId, now: NOW }), false);
  });
});

test("a handoff atomically consumes its batch and resolves dispatched companion events", async () => {
  await withDatabase(async (db) => {
    const connectionId = "44444444-4444-4444-8444-444444444444";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const primary = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-handoff-1", externalUserId: "U-private",
      replyToken: "reply-token", message: { type: "text", text: "Human please", safeMetadata: {} }, receivedAt: NOW,
    });
    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-handoff-2", externalUserId: "U-private",
      replyToken: "reply-token-2", message: { type: "text", text: "Second message", safeMetadata: {} },
      receivedAt: new Date(NOW.getTime() + 1_000),
    });
    for (const eventId of ["evt-handoff-1", "evt-handoff-2"]) {
      const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
      await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    }
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId: "evt-handoff-1", now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({
      connectionId, conversationId: primary.conversationId, now: NOW,
    });
    const cutoff = new Date(NOW.getTime() + 3_000);
    const [triggeringMessage] = await db.select({ id: supportMessages.id }).from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `${connectionId}:evt-handoff-1`));

    assert.deepEqual(await repository.persistHandoff({
      connectionId, eventId: "evt-handoff-1", eventClaimId: eventClaim.claimId,
      conversationId: primary.conversationId, claimId: conversationClaim.claimId,
      inboundMessageId: triggeringMessage.id,
      cutoff, reasonCode: "explicit_human", now: NOW,
    }), { eventCompleted: true });

    const messages = await db.select().from(supportMessages)
      .where(eq(supportMessages.conversationId, primary.conversationId));
    assert.equal(messages.every(({ processedAt }) => processedAt?.getTime() === cutoff.getTime()), true);
    const events = await db.select().from(supportWebhookEvents)
      .where(eq(supportWebhookEvents.platformConnectionId, connectionId));
    assert.deepEqual(events.map(({ processingStatus }) => processingStatus).sort(), ["processed", "processed"]);
    assert.equal(await repository.findNextUnprocessedEvent({
      connectionId, conversationId: primary.conversationId,
    }), null);
  });
});

test("a consumed losing event is completed once by its repository resolution", async () => {
  await withDatabase(async (db) => {
    const connectionId = "22222222-2222-4222-8222-222222222222";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-loser", externalUserId: "U-private",
      replyToken: "reply-token", message: { type: "text", text: "Question", safeMetadata: {} }, receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId: "evt-loser", now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId: "evt-loser", now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({ connectionId, conversationId: ingested.conversationId, now: NOW });
    await repository.buildClaimedTurn({
      connectionId, eventId: "evt-loser", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      cutoff: new Date(NOW.getTime() + 3_000),
    });
    await db.update(supportMessages).set({ processedAt: new Date(NOW.getTime() + 3_000) }).where(eq(
      supportMessages.idempotencyKey,
      `${connectionId}:evt-loser`,
    ));

    assert.equal(await repository.resolveLineEventAfterConversationLoss({
      connectionId, eventId: "evt-loser", conversationId: ingested.conversationId, claimId: eventClaim.claimId,
      now: new Date(NOW.getTime() + 31_000),
    }), false);

    assert.equal(await repository.resolveLineEventAfterConversationLoss({
      connectionId, eventId: "evt-loser", conversationId: ingested.conversationId, claimId: eventClaim.claimId, now: NOW,
    }), true);
    assert.equal(await repository.markLineEventProcessed({
      connectionId, eventId: "evt-loser", claimId: eventClaim.claimId, now: NOW,
    }), false);
    const [event] = await db.select().from(supportWebhookEvents).where(eq(supportWebhookEvents.webhookEventId, "evt-loser"));
    assert.equal(event.processingStatus, "processed");
  });
});

test("AI delivery terminal state is transactionally mirrored to its message and accepted delivery alone advances last outbound", async () => {
  await withDatabase(async (db) => {
    const connectionId = "55555555-5555-4555-8555-555555555555";
    const eventId = "evt-ai-delivery-truth";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId, externalUserId: "U-private",
      replyToken: "reply-token", message: { type: "text", text: "Question", safeMetadata: {} }, receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId, now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({
      connectionId, conversationId: ingested.conversationId, now: NOW,
    });
    const persisted = await repository.persistDecisionAndOutbound({
      connectionId, eventId, eventClaimId: eventClaim.claimId, conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId, inboundMessageId: (await repository.buildClaimedTurn({
        connectionId, eventId, conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
        cutoff: new Date(NOW.getTime() + 3_000),
      })).inboundMessageId,
      cutoff: new Date(NOW.getTime() + 3_000),
      decision: { action: "reply", answer: "Answer", category: "general", knowledgeSourceIds: ["faq-1"] },
      canonicalBody: '{"to":"U-private","messages":[{"type":"text","text":"Answer"}]}',
      now: NOW,
    });
    let [conversation] = await db.select().from(supportConversations)
      .where(eq(supportConversations.id, ingested.conversationId));
    assert.equal(conversation.lastOutboundAt, null);

    const claim = await repository.claimLineOutboundDelivery({
      ...automatedDeliveryOwnership({
        connectionId,
        eventId,
        eventClaimId: eventClaim.claimId,
        conversationId: ingested.conversationId,
        conversationClaimId: conversationClaim.claimId,
      }),
      deliveryId: persisted.deliveryId,
      now: NOW,
    });
    const acceptedAt = new Date(NOW.getTime() + 1_000);
    assert.equal(await repository.markLineOutboundDeliverySent({
      deliveryId: persisted.deliveryId, claimId: claim.claimId, acceptedRequestId: "accepted-1", now: acceptedAt,
    }), true);
    const [delivery] = await db.select().from(supportOutboundDeliveries)
      .where(eq(supportOutboundDeliveries.id, persisted.deliveryId));
    const [message] = await db.select().from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `ai:${connectionId}:${eventId}`));
    [conversation] = await db.select().from(supportConversations)
      .where(eq(supportConversations.id, ingested.conversationId));
    assert.equal(delivery.deliveryStatus, "sent");
    assert.equal(message.deliveryStatus, "sent");
    assert.equal(message.sentAt.getTime(), acceptedAt.getTime());
    assert.equal(message.failedAt, null);
    assert.equal(message.safeErrorCode, null);
    assert.equal(conversation.lastOutboundAt.getTime(), acceptedAt.getTime());
  });
});

test("an expired outbound claim cannot report success and a newer terminal claim remains monotonic", async () => {
  await withDatabase(async (db) => {
    const connectionId = "66666666-6666-4666-8666-666666666666";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    await db.insert(supportConversations).values({
      id: "conversation-stale-delivery", ownerEmail: "owner@example.com", platformConnectionId: connectionId,
      platform: "line", customerLookupKey: "stale", encryptedCustomerExternalId: "encrypted",
      status: "ai_active", processingClaimId: "conversation-claim",
      processingClaimExpiresAt: new Date(NOW.getTime() + 120_000), createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(supportWebhookEvents).values({
      id: "event-stale-delivery", platformConnectionId: connectionId, webhookEventId: "evt-stale-delivery",
      sourceType: "user", processingStatus: "processing", safeErrorCode: "event-claim",
      processedAt: new Date(NOW.getTime() + 120_000), receivedAt: NOW, createdAt: NOW,
    });
    await db.insert(supportMessages).values({
      id: "message-stale-delivery", conversationId: "conversation-stale-delivery", direction: "outbound",
      senderType: "ai", messageType: "text", textContent: "immutable", safeMetadataJson: "{}",
      deliveryStatus: "pending", idempotencyKey: `ai:${connectionId}:evt-stale-delivery`, createdAt: NOW,
    });
    await db.insert(supportOutboundDeliveries).values({
      id: "delivery-stale", webhookEventId: "event-stale-delivery", conversationId: "conversation-stale-delivery",
      encryptedRecipient: encryptExternalId("U-private", SETTINGS_ENCRYPTION_KEY),
      encryptedCanonicalBody: encryptOutboundCanonicalBody('{"to":"U-private","messages":[{"type":"text","text":"immutable"}]}', SETTINGS_ENCRYPTION_KEY),
      retryKey: "retry-stale",
      deliveryStatus: "pending", createdAt: NOW,
    });
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ownership = automatedDeliveryOwnership({
      connectionId,
      eventId: "evt-stale-delivery",
      eventClaimId: "event-claim",
      conversationId: "conversation-stale-delivery",
      conversationClaimId: "conversation-claim",
    });
    const stale = await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: "delivery-stale", now: NOW,
    });
    const reclaimedAt = new Date(NOW.getTime() + 31_000);
    const current = await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: "delivery-stale", now: reclaimedAt,
    });

    assert.equal(await repository.markLineOutboundDeliverySent({
      deliveryId: "delivery-stale", claimId: stale.claimId, now: reclaimedAt,
    }), false);
    assert.equal(await repository.markLineOutboundDeliveryFailed({
      deliveryId: "delivery-stale", claimId: current.claimId, safeErrorCode: "line_push_4xx", now: reclaimedAt,
    }), true);
    assert.equal(await repository.markLineOutboundDeliverySent({
      deliveryId: "delivery-stale", claimId: stale.claimId, now: new Date(reclaimedAt.getTime() + 1),
    }), false);
    const [message] = await db.select().from(supportMessages)
      .where(eq(supportMessages.id, "message-stale-delivery"));
    assert.equal(message.deliveryStatus, "failed");
    assert.equal(message.safeErrorCode, "line_push_4xx");
  });
});

test("the 24-hour review threshold cannot terminalize another worker's unexpired delivery claim", async () => {
  await withDatabase(async (db) => {
    const connectionId = "99999999-9999-4999-8999-999999999999";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    await db.insert(supportConversations).values({
      id: "conversation-review-fence", ownerEmail: "owner@example.com", platformConnectionId: connectionId,
      platform: "line", customerLookupKey: "review-fence", encryptedCustomerExternalId: "encrypted",
      status: "ai_active", processingClaimId: "conversation-claim",
      processingClaimExpiresAt: new Date(NOW.getTime() + (25 * 60 * 60 * 1_000)),
      createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(supportWebhookEvents).values({
      id: "event-review-fence", platformConnectionId: connectionId, webhookEventId: "evt-review-fence",
      sourceType: "user", processingStatus: "processing", safeErrorCode: "event-claim",
      processedAt: new Date(NOW.getTime() + (25 * 60 * 60 * 1_000)), receivedAt: NOW, createdAt: NOW,
    });
    await db.insert(supportOutboundDeliveries).values({
      id: "delivery-review-fence", webhookEventId: "event-review-fence",
      conversationId: "conversation-review-fence",
      encryptedRecipient: encryptExternalId("U-private", SETTINGS_ENCRYPTION_KEY),
      encryptedCanonicalBody: encryptOutboundCanonicalBody('{"to":"U-private","messages":[{"type":"text","text":"immutable"}]}', SETTINGS_ENCRYPTION_KEY),
      retryKey: "review-fence-key", deliveryStatus: "pending", createdAt: NOW,
    });
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ownership = automatedDeliveryOwnership({
      connectionId,
      eventId: "evt-review-fence",
      eventClaimId: "event-claim",
      conversationId: "conversation-review-fence",
      conversationClaimId: "conversation-claim",
    });
    await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: "delivery-review-fence", now: NOW,
    });
    const nearThreshold = new Date(NOW.getTime() + (24 * 60 * 60 * 1_000) - 1_000);
    const active = await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: "delivery-review-fence",
      now: nearThreshold,
    });
    assert.equal(active.claimed, true);

    const reviewAttempt = await repository.claimLineOutboundDelivery({
      ...ownership, deliveryId: "delivery-review-fence",
      now: new Date(NOW.getTime() + (24 * 60 * 60 * 1_000) + 1),
    });
    assert.equal(reviewAttempt.status, "sending");
    assert.equal((await db.select().from(supportOutboundDeliveries))[0].deliveryClaimId, active.claimId);
  });
});

test("automatic handoff records audit and fixed acknowledgement while retaining exact fences until terminal delivery", async () => {
  await withDatabase(async (db) => {
    const connectionId = "77777777-7777-4777-8777-777777777777";
    const eventId = "evt-handoff-durable";
    await db.insert(platformConnections).values({
      ...connection(connectionId, "owner@example.com"),
      encryptedCredentials: encryptJson({ accessToken: "line-token" }, SETTINGS_ENCRYPTION_KEY),
    });
    await db.insert(supportConfigurations).values({
      ...configurationRecord(), id: "config-handoff", platformConnectionId: connectionId,
      llmProvider: "openai", llmModel: "gpt-safe",
    });
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId, externalUserId: "U-private",
      replyToken: "reply-token", message: { type: "text", text: "Human please", safeMetadata: {} }, receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId, now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({
      connectionId, conversationId: ingested.conversationId, now: NOW,
    });
    const cutoff = new Date(NOW.getTime() + 3_000);
    const handoff = await repository.persistHandoff({
      connectionId, eventId, eventClaimId: eventClaim.claimId, conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId, inboundMessageId: (await repository.buildClaimedTurn({
        connectionId, eventId, conversationId: ingested.conversationId, claimId: conversationClaim.claimId, cutoff,
      })).inboundMessageId,
      cutoff, reasonCode: "explicit_human_request", now: NOW,
    });

    assert.ok(handoff.deliveryId);
    const [decision] = await db.select().from(supportAiDecisions);
    const [acknowledgement] = await db.select().from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `ai:${connectionId}:${eventId}`));
    let [conversation] = await db.select().from(supportConversations)
      .where(eq(supportConversations.id, ingested.conversationId));
    let [event] = await db.select().from(supportWebhookEvents)
      .where(eq(supportWebhookEvents.webhookEventId, eventId));
    assert.deepEqual({
      action: decision.action, reasonCode: decision.reasonCode, inboundMessageId: decision.inboundMessageId,
      answerMessageId: decision.answerMessageId, llmProvider: decision.llmProvider, llmModel: decision.llmModel,
    }, {
      action: "handoff", reasonCode: "explicit_human_request", inboundMessageId: decision.inboundMessageId,
      answerMessageId: null, llmProvider: "openai", llmModel: "gpt-safe",
    });
    assert.equal(acknowledgement.textContent, "已轉交人工客服，請稍候。");
    assert.equal(acknowledgement.deliveryStatus, "pending");
    assert.equal(conversation.status, "waiting_human");
    assert.equal(conversation.version, 1);
    assert.equal(conversation.processingClaimId, conversationClaim.claimId);
    assert.equal(event.processingStatus, "processing");
    assert.equal(event.safeErrorCode, eventClaim.claimId);
    assert.deepEqual(await repository.persistHandoff({
      connectionId, eventId, eventClaimId: eventClaim.claimId, conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId, inboundMessageId: decision.inboundMessageId,
      cutoff, reasonCode: "explicit_human_request", now: new Date(NOW.getTime() + 1_000),
    }), handoff);
    assert.equal((await db.select().from(supportAiDecisions)).length, 1);
    assert.equal((await db.select().from(supportOutboundDeliveries)).length, 1);
    assert.equal((await db.select().from(supportMessages)
      .where(eq(supportMessages.idempotencyKey, `ai:${connectionId}:${eventId}`))).length, 1);

    await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-after-handoff", externalUserId: "U-private",
      replyToken: "reply-token-2", message: { type: "text", text: "Are you there?", safeMetadata: {} },
      receivedAt: new Date(NOW.getTime() + 1_000),
    });
    assert.equal((await repository.claimLineWorkflowDispatch({
      connectionId, eventId: "evt-after-handoff", now: NOW,
    })).claimed, false);
    assert.equal(await repository.renewConversationClaim({
      connectionId, eventId, eventClaimId: eventClaim.claimId, conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId, now: new Date(NOW.getTime() + 1_000),
    }), true);

    const deliveryClaim = await repository.claimLineOutboundDelivery({
      ...automatedDeliveryOwnership({
        connectionId,
        eventId,
        eventClaimId: eventClaim.claimId,
        conversationId: ingested.conversationId,
        conversationClaimId: conversationClaim.claimId,
      }),
      deliveryId: handoff.deliveryId,
      now: NOW,
    });
    const terminalAt = new Date(NOW.getTime() + 2_000);
    await repository.markLineOutboundDeliverySent({
      deliveryId: handoff.deliveryId, claimId: deliveryClaim.claimId, now: terminalAt,
    });
    assert.equal(await repository.finalizeHandoffDelivery({
      connectionId, eventId, eventClaimId: eventClaim.claimId, conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId, deliveryId: handoff.deliveryId, now: terminalAt,
    }), true);
    conversation = (await db.select().from(supportConversations)
      .where(eq(supportConversations.id, ingested.conversationId)))[0];
    event = (await db.select().from(supportWebhookEvents)
      .where(eq(supportWebhookEvents.webhookEventId, eventId)))[0];
    assert.equal(conversation.processingClaimId, null);
    assert.equal(conversation.status, "waiting_human");
    assert.equal(event.processingStatus, "processed");
    assert.equal(await repository.finalizeHandoffDelivery({
      connectionId, eventId, eventClaimId: "stale", conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId, deliveryId: handoff.deliveryId, now: terminalAt,
    }), false);
  });
});

test("human delivery is monotonic and retry-by-ID rebuilds only immutable owner-scoped stored content", async () => {
  await withDatabase(async (db) => {
    const connectionId = "88888888-8888-4888-8888-888888888888";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    await db.insert(supportConversations).values({
      id: "conversation-human-retry", ownerEmail: "owner@example.com", platformConnectionId: connectionId,
      platform: "line", customerLookupKey: "human-retry",
      encryptedCustomerExternalId: encryptExternalId("U-stored", SETTINGS_ENCRYPTION_KEY),
      status: "human_active", createdAt: NOW, updatedAt: NOW,
    });
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const prepared = await repository.prepareHumanMessage(
      "owner@example.com",
      "conversation-human-retry",
      { text: "Stored reply", idempotencyKey: "browser-key" },
      NOW,
    );
    assert.equal(await repository.markHumanMessageDelivery(
      "owner@example.com", prepared.id, "sent", null, new Date(NOW.getTime() + 1_000),
    ).then((message) => message.deliveryStatus), "sent");
    assert.equal(await repository.markHumanMessageDelivery(
      "owner@example.com", prepared.id, "failed", "line_push_transport", new Date(NOW.getTime() + 2_000),
    ).then((message) => message.deliveryStatus), "sent");

    await db.update(supportMessages).set({
      deliveryStatus: "failed", sentAt: null, failedAt: new Date(NOW.getTime() + 3_000),
      safeErrorCode: "line_push_4xx",
    }).where(eq(supportMessages.id, prepared.id));
    const retry = await repository.prepareHumanMessageRetry("owner@example.com", prepared.id, LATER);
    assert.equal(retry.retryKey, prepared.id);
    assert.equal(retry.canonicalBody, '{"to":"U-stored","messages":[{"type":"text","text":"Stored reply"}]}');
    assert.equal(await repository.prepareHumanMessageRetry("other@example.com", prepared.id, LATER), null);
    assert.equal(JSON.stringify(retry).includes("browser-key"), false);
  });
});

test("an expired event fence blocks decision and outbox persistence even if the conversation lease was renewed", async () => {
  await withDatabase(async (db) => {
    const connectionId = "33333333-3333-4333-8333-333333333333";
    await db.insert(platformConnections).values({
      ...connection(connectionId, "owner@example.com"),
      encryptedCredentials: encryptJson({ accessToken: "private-line-token" }, SETTINGS_ENCRYPTION_KEY),
    });
    await db.insert(supportConfigurations).values({ ...configurationRecord(), platformConnectionId: connectionId, supportState: "enabled" });
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com", connectionId, eventId: "evt-expired-event", externalUserId: "U-private",
      replyToken: "reply-token", message: { type: "text", text: "Question", safeMetadata: {} }, receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId: "evt-expired-event", now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId: "evt-expired-event", now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({ connectionId, conversationId: ingested.conversationId, now: NOW });
    const turn = await repository.buildClaimedTurn({
      connectionId, eventId: "evt-expired-event", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      cutoff: new Date(NOW.getTime() + 3_000),
    });
    const [uncommittedInbound] = await db.select().from(supportMessages).where(eq(supportMessages.id, turn.inboundMessageId));
    assert.equal(uncommittedInbound.processedAt, null);
    const renewedAt = new Date(NOW.getTime() + 20_000);
    assert.equal(await repository.renewConversationClaim({
      connectionId, conversationId: ingested.conversationId, claimId: conversationClaim.claimId, now: renewedAt,
    }), true);
    const afterEventExpiry = new Date(NOW.getTime() + 31_000);

    assert.equal(await repository.handleLineCredentialRejected({
      connectionId, conversationId: ingested.conversationId, eventId: "evt-expired-event",
      eventClaimId: eventClaim.claimId, claimId: conversationClaim.claimId, now: afterEventExpiry,
    }), false);
    assert.equal((await db.select().from(platformConnections).where(eq(platformConnections.id, connectionId)))[0].state, "active");
    assert.equal((await db.select().from(supportConversations).where(eq(supportConversations.id, ingested.conversationId)))[0].status, "ai_active");
    assert.equal(await repository.markLineEventProcessed({
      connectionId, eventId: "evt-expired-event", claimId: eventClaim.claimId,
      conversationId: ingested.conversationId, conversationClaimId: conversationClaim.claimId, now: afterEventExpiry,
    }), false);

    await assert.rejects(repository.persistDecisionAndOutbound({
      connectionId, eventId: "evt-expired-event", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      eventClaimId: eventClaim.claimId, inboundMessageId: turn.inboundMessageId,
      cutoff: new Date(NOW.getTime() + 3_000),
      decision: { action: "reply", answer: "Answer", category: "general", knowledgeSourceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      canonicalBody: '{"to":"U-private","messages":[{"type":"text","text":"Answer"}]}', now: afterEventExpiry,
    }), /Webhook persistence is unavailable/);
    assert.equal((await db.select().from(supportAiDecisions)).length, 0);
    assert.equal((await db.select().from(supportOutboundDeliveries)).length, 0);
  });
});

test("reply and clarify workflows recover one exact persisted outbox after a post-commit crash", async () => {
  for (const action of ["reply", "clarify"]) {
    await withDatabase(async (db) => {
      const fixture = await createReplayWorkflowFixture(db, {
        connectionId: action === "reply"
          ? "11111111-aaaa-4111-8111-111111111111"
          : "22222222-aaaa-4222-8222-222222222222",
        eventId: `evt-replay-${action}`,
        message: { type: "text", text: "Question", safeMetadata: {} },
        decision: {
          action,
          answer: action === "reply" ? "Answer" : "Which order?",
          category: "general",
          knowledgeSourceIds: ["faq-1"],
        },
      });

      await assert.rejects(
        fixture.crashingWorkflow({
          eventId: fixture.eventId,
          connectionId: fixture.connectionId,
          conversationId: fixture.conversationId,
        }),
        /crash after persistence before delivery/,
      );

      const beforeReplay = await replayPersistenceSnapshot(db, fixture.connectionId, fixture.eventId);
      assert.deepEqual(beforeReplay.counts, { decisions: 1, outboundMessages: 1, deliveries: 1 });
      assert.equal(beforeReplay.delivery.deliveryStatus, "pending");

      assert.deepEqual(await fixture.replacementWorkflow({
        eventId: fixture.eventId,
        connectionId: fixture.connectionId,
        conversationId: fixture.conversationId,
      }), { status: "sent" });

      const afterReplay = await replayPersistenceSnapshot(db, fixture.connectionId, fixture.eventId);
      assert.deepEqual(afterReplay.counts, beforeReplay.counts);
      assert.equal(afterReplay.delivery.id, beforeReplay.delivery.id);
      assert.equal(afterReplay.delivery.retryKey, beforeReplay.delivery.retryKey);
      assert.equal(afterReplay.delivery.deliveryStatus, "sent");
      assert.equal(afterReplay.event.processingStatus, "processed");
      assert.equal(fixture.pushes.length, 1);

      assert.deepEqual(await fixture.replacementWorkflow({
        eventId: fixture.eventId,
        connectionId: fixture.connectionId,
        conversationId: fixture.conversationId,
      }), { status: "duplicate" });
      assert.equal(fixture.pushes.length, 1);
    });
  }
});

test("automatic non-text handoff recovers its exact acknowledgement after a post-commit crash", async () => {
  await withDatabase(async (db) => {
    const fixture = await createReplayWorkflowFixture(db, {
      connectionId: "33333333-aaaa-4333-8333-333333333333",
      eventId: "evt-replay-non-text-handoff",
      message: {
        type: "image",
        text: null,
        safeMetadata: { type: "image" },
        handoffReasonCode: "non_text",
      },
      decision: null,
    });

    await assert.rejects(
      fixture.crashingWorkflow({
        eventId: fixture.eventId,
        connectionId: fixture.connectionId,
        conversationId: fixture.conversationId,
      }),
      /crash after persistence before delivery/,
    );

    const beforeReplay = await replayPersistenceSnapshot(db, fixture.connectionId, fixture.eventId);
    assert.deepEqual(beforeReplay.counts, { decisions: 1, outboundMessages: 1, deliveries: 1 });
    assert.equal(beforeReplay.decision.action, "handoff");
    assert.equal(beforeReplay.decision.reasonCode, "non_text");
    assert.equal(beforeReplay.conversation.status, "waiting_human");

    assert.deepEqual(await fixture.replacementWorkflow({
      eventId: fixture.eventId,
      connectionId: fixture.connectionId,
      conversationId: fixture.conversationId,
    }), { status: "sent" });

    const afterReplay = await replayPersistenceSnapshot(db, fixture.connectionId, fixture.eventId);
    assert.deepEqual(afterReplay.counts, beforeReplay.counts);
    assert.equal(afterReplay.delivery.id, beforeReplay.delivery.id);
    assert.equal(afterReplay.delivery.retryKey, beforeReplay.delivery.retryKey);
    assert.equal(afterReplay.delivery.deliveryStatus, "sent");
    assert.equal(afterReplay.event.processingStatus, "processed");
    assert.equal(afterReplay.conversation.status, "waiting_human");
    assert.equal(afterReplay.conversation.processingClaimId, null);
    assert.equal(fixture.pushes.length, 1);
  });
});

test("a terminal handoff acknowledgement replay finalizes without sending again", async () => {
  await withDatabase(async (db) => {
    const fixture = await createReplayWorkflowFixture(db, {
      connectionId: "66666666-aaaa-4666-8666-666666666666",
      eventId: "evt-replay-terminal-handoff",
      message: {
        type: "image",
        text: null,
        safeMetadata: { type: "image" },
        handoffReasonCode: "non_text",
      },
      decision: null,
    });
    const input = {
      eventId: fixture.eventId,
      connectionId: fixture.connectionId,
      conversationId: fixture.conversationId,
    };

    await assert.rejects(
      fixture.finalizeCrashingWorkflow(input),
      /crash after terminal delivery before handoff finalization/,
    );
    const terminal = await replayPersistenceSnapshot(db, fixture.connectionId, fixture.eventId);
    assert.equal(terminal.delivery.deliveryStatus, "sent");
    assert.equal(terminal.event.processingStatus, "dispatched");
    assert.equal(fixture.pushes.length, 1);

    assert.deepEqual(await fixture.replacementWorkflow(input), { status: "sent" });
    const finalized = await replayPersistenceSnapshot(db, fixture.connectionId, fixture.eventId);
    assert.deepEqual(finalized.counts, terminal.counts);
    assert.equal(finalized.delivery.id, terminal.delivery.id);
    assert.equal(finalized.delivery.retryKey, terminal.delivery.retryKey);
    assert.equal(finalized.event.processingStatus, "processed");
    assert.equal(finalized.conversation.processingClaimId, null);
    assert.equal(fixture.pushes.length, 1);
  });
});

test("claimed AI batches process only the bounded selected message and companion-event set", async () => {
  await withDatabase(async (db) => {
    const connectionId = "44444444-aaaa-4444-8444-444444444444";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    let nextId = 9_999;
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      randomUUID: () => `id-${String(nextId--).padStart(4, "0")}`,
    });
    let conversationId;
    for (let index = 0; index < 30; index += 1) {
      const eventId = `evt-bounded-${String(index).padStart(2, "0")}`;
      const ingested = await repository.ingestLineUserEvent({
        ownerEmail: "owner@example.com",
        connectionId,
        eventId,
        externalUserId: "U-private",
        replyToken: `reply-${index}`,
        message: { type: "text", text: `Message ${index}`, safeMetadata: {} },
        receivedAt: NOW,
      });
      conversationId ??= ingested.conversationId;
      const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
      assert.equal(await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW }), true);
    }
    const eventId = "evt-bounded-29";
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId, now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({
      connectionId,
      eventId,
      eventClaimId: eventClaim.claimId,
      conversationId,
      now: NOW,
    });
    const cutoff = new Date(NOW.getTime() + 1_000);
    const turn = await repository.buildClaimedTurn({
      connectionId, eventId, conversationId, claimId: conversationClaim.claimId, cutoff,
    });
    const context = await repository.loadCurrentProcessingContext({
      connectionId,
      conversationId,
      claimId: conversationClaim.claimId,
      cutoff,
      now: NOW,
    });
    assert.equal(context.customerTexts.length, 25);
    assert.equal(context.customerTexts[0], "Message 29");
    assert.equal(context.customerTexts.at(-1), "Message 5");
    await repository.persistDecisionAndOutbound({
      connectionId,
      eventId,
      eventClaimId: eventClaim.claimId,
      conversationId,
      claimId: conversationClaim.claimId,
      inboundMessageId: turn.inboundMessageId,
      cutoff,
      decision: {
        action: "reply",
        answer: "Answer",
        category: "general",
        knowledgeSourceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      },
      canonicalBody: '{"to":"U-private","messages":[{"type":"text","text":"Answer"}]}',
      now: NOW,
    });

    const inbound = await db.select().from(supportMessages)
      .where(eq(supportMessages.direction, "inbound"));
    const events = await db.select().from(supportWebhookEvents);
    assert.equal(inbound.filter(({ processedAt }) => processedAt != null).length, 25);
    assert.equal(inbound.filter(({ processedAt }) => processedAt == null).length, 5);
    assert.equal(events.filter(({ processingStatus }) => processingStatus === "processed").length, 24);
    assert.equal(events.filter(({ processingStatus }) => processingStatus === "processing").length, 1);
    assert.equal(events.filter(({ processingStatus }) => processingStatus === "dispatched").length, 5);
  });
});

test("automated outbox claiming requires the exact live event and conversation ownership fences", async () => {
  await withDatabase(async (db) => {
    const connectionId = "55555555-aaaa-4555-8555-555555555555";
    const eventId = "evt-delivery-ownership";
    await db.insert(platformConnections).values(connection(connectionId, "owner@example.com"));
    const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
    const ingested = await repository.ingestLineUserEvent({
      ownerEmail: "owner@example.com",
      connectionId,
      eventId,
      externalUserId: "U-private",
      replyToken: "reply-token",
      message: { type: "text", text: "Question", safeMetadata: {} },
      receivedAt: NOW,
    });
    const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
    await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW });
    const eventClaim = await repository.claimLineEventProcessing({ connectionId, eventId, now: NOW });
    const conversationClaim = await repository.acquireConversationClaim({
      connectionId,
      eventId,
      eventClaimId: eventClaim.claimId,
      conversationId: ingested.conversationId,
      now: NOW,
    });
    const cutoff = new Date(NOW.getTime() + 3_000);
    const turn = await repository.buildClaimedTurn({
      connectionId,
      eventId,
      conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId,
      cutoff,
    });
    const persisted = await repository.persistDecisionAndOutbound({
      connectionId,
      eventId,
      eventClaimId: eventClaim.claimId,
      conversationId: ingested.conversationId,
      claimId: conversationClaim.claimId,
      inboundMessageId: turn.inboundMessageId,
      cutoff,
      decision: {
        action: "reply",
        answer: "Answer",
        category: "general",
        knowledgeSourceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      },
      canonicalBody: '{"to":"U-private","messages":[{"type":"text","text":"Answer"}]}',
      now: NOW,
    });
    const ownership = {
      deliveryId: persisted.deliveryId,
      connectionId,
      eventId,
      eventClaimId: eventClaim.claimId,
      conversationId: ingested.conversationId,
      conversationClaimId: conversationClaim.claimId,
      now: NOW,
    };

    assert.deepEqual(await repository.claimLineOutboundDelivery({
      ...ownership,
      eventClaimId: "wrong-event-claim",
    }), { claimed: false, status: "pending" });
    assert.deepEqual(await repository.claimLineOutboundDelivery({
      ...ownership,
      conversationClaimId: "wrong-conversation-claim",
    }), { claimed: false, status: "pending" });
    assert.equal((await repository.claimLineOutboundDelivery(ownership)).claimed, true);
    assert.equal(await repository.takeOverSupportConversation(
      "owner@example.com",
      ingested.conversationId,
      0,
      new Date(NOW.getTime() + 1),
    ), null);
    assert.equal((await db.select().from(supportConversations)
      .where(eq(supportConversations.id, ingested.conversationId)))[0].status, "ai_active");
    assert.equal((await db.select().from(supportOutboundDeliveries)
      .where(eq(supportOutboundDeliveries.id, persisted.deliveryId)))[0].deliveryStatus, "sending");
  });
});

async function createReplayWorkflowFixture(db, { connectionId, eventId, message, decision }) {
  await db.insert(platformConnections).values({
    ...connection(connectionId, "owner@example.com"),
    encryptedCredentials: encryptJson({ accessToken: "line-test-token" }, SETTINGS_ENCRYPTION_KEY),
  });
  await db.insert(supportConfigurations).values({
    ...configurationRecord(),
    id: `config-${eventId}`,
    platformConnectionId: connectionId,
    supportState: "enabled",
  });
  await db.insert(userSettings).values({
    ownerEmail: "owner@example.com",
    encryptedSettings: encryptJson({ googleAiApiKey: "test-provider-key" }, SETTINGS_ENCRYPTION_KEY),
    updatedAt: NOW,
  });
  const repository = createSupportRepository(db, { encryptionKey: SETTINGS_ENCRYPTION_KEY });
  const ingested = await repository.ingestLineUserEvent({
    ownerEmail: "owner@example.com",
    connectionId,
    eventId,
    externalUserId: "U-private",
    replyToken: "reply-token",
    message,
    receivedAt: NOW,
  });
  const dispatch = await repository.claimLineWorkflowDispatch({ connectionId, eventId, now: NOW });
  assert.equal(dispatch.claimed, true);
  assert.equal(await repository.markLineWorkflowDispatched({ ...dispatch, now: NOW }), true);

  const pushes = [];
  const deliveryService = createLineOutboundDeliveryService({
    outboxStore: {
      claimDelivery: (input) => repository.claimLineOutboundDelivery(input),
      markDeliverySent: (input) => repository.markLineOutboundDeliverySent(input),
      markDeliveryRetryable: (input) => repository.markLineOutboundDeliveryRetryable(input),
      markDeliveryFailed: (input) => repository.markLineOutboundDeliveryFailed(input),
      getDeliveryStatus: (deliveryId) => repository.getLineOutboundDeliveryStatus(deliveryId),
    },
    sendPush: async (request) => {
      pushes.push(request);
      return { status: 200, headers: {} };
    },
  });
  const processingService = createSupportProcessingService({
    repository,
    decisionService: {
      async decide() {
        if (!decision) throw new Error("provider must not run for automatic non-text handoff");
        return decision;
      },
    },
    deliveryService,
    now: () => NOW,
  });
  const eventStore = {
    claimEventProcessing: (input) => repository.claimLineEventProcessing(input),
    renewEventProcessing: (input) => repository.renewLineEventProcessing(input),
    markEventProcessed: (input) => repository.markLineEventProcessed(input),
    releaseEventProcessing: (input) => repository.releaseLineEventProcessing(input),
  };
  const workflowOptions = {
    eventStore,
    sleepImpl: async () => {},
    startWorkflow: async () => {},
    now: () => NOW,
  };
  return {
    connectionId,
    eventId,
    conversationId: ingested.conversationId,
    pushes,
    crashingWorkflow: createLineMessageWorkflow({
      ...workflowOptions,
      processingService: {
        ...processingService,
        async deliver() {
          throw new Error("crash after persistence before delivery");
        },
      },
    }),
    finalizeCrashingWorkflow: createLineMessageWorkflow({
      ...workflowOptions,
      processingService: {
        ...processingService,
        async finalizeHandoff() {
          throw new Error("crash after terminal delivery before handoff finalization");
        },
      },
    }),
    replacementWorkflow: createLineMessageWorkflow({
      ...workflowOptions,
      processingService,
    }),
  };
}

async function replayPersistenceSnapshot(db, connectionId, eventId) {
  const [event] = await db.select().from(supportWebhookEvents).where(and(
    eq(supportWebhookEvents.platformConnectionId, connectionId),
    eq(supportWebhookEvents.webhookEventId, eventId),
  ));
  const [delivery] = await db.select().from(supportOutboundDeliveries)
    .where(eq(supportOutboundDeliveries.webhookEventId, event.id));
  const [conversation] = await db.select().from(supportConversations)
    .where(eq(supportConversations.id, delivery.conversationId));
  const decisions = await db.select().from(supportAiDecisions)
    .where(eq(supportAiDecisions.conversationId, conversation.id));
  const outboundMessages = await db.select().from(supportMessages).where(and(
    eq(supportMessages.conversationId, conversation.id),
    eq(supportMessages.idempotencyKey, `ai:${connectionId}:${eventId}`),
  ));
  return {
    event,
    delivery,
    conversation,
    decision: decisions[0],
    counts: {
      decisions: decisions.length,
      outboundMessages: outboundMessages.length,
      deliveries: delivery ? 1 : 0,
    },
  };
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "support-repository-"));
  const databaseUrl = pathToFileURL(join(directory, "support.db")).href;
  const client = createClient({ url: databaseUrl });
  const secondaryClients = [];
  try {
    await client.executeMultiple(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE platform_connections (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform TEXT NOT NULL,
        display_name TEXT NOT NULL, state TEXT NOT NULL, encrypted_credentials TEXT NOT NULL,
        credential_expires_at INTEGER, renewal_lease_id TEXT, renewal_lease_expires_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE support_configurations (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform_connection_id TEXT NOT NULL,
        brand_name TEXT NOT NULL DEFAULT '', assistant_name TEXT NOT NULL DEFAULT '',
        reply_tone TEXT NOT NULL DEFAULT 'friendly', llm_provider TEXT, llm_model TEXT,
        support_state TEXT NOT NULL DEFAULT 'disabled', webhook_key_hash TEXT,
        webhook_verified_at INTEGER, redelivery_acknowledged_at INTEGER,
        native_replies_disabled_acknowledged_at INTEGER, provider_tested_at INTEGER,
        version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY (platform_connection_id) REFERENCES platform_connections(id)
      );
      CREATE UNIQUE INDEX support_configurations_connection_unique
        ON support_configurations(platform_connection_id);
      CREATE TABLE support_faqs (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, question TEXT NOT NULL,
        answer TEXT NOT NULL, category TEXT NOT NULL, keywords_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE support_conversations (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL,
        platform_connection_id TEXT NOT NULL, platform TEXT NOT NULL,
        customer_lookup_key TEXT NOT NULL, encrypted_customer_external_id TEXT NOT NULL,
        status TEXT NOT NULL, handoff_reason_code TEXT, unread_count INTEGER NOT NULL DEFAULT 0,
        pending_transition_id TEXT, pending_action TEXT, pending_action_effective_at INTEGER,
        processing_claim_id TEXT, processing_claim_expires_at INTEGER, version INTEGER NOT NULL DEFAULT 0,
        last_inbound_at INTEGER, last_outbound_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (platform_connection_id, customer_lookup_key)
      );
      CREATE TABLE support_messages (
        id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, direction TEXT NOT NULL,
        sender_type TEXT NOT NULL, message_type TEXT NOT NULL, text_content TEXT,
        safe_metadata_json TEXT NOT NULL DEFAULT '{}', provider_message_id TEXT,
        delivery_status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, sent_at INTEGER,
        failed_at INTEGER, safe_error_code TEXT, processed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE support_webhook_events (
        id TEXT PRIMARY KEY NOT NULL, platform_connection_id TEXT NOT NULL, webhook_event_id TEXT NOT NULL,
        source_type TEXT NOT NULL, processing_status TEXT NOT NULL, encrypted_reply_token TEXT,
        reply_token_expires_at INTEGER, safe_error_code TEXT, received_at INTEGER NOT NULL,
        processed_at INTEGER, created_at INTEGER NOT NULL,
        UNIQUE (platform_connection_id, webhook_event_id)
      );
      CREATE TABLE support_ai_decisions (
        id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, inbound_message_id TEXT NOT NULL,
        action TEXT NOT NULL, category TEXT, reason_code TEXT, answer_message_id TEXT,
        faq_ids_json TEXT NOT NULL DEFAULT '[]', llm_provider TEXT, llm_model TEXT,
        prompt_version TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE support_outbound_deliveries (
        id TEXT PRIMARY KEY NOT NULL, webhook_event_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL, encrypted_recipient TEXT NOT NULL,
        encrypted_canonical_body TEXT NOT NULL, retry_key TEXT NOT NULL UNIQUE,
        delivery_status TEXT NOT NULL, delivery_claim_id TEXT, delivery_claim_expires_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, last_attempt_at INTEGER,
        next_attempt_at INTEGER, accepted_request_id TEXT, safe_error_code TEXT,
        sent_at INTEGER, failed_at INTEGER, human_review_at INTEGER, created_at INTEGER NOT NULL,
        FOREIGN KEY (webhook_event_id) REFERENCES support_webhook_events(id),
        FOREIGN KEY (conversation_id) REFERENCES support_conversations(id)
      );
      CREATE INDEX support_outbound_deliveries_status_next_attempt_idx
        ON support_outbound_deliveries(delivery_status, next_attempt_at);
      CREATE TABLE support_conversation_transitions (
        id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, requested_action TEXT NOT NULL,
        from_status TEXT NOT NULL, to_status TEXT NOT NULL, requested_by_owner_email TEXT NOT NULL,
        expected_version INTEGER NOT NULL, requested_at INTEGER NOT NULL, effective_at INTEGER NOT NULL,
        cancelled_at INTEGER, committed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE user_settings (
        owner_email TEXT PRIMARY KEY NOT NULL, encrypted_settings TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await run(drizzle(client), {
      createLoggedDb(logger) {
        return drizzle(client, { logger });
      },
      async createSecondaryDb() {
        const secondaryClient = createClient({ url: databaseUrl });
        secondaryClients.push(secondaryClient);
        await secondaryClient.execute("PRAGMA foreign_keys = ON");
        await secondaryClient.execute("PRAGMA busy_timeout = 5000");
        return drizzle(secondaryClient);
      },
    });
  } finally {
    await Promise.all(secondaryClients.map((secondaryClient) => secondaryClient.close()));
    await client.close();
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EBUSY") throw error;
    }
  }
}

async function seedReadySupport(db) {
  await db.insert(platformConnections).values(
    connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
  );
  await db.insert(supportConfigurations).values(configurationRecord());
  await db.insert(supportFaqs).values({
    ...faqRecord(),
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ownerEmail: "owner@example.com",
  });
  await db.insert(userSettings).values({
    ownerEmail: "owner@example.com",
    encryptedSettings: encryptJson({ googleAiApiKey: "current-key" }, SETTINGS_ENCRYPTION_KEY),
    updatedAt: NOW,
  });
}

function createDecryptInterleaving() {
  let release;
  let announceStarted;
  let reads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    announceStarted = resolve;
  });
  return {
    started,
    release,
    async decrypt(encryptedSettings) {
      const settings = decryptJson(encryptedSettings, SETTINGS_ENCRYPTION_KEY);
      reads += 1;
      if (reads === 1) {
        announceStarted();
        await gate;
      }
      return settings;
    },
  };
}

function connection(id, ownerEmail) {
  return {
    id,
    ownerEmail,
    platform: "line",
    displayName: id,
    state: "active",
    encryptedCredentials: "encrypted",
    credentialExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function configurationRecord() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerEmail: "owner@example.com",
    platformConnectionId: "11111111-1111-4111-8111-111111111111",
    brandName: "Acme",
    assistantName: "Ada",
    replyTone: "friendly",
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    supportState: "disabled",
    webhookKeyHash: "secret-hash",
    webhookVerifiedAt: NOW,
    redeliveryAcknowledgedAt: NOW,
    nativeRepliesDisabledAcknowledgedAt: NOW,
    providerTestedAt: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function faqRecord() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    question: "Question",
    answer: "Answer",
    category: "general",
    keywordsJson: '["question"]',
    enabled: true,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function messageRecord(id, conversationId, createdAt, textContent) {
  return {
    id,
    conversationId,
    direction: "inbound",
    senderType: "customer",
    messageType: "text",
    textContent,
    safeMetadataJson: "{}",
    deliveryStatus: "received",
    idempotencyKey: `idempotency-${id}`,
    createdAt,
  };
}

function automatedDeliveryOwnership({
  connectionId,
  eventId,
  eventClaimId,
  conversationId,
  conversationClaimId,
}) {
  return { connectionId, eventId, eventClaimId, conversationId, conversationClaimId };
}
