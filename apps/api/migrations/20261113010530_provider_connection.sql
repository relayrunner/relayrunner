-- Third-party provider accounts a workspace connected with a read-only token, and the usage the
-- hourly sync reads from them (src/provider-sync.ts).
CREATE TABLE `provider_connection` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`token` text NOT NULL,
	`token_hint` text NOT NULL,
	`options` text NOT NULL,
	`account_name` text,
	`connected_by` text,
	`synced_through` integer,
	`last_synced_at` integer,
	`failure` text,
	`error` text,
	`failed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `provider_daily_usage` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`day` integer NOT NULL,
	`unit` text NOT NULL,
	`quantity` real NOT NULL,
	`cost_usd` real,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`, `day`, `unit`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_daily_usage_day_idx` ON `provider_daily_usage` (`day`);--> statement-breakpoint
CREATE TABLE `provider_job_usage` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`job_id` text NOT NULL,
	`run_id` text,
	`repository` text,
	`job_name` text,
	`runner_label` text,
	`started_at` integer,
	`finished_at` integer,
	`billable_seconds` real,
	`queue_seconds` real,
	`cost_usd` real,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`, `job_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_job_usage_workspace_idx` ON `provider_job_usage` (`workspace_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `provider_job_usage_finished_idx` ON `provider_job_usage` (`finished_at`);