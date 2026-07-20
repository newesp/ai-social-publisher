CREATE INDEX support_conversations_inbox_covering_idx
  ON support_conversations (
    owner_email,
    updated_at DESC,
    id DESC,
    status,
    unread_count,
    handoff_reason_code,
    last_inbound_at,
    last_outbound_at,
    pending_transition_id
  );
--> statement-breakpoint
CREATE INDEX support_outbound_deliveries_conversation_status_idx
  ON support_outbound_deliveries (conversation_id, delivery_status);
