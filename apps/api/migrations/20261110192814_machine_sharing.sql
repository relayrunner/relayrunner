ALTER TABLE `machine` ADD `sharing` text DEFAULT 'only_me' NOT NULL;--> statement-breakpoint
ALTER TABLE `machine` ADD `sharing_notice` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- #242: every existing connected machine becomes `only_me` (the column default) and its owner is
-- told once. Runners added from GitHub are the org's shared runners and keep taking anyone's jobs.
UPDATE `machine` SET `sharing` = 'anyone' WHERE `source` = 'github';--> statement-breakpoint
UPDATE `machine` SET `sharing_notice` = 1 WHERE `source` <> 'github' AND `revoked_at` IS NULL;
