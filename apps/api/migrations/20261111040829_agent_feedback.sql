CREATE TABLE `agent_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text,
	`grant_id` text,
	`client_id` text,
	`category` text NOT NULL,
	`summary` text NOT NULL,
	`details` text,
	`tool` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_feedback_user_id_created_at_idx` ON `agent_feedback` (`user_id`,`created_at`);