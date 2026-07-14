CREATE TABLE `platform_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_email` text NOT NULL,
  `platform` text NOT NULL,
  `display_name` text NOT NULL,
  `state` text NOT NULL,
  `encrypted_credentials` text NOT NULL,
  `credential_expires_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_connections_owner_platform_state_idx` ON `platform_connections` (`owner_email`,`platform`,`state`);
--> statement-breakpoint
CREATE TABLE `oauth_transactions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_email` text NOT NULL,
  `provider` text NOT NULL,
  `encrypted_payload` text NOT NULL,
  `return_path` text NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_transactions_expires_at_idx` ON `oauth_transactions` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `post_targets` ADD `platform_connection_id` text REFERENCES `platform_connections`(`id`);
