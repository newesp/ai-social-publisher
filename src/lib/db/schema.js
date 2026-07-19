import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerEmail: text("owner_email").notNull(),
  productName: text("product_name").notNull(),
  productFeatures: text("product_features").notNull(),
  imagePrompt: text("image_prompt"),
  imageImgurUrl: text("image_imgur_url"),
  status: text("status").notNull().default("draft"),
  scheduledFor: integer("scheduled_for", { mode: "timestamp" }),
  publishingStartedAt: integer("publishing_started_at", { mode: "timestamp" }),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("posts_owner_created_at_idx").on(table.ownerEmail, table.createdAt),
  index("posts_status_scheduled_for_idx").on(table.status, table.scheduledFor),
]);

export const platformConnections = sqliteTable("platform_connections", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  platform: text("platform").notNull(),
  displayName: text("display_name").notNull(),
  state: text("state").notNull(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  credentialExpiresAt: integer("credential_expires_at", { mode: "timestamp" }),
  renewalLeaseId: text("renewal_lease_id"),
  renewalLeaseExpiresAt: integer("renewal_lease_expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("platform_connections_owner_platform_state_idx").on(table.ownerEmail, table.platform, table.state),
  uniqueIndex("platform_connections_one_active_owner_platform_idx")
    .on(table.ownerEmail, table.platform)
    .where(sql`${table.state} = 'active'`),
]);

export const oauthTransactions = sqliteTable("oauth_transactions", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  provider: text("provider").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  returnPath: text("return_path").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("oauth_transactions_expires_at_idx").on(table.expiresAt),
]);

export const postTargets = sqliteTable("post_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id")
    .notNull()
    .references(() => posts.id),
  platform: text("platform").notNull(),
  platformConnectionId: text("platform_connection_id").references(() => platformConnections.id),
  content: text("content").notNull(),
  hashtagsJson: text("hashtags_json").notNull().default("[]"),
  status: text("status").notNull().default("draft"),
  externalPostId: text("external_post_id"),
  errorMessage: text("error_message"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const userSettings = sqliteTable("user_settings", {
  ownerEmail: text("owner_email").primaryKey(),
  encryptedSettings: text("encrypted_settings").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const supportConfigurations = sqliteTable("support_configurations", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  platformConnectionId: text("platform_connection_id")
    .notNull()
    .references(() => platformConnections.id),
  brandName: text("brand_name").notNull().default(""),
  assistantName: text("assistant_name").notNull().default(""),
  replyTone: text("reply_tone").notNull().default("friendly"),
  llmProvider: text("llm_provider"),
  llmModel: text("llm_model"),
  supportState: text("support_state").notNull().default("disabled"),
  webhookKeyHash: text("webhook_key_hash"),
  webhookVerifiedAt: integer("webhook_verified_at", { mode: "timestamp" }),
  redeliveryAcknowledgedAt: integer("redelivery_acknowledged_at", { mode: "timestamp" }),
  nativeRepliesDisabledAcknowledgedAt: integer("native_replies_disabled_acknowledged_at", { mode: "timestamp" }),
  providerTestedAt: integer("provider_tested_at", { mode: "timestamp" }),
  version: integer("version").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("support_configurations_connection_unique").on(table.platformConnectionId),
  uniqueIndex("support_configurations_webhook_key_unique").on(table.webhookKeyHash),
]);

export const supportFaqs = sqliteTable("support_faqs", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  category: text("category").notNull(),
  keywordsJson: text("keywords_json").notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("support_faqs_owner_enabled_idx").on(table.ownerEmail, table.enabled, table.priority),
]);

export const supportConversations = sqliteTable("support_conversations", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  platformConnectionId: text("platform_connection_id")
    .notNull()
    .references(() => platformConnections.id),
  platform: text("platform").notNull(),
  customerLookupKey: text("customer_lookup_key").notNull(),
  encryptedCustomerExternalId: text("encrypted_customer_external_id").notNull(),
  status: text("status").notNull().default("ai_active"),
  handoffReasonCode: text("handoff_reason_code"),
  unreadCount: integer("unread_count").notNull().default(0),
  pendingTransitionId: text("pending_transition_id")
    .references(() => supportConversationTransitions.id),
  pendingAction: text("pending_action"),
  pendingActionEffectiveAt: integer("pending_action_effective_at", { mode: "timestamp" }),
  processingClaimId: text("processing_claim_id"),
  processingClaimExpiresAt: integer("processing_claim_expires_at", { mode: "timestamp" }),
  version: integer("version").notNull().default(0),
  lastInboundAt: integer("last_inbound_at", { mode: "timestamp" }),
  lastOutboundAt: integer("last_outbound_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("support_conversations_owner_status_updated_idx").on(table.ownerEmail, table.status, table.updatedAt),
  uniqueIndex("support_conversations_customer_unique").on(table.platformConnectionId, table.customerLookupKey),
]);

export const supportMessages = sqliteTable("support_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => supportConversations.id),
  direction: text("direction").notNull(),
  senderType: text("sender_type").notNull(),
  messageType: text("message_type").notNull(),
  textContent: text("text_content"),
  safeMetadataJson: text("safe_metadata_json").notNull().default("{}"),
  providerMessageId: text("provider_message_id"),
  deliveryStatus: text("delivery_status").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  failedAt: integer("failed_at", { mode: "timestamp" }),
  safeErrorCode: text("safe_error_code"),
  processedAt: integer("processed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("support_messages_conversation_created_idx").on(table.conversationId, table.createdAt),
  uniqueIndex("support_messages_idempotency_unique").on(table.idempotencyKey),
]);

export const supportAiDecisions = sqliteTable("support_ai_decisions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => supportConversations.id),
  inboundMessageId: text("inbound_message_id")
    .notNull()
    .references(() => supportMessages.id),
  action: text("action").notNull(),
  category: text("category"),
  reasonCode: text("reason_code"),
  answerMessageId: text("answer_message_id").references(() => supportMessages.id),
  faqIdsJson: text("faq_ids_json").notNull().default("[]"),
  llmProvider: text("llm_provider"),
  llmModel: text("llm_model"),
  promptVersion: text("prompt_version").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const supportWebhookEvents = sqliteTable("support_webhook_events", {
  id: text("id").primaryKey(),
  platformConnectionId: text("platform_connection_id")
    .notNull()
    .references(() => platformConnections.id),
  webhookEventId: text("webhook_event_id").notNull(),
  sourceType: text("source_type").notNull(),
  processingStatus: text("processing_status").notNull(),
  encryptedReplyToken: text("encrypted_reply_token"),
  replyTokenExpiresAt: integer("reply_token_expires_at", { mode: "timestamp" }),
  safeErrorCode: text("safe_error_code"),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("support_webhook_events_connection_event_unique")
    .on(table.platformConnectionId, table.webhookEventId),
]);

export const supportConversationTransitions = sqliteTable("support_conversation_transitions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => supportConversations.id),
  requestedAction: text("requested_action").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  requestedByOwnerEmail: text("requested_by_owner_email").notNull(),
  expectedVersion: integer("expected_version").notNull(),
  requestedAt: integer("requested_at", { mode: "timestamp" }).notNull(),
  effectiveAt: integer("effective_at", { mode: "timestamp" }).notNull(),
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  committedAt: integer("committed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("support_transitions_conversation_created_idx").on(table.conversationId, table.createdAt),
]);
