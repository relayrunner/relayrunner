CREATE TABLE `agent_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_grant_session_id_idx` ON `agent_grant` (`session_id`);--> statement-breakpoint
CREATE TABLE `agent_grant_workspace` (
	`grant_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`grant_id`, `workspace_id`),
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_grant_workspace_workspace_id_idx` ON `agent_grant_workspace` (`workspace_id`);