ALTER TABLE `posts` ADD `owner_email` text NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `publishing_started_at` integer;--> statement-breakpoint
CREATE INDEX `posts_owner_created_at_idx` ON `posts` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `posts_status_scheduled_for_idx` ON `posts` (`status`,`scheduled_for`);