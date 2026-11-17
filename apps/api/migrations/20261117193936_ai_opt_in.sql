ALTER TABLE `workspace` ADD `ai_opt_in_at` integer;--> statement-breakpoint
ALTER TABLE `workspace` ADD `ai_opt_in_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `workspace_ai_opt_in_idx` ON `workspace` (`ai_opt_in_at`);--> statement-breakpoint
CREATE INDEX `ai_cache_workspace_idx` ON `ai_cache` (`workspace_id`);--> statement-breakpoint
-- Workspaces an operator already turned AI on for keep it on, as opted in. An operator row that
-- only said "off" no longer means anything (no opt-in is off), so it goes, or it would block the
-- workspace once it opts in.
UPDATE `workspace` SET `ai_opt_in_at` = (
  SELECT `updated_at` FROM `workspace_ai_setting` WHERE `workspace_id` = `workspace`.`id`
) WHERE `id` IN (SELECT `workspace_id` FROM `workspace_ai_setting` WHERE `enabled` = 1);--> statement-breakpoint
DELETE FROM `workspace_ai_setting` WHERE `enabled` = 0 AND `features` IS NULL AND `daily_tokens` IS NULL;
