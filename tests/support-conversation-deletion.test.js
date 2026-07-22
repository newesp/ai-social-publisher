import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import {
  platformConnections,
  supportAiDecisions,
  supportConversationTransitions,
  supportConversations,
  supportMessages,
  supportOutboundDeliveries,
  supportWebhookEvents,
} from "../src/lib/db/schema.js";
import { createSupportRepository } from "../src/lib/support/support-repository.js";

const NOW = new Date("2026-07-22T10:00:00.000Z");

test("deleting a closed conversation clears its circular foreign keys before removing dependent rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-conversation-deletion-"));
  const client = createClient({ url: pathToFileURL(join(directory, "support.db")).href });
  try {
    await client.executeMultiple(await supportSchemaSql());
    const db = drizzle(client);
    const repository = createSupportRepository(db, { encryptionKey: "test-encryption-key" });
    await db.insert(platformConnections).values({
      id: "line-connection", ownerEmail: "owner@example.com", platform: "line", displayName: "LINE",
      state: "active", encryptedCredentials: "encrypted", createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(supportConversations).values({
      id: "conversation-1", ownerEmail: "owner@example.com", platformConnectionId: "line-connection",
      platform: "line", customerLookupKey: "customer-key", encryptedCustomerExternalId: "encrypted-customer",
      status: "resolved", unreadCount: 0, createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(supportMessages).values({
      id: "message-1", conversationId: "conversation-1", direction: "outbound", senderType: "ai",
      messageType: "text", textContent: "Closed", safeMetadataJson: "{}", deliveryStatus: "sent",
      idempotencyKey: "message-key", createdAt: NOW,
    });
    await db.insert(supportConversationTransitions).values({
      id: "transition-1", conversationId: "conversation-1", requestedAction: "resolve", fromStatus: "human_active",
      toStatus: "resolve_pending", requestedByOwnerEmail: "owner@example.com", expectedVersion: 0,
      requestedAt: NOW, effectiveAt: NOW, createdAt: NOW,
    });
    await db.update(supportConversations).set({
      aiClosureConfirmationMessageId: "message-1", pendingTransitionId: "transition-1",
    }).where(eq(supportConversations.id, "conversation-1"));
    await db.insert(supportAiDecisions).values({
      id: "decision-1", conversationId: "conversation-1", inboundMessageId: "message-1", action: "reply",
      faqIdsJson: "[]", promptVersion: "v1", createdAt: NOW,
    });
    await db.insert(supportWebhookEvents).values({
      id: "event-1", platformConnectionId: "line-connection", webhookEventId: "provider-event",
      sourceType: "user", processingStatus: "processed", receivedAt: NOW, createdAt: NOW,
    });
    await db.insert(supportOutboundDeliveries).values({
      id: "delivery-1", webhookEventId: "event-1", conversationId: "conversation-1", encryptedRecipient: "encrypted",
      encryptedCanonicalBody: "encrypted", retryKey: "retry-key", deliveryStatus: "sent", createdAt: NOW,
    });

    assert.equal(await repository.deleteSupportConversation("owner@example.com", "conversation-1"), true);
    assert.equal((await db.select().from(supportConversations)).length, 0);
    assert.equal((await db.select().from(supportMessages)).length, 0);
    assert.equal((await db.select().from(supportAiDecisions)).length, 0);
    assert.equal((await db.select().from(supportConversationTransitions)).length, 0);
    assert.equal((await db.select().from(supportOutboundDeliveries)).length, 0);
    assert.equal((await db.select().from(supportWebhookEvents)).length, 1);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function supportSchemaSql() {
  const files = [
    "0004_line_ai_customer_support.sql",
    "0005_line_outbound_delivery_outbox.sql",
    "0010_support_ai_closure_and_handoff.sql",
    "0011_support_customer_display_name.sql",
    "0012_support_conversation_cases.sql",
  ];
  const sql = await Promise.all(files.map((file) => readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")));
  return [
    "PRAGMA foreign_keys=ON;",
    `CREATE TABLE platform_connections (
      id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform TEXT NOT NULL,
      display_name TEXT NOT NULL, state TEXT NOT NULL, encrypted_credentials TEXT NOT NULL,
      credential_expires_at INTEGER, renewal_lease_id TEXT, renewal_lease_expires_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`,
    ...sql.map((value) => value.replaceAll("--> statement-breakpoint", "")),
  ].join("\n");
}
