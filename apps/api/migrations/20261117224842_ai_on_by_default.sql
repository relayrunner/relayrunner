-- AI is on by default: workspaces record when they turn it off instead of when they turned it on.
-- Renaming keeps the foreign key and skips rebuilding the table. Every workspace starts on.
ALTER TABLE `workspace` RENAME COLUMN `ai_opt_in_at` TO `ai_off_at`;--> statement-breakpoint
ALTER TABLE `workspace` RENAME COLUMN `ai_opt_in_by` TO `ai_off_by`;--> statement-breakpoint
UPDATE `workspace` SET `ai_off_at` = NULL, `ai_off_by` = NULL;--> statement-breakpoint
DROP INDEX `workspace_ai_opt_in_idx`;--> statement-breakpoint
CREATE INDEX `workspace_ai_off_idx` ON `workspace` (`ai_off_at`);
