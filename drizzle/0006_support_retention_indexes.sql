CREATE INDEX support_messages_retention_created_idx
  ON support_messages (created_at, id)
  WHERE text_content IS NOT NULL;
--> statement-breakpoint
CREATE INDEX support_webhook_events_retention_reply_token_idx
  ON support_webhook_events (reply_token_expires_at, id)
  WHERE encrypted_reply_token IS NOT NULL;
--> statement-breakpoint
CREATE INDEX support_outbound_deliveries_retention_status_created_idx
  ON support_outbound_deliveries (delivery_status, created_at, id)
  WHERE encrypted_canonical_body <> '';
