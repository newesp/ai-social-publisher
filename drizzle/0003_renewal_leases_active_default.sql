ALTER TABLE `platform_connections` ADD `renewal_lease_id` text;--> statement-breakpoint
ALTER TABLE `platform_connections` ADD `renewal_lease_expires_at` integer;--> statement-breakpoint
UPDATE `platform_connections` AS `current`
SET `state` = 'archived'
WHERE `current`.`state` = 'active'
  AND EXISTS (
    SELECT 1 FROM `platform_connections` AS `newer`
    WHERE `newer`.`owner_email` = `current`.`owner_email`
      AND `newer`.`platform` = `current`.`platform`
      AND `newer`.`state` = 'active'
      AND (`newer`.`updated_at` > `current`.`updated_at`
        OR (`newer`.`updated_at` = `current`.`updated_at` AND `newer`.`id` > `current`.`id`))
  );--> statement-breakpoint
CREATE UNIQUE INDEX `platform_connections_one_active_owner_platform_idx` ON `platform_connections` (`owner_email`,`platform`) WHERE "platform_connections"."state" = 'active';
