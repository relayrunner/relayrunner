CREATE TABLE `job_timing` (
	`id` integer PRIMARY KEY NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt` integer NOT NULL,
	`workflow_name` text,
	`name` text NOT NULL,
	`labels` text NOT NULL,
	`conclusion` text,
	`runner_name` text,
	`runner_group_name` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_timing_installation_idx` ON `job_timing` (`installation_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `job_timing_completed_idx` ON `job_timing` (`completed_at`);