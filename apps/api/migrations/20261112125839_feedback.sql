-- Hand-edited: drizzle-kit's rebuild for this rename selected the new columns from the old table.
-- Feedback now also comes from the dashboard, not only agents.
ALTER TABLE `agent_feedback` RENAME TO `feedback`;--> statement-breakpoint
ALTER TABLE `feedback` ADD `source` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE `feedback` ADD `page` text;--> statement-breakpoint
DROP INDEX `agent_feedback_user_id_created_at_idx`;--> statement-breakpoint
CREATE INDEX `feedback_user_id_created_at_idx` ON `feedback` (`user_id`,`created_at`);
