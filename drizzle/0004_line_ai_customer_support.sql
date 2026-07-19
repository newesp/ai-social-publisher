CREATE TABLE `support_configurations` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_email` text NOT NULL,
  `platform_connection_id` text NOT NULL REFERENCES `platform_connections`(`id`),
  `brand_name` text NOT NULL DEFAULT '',
  `assistant_name` text NOT NULL DEFAULT '',
  `reply_tone` text NOT NULL DEFAULT 'friendly',
  `llm_provider` text,
  `llm_model` text,
  `support_state` text NOT NULL DEFAULT 'disabled',
  `webhook_key_hash` text,
  `webhook_verified_at` integer,
  `redelivery_acknowledged_at` integer,
  `native_replies_disabled_acknowledged_at` integer,
  `provider_tested_at` integer,
  `version` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_configurations_connection_unique` ON `support_configurations` (`platform_connection_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_configurations_webhook_key_unique` ON `support_configurations` (`webhook_key_hash`);
--> statement-breakpoint
CREATE TABLE `support_faqs` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_email` text NOT NULL,
  `question` text NOT NULL,
  `answer` text NOT NULL,
  `category` text NOT NULL,
  `keywords_json` text NOT NULL DEFAULT '[]',
  `enabled` integer NOT NULL DEFAULT 1,
  `priority` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_faqs_owner_enabled_idx` ON `support_faqs` (`owner_email`,`enabled`,`priority`);
--> statement-breakpoint
CREATE TABLE `support_conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_email` text NOT NULL,
  `platform_connection_id` text NOT NULL REFERENCES `platform_connections`(`id`),
  `platform` text NOT NULL,
  `customer_lookup_key` text NOT NULL,
  `encrypted_customer_external_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'ai_active',
  `handoff_reason_code` text,
  `unread_count` integer NOT NULL DEFAULT 0,
  `pending_transition_id` text REFERENCES `support_conversation_transitions`(`id`),
  `pending_action` text,
  `pending_action_effective_at` integer,
  `processing_claim_id` text,
  `processing_claim_expires_at` integer,
  `version` integer NOT NULL DEFAULT 0,
  `last_inbound_at` integer,
  `last_outbound_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_conversations_owner_status_updated_idx` ON `support_conversations` (`owner_email`,`status`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_conversations_customer_unique` ON `support_conversations` (`platform_connection_id`,`customer_lookup_key`);
--> statement-breakpoint
CREATE TABLE `support_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `support_conversations`(`id`),
  `direction` text NOT NULL,
  `sender_type` text NOT NULL,
  `message_type` text NOT NULL,
  `text_content` text,
  `safe_metadata_json` text NOT NULL DEFAULT '{}',
  `provider_message_id` text,
  `delivery_status` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `sent_at` integer,
  `failed_at` integer,
  `safe_error_code` text,
  `processed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_messages_conversation_created_idx` ON `support_messages` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_messages_idempotency_unique` ON `support_messages` (`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `support_ai_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `support_conversations`(`id`),
  `inbound_message_id` text NOT NULL REFERENCES `support_messages`(`id`),
  `action` text NOT NULL,
  `category` text,
  `reason_code` text,
  `answer_message_id` text REFERENCES `support_messages`(`id`),
  `faq_ids_json` text NOT NULL DEFAULT '[]',
  `llm_provider` text,
  `llm_model` text,
  `prompt_version` text NOT NULL,
  `input_tokens` integer,
  `output_tokens` integer,
  `latency_ms` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_webhook_events` (
  `id` text PRIMARY KEY NOT NULL,
  `platform_connection_id` text NOT NULL REFERENCES `platform_connections`(`id`),
  `webhook_event_id` text NOT NULL,
  `source_type` text NOT NULL,
  `processing_status` text NOT NULL,
  `encrypted_reply_token` text,
  `reply_token_expires_at` integer,
  `safe_error_code` text,
  `received_at` integer NOT NULL,
  `processed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_webhook_events_connection_event_unique` ON `support_webhook_events` (`platform_connection_id`,`webhook_event_id`);
--> statement-breakpoint
CREATE TABLE `support_conversation_transitions` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `support_conversations`(`id`),
  `requested_action` text NOT NULL,
  `from_status` text NOT NULL,
  `to_status` text NOT NULL,
  `requested_by_owner_email` text NOT NULL,
  `expected_version` integer NOT NULL,
  `requested_at` integer NOT NULL,
  `effective_at` integer NOT NULL,
  `cancelled_at` integer,
  `committed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_transitions_conversation_created_idx` ON `support_conversation_transitions` (`conversation_id`,`created_at`);
