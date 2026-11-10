ALTER TABLE `machine` ADD `sharing` text DEFAULT 'only_me' NOT NULL;--> statement-breakpoint
-- Runners added from GitHub are the org's shared runners: they take anyone's jobs (#242).
UPDATE `machine` SET `sharing` = 'anyone' WHERE `source` = 'github';
