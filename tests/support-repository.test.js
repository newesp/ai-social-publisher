import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
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
import { createSupportRepository } from "../src/lib/support/support-repository.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const LATER = new Date("2026-07-19T00:01:00.000Z");
const SETTINGS_ENCRYPTION_KEY = "support-repository-test-key";

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
    assert.equal(updated.status, "waiting_human");

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

    const delivery = await repository.claimLineOutboundDelivery({ deliveryId: first.deliveryId, now: NOW });
    assert.equal(delivery.claimed, true);
    assert.equal(delivery.retryKey, first.retryKey);
    assert.equal(delivery.canonicalBody, body);
    assert.equal((await repository.claimLineOutboundDelivery({
      deliveryId: first.deliveryId,
      now: new Date(NOW.getTime() + (24 * 60 * 60 * 1_000) + 1),
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

    const turn = await repository.buildClaimedTurn({
      connectionId, eventId: "evt-turn-1", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      cutoff: new Date(NOW.getTime() + 3_000),
    });
    assert.deepEqual(turn.customerTexts, ["Question"]);
    const context = await repository.loadCurrentProcessingContext({
      connectionId, eventId: "evt-turn-1", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
    });
    assert.equal(context.settings.googleAiApiKey, "private-ai-key");
    assert.equal(context.recipient, "U-private");
    assert.deepEqual(context.faqs.map(({ id }) => id), ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);

    const persisted = await repository.persistDecisionAndOutbound({
      connectionId, eventId: "evt-turn-1", conversationId: ingested.conversationId, claimId: conversationClaim.claimId,
      eventClaimId: eventClaim.claimId,
      inboundMessageId: turn.inboundMessageId,
      decision: { action: "reply", answer: "Answer", category: "general", handoffReasonCode: null, knowledgeSourceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      canonicalBody: "{\"to\":\"U-private\",\"messages\":[{\"type\":\"text\",\"text\":\"Answer\"}]}", now: NOW,
    });
    assert.ok(persisted.deliveryId);
    assert.equal((await db.select().from(supportAiDecisions)).length, 1);
    assert.equal((await db.select().from(supportOutboundDeliveries)).length, 1);
    assert.equal(await repository.loadLineAccessToken(connectionId), "private-line-token");
    assert.equal(await repository.markLineEventProcessed({ connectionId, eventId: "evt-turn-1", claimId: eventClaim.claimId, now: NOW }), true);
  });
});

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
