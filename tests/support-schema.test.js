import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";
import { getTableColumns } from "drizzle-orm";

import * as schema from "../src/lib/db/schema.js";

const SUPPORT_TABLES = {
  supportConfigurations: [
    "id", "ownerEmail", "platformConnectionId", "brandName", "assistantName",
    "replyTone", "llmProvider", "llmModel", "supportState", "webhookKeyHash",
    "webhookVerifiedAt", "redeliveryAcknowledgedAt",
    "nativeRepliesDisabledAcknowledgedAt", "providerTestedAt", "version",
    "createdAt", "updatedAt",
  ],
  supportFaqs: [
    "id", "ownerEmail", "question", "answer", "category", "keywordsJson",
    "enabled", "priority", "createdAt", "updatedAt",
  ],
  supportConversations: [
    "id", "ownerEmail", "platformConnectionId", "platform",
    "customerLookupKey", "encryptedCustomerExternalId", "status",
    "handoffReasonCode", "unreadCount", "pendingTransitionId", "pendingAction",
    "pendingActionEffectiveAt", "processingClaimId", "processingClaimExpiresAt",
    "version", "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt",
  ],
  supportMessages: [
    "id", "conversationId", "direction", "senderType", "messageType",
    "textContent", "safeMetadataJson", "providerMessageId", "deliveryStatus",
    "idempotencyKey", "sentAt", "failedAt", "safeErrorCode", "processedAt",
    "createdAt",
  ],
  supportAiDecisions: [
    "id", "conversationId", "inboundMessageId", "action", "category",
    "reasonCode", "answerMessageId", "faqIdsJson", "llmProvider", "llmModel",
    "promptVersion", "inputTokens", "outputTokens", "latencyMs", "createdAt",
  ],
  supportWebhookEvents: [
    "id", "platformConnectionId", "webhookEventId", "sourceType",
    "processingStatus", "encryptedReplyToken", "replyTokenExpiresAt",
    "safeErrorCode", "receivedAt", "processedAt", "createdAt",
  ],
  supportConversationTransitions: [
    "id", "conversationId", "requestedAction", "fromStatus", "toStatus",
    "requestedByOwnerEmail", "expectedVersion", "requestedAt", "effectiveAt",
    "cancelledAt", "committedAt", "createdAt",
  ],
};

const REQUIRED_INDEXES = [
  "support_configurations_connection_unique",
  "support_configurations_webhook_key_unique",
  "support_faqs_owner_enabled_idx",
  "support_conversations_owner_status_updated_idx",
  "support_conversations_customer_unique",
  "support_messages_conversation_created_idx",
  "support_messages_idempotency_unique",
  "support_webhook_events_connection_event_unique",
  "support_transitions_conversation_created_idx",
];

test("support migration creates tenant, idempotency, claim, and transition indexes", async () => {
  const sql = await readFile(new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url), "utf8");
  for (const name of REQUIRED_INDEXES) assert.match(sql, new RegExp(name));
});

test("support schema exports all seven UUID-backed tables with the required fields", () => {
  for (const [exportName, expectedColumns] of Object.entries(SUPPORT_TABLES)) {
    assert.ok(schema[exportName], `${exportName} must be exported`);
    const columns = getTableColumns(schema[exportName]);
    assert.deepEqual(Object.keys(columns), expectedColumns);
    assert.equal(columns.id.dataType, "string");
    assert.equal(columns.id.primary, true);
  }
});

test("support migration is journaled after 0003 and enforces customer and delivery idempotency", async () => {
  const sql = await readFile(new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url), "utf8");
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const snapshot = JSON.parse(await readFile(new URL("../drizzle/meta/0004_snapshot.json", import.meta.url), "utf8"));
  assert.equal(journal.entries.at(-1).idx, 4);
  assert.equal(journal.entries.at(-1).tag, "0004_line_ai_customer_support");
  for (const tableName of [
    "support_configurations",
    "support_faqs",
    "support_conversations",
    "support_messages",
    "support_ai_decisions",
    "support_webhook_events",
    "support_conversation_transitions",
  ]) {
    assert.ok(snapshot.tables[tableName], `${tableName} must be represented in the 0004 snapshot`);
  }

  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`
      CREATE TABLE platform_connections (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO platform_connections (id) VALUES ('line-1');
      ${sql.replaceAll("--> statement-breakpoint", "")}
    `);
    const conversation = (id) => ({
      id,
      owner_email: "owner@example.com",
      platform_connection_id: "line-1",
      platform: "line",
      customer_lookup_key: "lookup-1",
      encrypted_customer_external_id: "encrypted",
      status: "ai_active",
      created_at: 1,
      updated_at: 1,
    });
    const insertConversation = {
      sql: `INSERT INTO support_conversations (
        id, owner_email, platform_connection_id, platform, customer_lookup_key,
        encrypted_customer_external_id, status, created_at, updated_at
      ) VALUES (
        :id, :owner_email, :platform_connection_id, :platform,
        :customer_lookup_key, :encrypted_customer_external_id, :status,
        :created_at, :updated_at
      )`,
      args: conversation("conversation-1"),
    };
    await client.execute(insertConversation);
    await assert.rejects(client.execute({
      ...insertConversation,
      args: conversation("conversation-2"),
    }));

    const message = (id) => ({
      id,
      conversation_id: "conversation-1",
      direction: "inbound",
      sender_type: "customer",
      message_type: "text",
      delivery_status: "received",
      idempotency_key: "delivery-1",
      created_at: 1,
    });
    const insertMessage = {
      sql: `INSERT INTO support_messages (
        id, conversation_id, direction, sender_type, message_type,
        delivery_status, idempotency_key, created_at
      ) VALUES (
        :id, :conversation_id, :direction, :sender_type, :message_type,
        :delivery_status, :idempotency_key, :created_at
      )`,
      args: message("message-1"),
    };
    await client.execute(insertMessage);
    await assert.rejects(client.execute({
      ...insertMessage,
      args: message("message-2"),
    }));
  } finally {
    await client.close();
  }
});
