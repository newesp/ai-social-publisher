ALTER TABLE support_conversations ADD COLUMN ai_closure_confirmation_message_id text REFERENCES support_messages(id);
--> statement-breakpoint
ALTER TABLE support_conversations ADD COLUMN ai_closure_confirmation_expires_at integer;

--> statement-breakpoint
ALTER TABLE support_ai_decisions ADD COLUMN conversation_disposition text NOT NULL DEFAULT 'continue_ai';
--> statement-breakpoint
ALTER TABLE support_ai_decisions ADD COLUMN handoff_summary text;
--> statement-breakpoint
ALTER TABLE support_ai_decisions ADD COLUMN human_checklist_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE support_ai_decisions ADD COLUMN prohibited_commitments_json text NOT NULL DEFAULT '[]';
