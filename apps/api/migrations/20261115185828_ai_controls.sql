CREATE TABLE `ai_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`feature` text NOT NULL,
	`answers` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_cache_expires_idx` ON `ai_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ai_setting` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`features` text NOT NULL,
	`workspace_daily_tokens` integer NOT NULL,
	`daily_tokens` integer NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `ai_usage_day` (
	`day` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`feature` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`cache_hits` integer DEFAULT 0 NOT NULL,
	`limited` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `workspace_id`, `feature`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_usage_day_workspace_idx` ON `ai_usage_day` (`workspace_id`,`day`);--> statement-breakpoint
CREATE TABLE `workspace_ai_setting` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`features` text,
	`daily_tokens` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
