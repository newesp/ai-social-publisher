CREATE TABLE `support_outbound_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `webhook_event_id` text NOT NULL REFERENCES `support_webhook_events`(`id`),
  `conversation_id` text NOT NULL REFERENCES `support_conversations`(`id`),
  `encrypted_recipient` text NOT NULL,
  `encrypted_canonical_body` text NOT NULL,
  `retry_key` text NOT NULL,
  `delivery_status` text NOT NULL,
  `delivery_claim_id` text,
  `delivery_claim_expires_at` integer,
  `attempt_count` integer NOT NULL DEFAULT 0,
  `first_attempt_at` integer,
  `last_attempt_at` integer,
  `next_attempt_at` integer,
  `accepted_request_id` text,
  `safe_error_code` text,
  `sent_at` integer,
  `failed_at` integer,
  `human_review_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_outbound_deliveries_event_unique`
  ON `support_outbound_deliveries` (`webhook_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_outbound_deliveries_retry_key_unique`
  ON `support_outbound_deliveries` (`retry_key`);
--> statement-breakpoint
CREATE INDEX `support_outbound_deliveries_status_next_attempt_idx`
  ON `support_outbound_deliveries` (`delivery_status`,`next_attempt_at`);
