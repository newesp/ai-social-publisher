DROP INDEX `support_conversations_customer_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `support_conversations_active_customer_unique`
  ON `support_conversations` (`platform_connection_id`,`customer_lookup_key`)
  WHERE `status` <> 'resolved';
