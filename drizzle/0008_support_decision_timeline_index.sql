-- Manual migration metadata policy: snapshots stop at the pre-support baseline;
-- drizzle-kit generate is not authoritative for migrations 0004 and later.
CREATE INDEX support_ai_decisions_conversation_created_id_idx
  ON support_ai_decisions (conversation_id, created_at, id);
