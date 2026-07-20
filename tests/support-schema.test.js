import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

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
  supportOutboundDeliveries: [
    "id", "webhookEventId", "conversationId", "encryptedRecipient",
    "encryptedCanonicalBody", "retryKey", "deliveryStatus", "deliveryClaimId",
    "deliveryClaimExpiresAt", "attemptCount", "firstAttemptAt", "lastAttemptAt",
    "nextAttemptAt", "acceptedRequestId", "safeErrorCode", "sentAt", "failedAt",
    "humanReviewAt", "createdAt",
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
  "support_conversations_inbox_covering_idx",
  "support_conversations_customer_unique",
  "support_messages_conversation_created_idx",
  "support_messages_retention_created_idx",
  "support_messages_idempotency_unique",
  "support_webhook_events_connection_event_unique",
  "support_webhook_events_retention_reply_token_idx",
  "support_outbound_deliveries_event_unique",
  "support_outbound_deliveries_retry_key_unique",
  "support_outbound_deliveries_status_next_attempt_idx",
  "support_outbound_deliveries_conversation_status_idx",
  "support_outbound_deliveries_retention_status_created_idx",
  "support_transitions_conversation_created_idx",
];

test("support migration creates tenant, idempotency, claim, and transition indexes", async () => {
  const sql = await readFile(new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url), "utf8");
  const outboxSql = await readFile(new URL("../drizzle/0005_line_outbound_delivery_outbox.sql", import.meta.url), "utf8");
  const retentionSql = await readFile(new URL("../drizzle/0006_support_retention_indexes.sql", import.meta.url), "utf8");
  const paginationSql = await readFile(new URL("../drizzle/0007_support_inbox_pagination.sql", import.meta.url), "utf8");
  for (const name of REQUIRED_INDEXES) assert.match(`${sql}\n${outboxSql}\n${retentionSql}\n${paginationSql}`, new RegExp(name));
});

test("support schema exports all eight UUID-backed tables with the required fields", () => {
  for (const [exportName, expectedColumns] of Object.entries(SUPPORT_TABLES)) {
    assert.ok(schema[exportName], `${exportName} must be exported`);
    const columns = getTableColumns(schema[exportName]);
    assert.deepEqual(Object.keys(columns), expectedColumns);
    assert.equal(columns.id.dataType, "string");
    assert.equal(columns.id.primary, true);
  }
});

test("pending transitions preserve the circular conversation foreign keys", async () => {
  const sql = await readFile(new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url), "utf8");
  assert.match(
    sql,
    /pending_transition_id[^,\n]*references\s+`support_conversation_transitions`\s*\(\s*`id`\s*\)/i,
  );

  const conversationForeignKeys = getTableConfig(schema.supportConversations).foreignKeys
    .map((foreignKey) => foreignKey.reference());
  assert.equal(
    conversationForeignKeys.some((reference) => (
      reference.columns[0] === schema.supportConversations.pendingTransitionId
      && reference.foreignTable === schema.supportConversationTransitions
      && reference.foreignColumns[0] === schema.supportConversationTransitions.id
    )),
    true,
  );
  const transitionForeignKeys = getTableConfig(schema.supportConversationTransitions).foreignKeys
    .map((foreignKey) => foreignKey.reference());
  assert.equal(
    transitionForeignKeys.some((reference) => (
      reference.columns[0] === schema.supportConversationTransitions.conversationId
      && reference.foreignTable === schema.supportConversations
      && reference.foreignColumns[0] === schema.supportConversations.id
    )),
    true,
  );
});

test("support migrations journal immutable outbound delivery, retention indexes, and enforce idempotency", async () => {
  const sql = await readFile(new URL("../drizzle/0004_line_ai_customer_support.sql", import.meta.url), "utf8");
  const outboxSql = await readFile(new URL("../drizzle/0005_line_outbound_delivery_outbox.sql", import.meta.url), "utf8");
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const snapshot = JSON.parse(await readFile(new URL("../drizzle/meta/0004_snapshot.json", import.meta.url), "utf8"));
  assert.equal(journal.entries.at(-1).idx, 8);
  assert.equal(journal.entries.at(-1).tag, "0008_support_decision_timeline_index");
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
  assert.equal(
    Object.values(snapshot.tables.support_conversations.foreignKeys).some((foreignKey) => (
      foreignKey.columnsFrom[0] === "pending_transition_id"
      && foreignKey.tableTo === "support_conversation_transitions"
      && foreignKey.columnsTo[0] === "id"
    )),
    true,
  );

  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE platform_connections (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO platform_connections (id) VALUES ('line-1');
      ${sql.replaceAll("--> statement-breakpoint", "")}
      ${outboxSql.replaceAll("--> statement-breakpoint", "")}
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

    await client.execute(`
      INSERT INTO support_conversation_transitions (
        id, conversation_id, requested_action, from_status, to_status,
        requested_by_owner_email, expected_version, requested_at,
        effective_at, created_at
      ) VALUES (
        'transition-1', 'conversation-1', 'take_over', 'ai_active',
        'human_active', 'owner@example.com', 0, 1, 2, 1
      )
    `);
    await client.execute(
      "UPDATE support_conversations SET pending_transition_id = 'transition-1' WHERE id = 'conversation-1'",
    );
    await assert.rejects(
      client.execute(
        "UPDATE support_conversations SET pending_transition_id = 'missing-transition' WHERE id = 'conversation-1'",
      ),
    );
  } finally {
    await client.close();
  }
});
