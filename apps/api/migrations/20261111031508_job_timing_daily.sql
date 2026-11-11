CREATE TABLE `job_timing_daily` (
	`installation_id` integer NOT NULL,
	`day` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`labels` text NOT NULL,
	`runner_group_name` text DEFAULT '' NOT NULL,
	`jobs` integer NOT NULL,
	`short_jobs` integer NOT NULL,
	`run_ms` integer NOT NULL,
	`billed_minutes` integer NOT NULL,
	`short_billed_minutes` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `day`, `repository_id`, `labels`, `runner_group_name`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_timing_daily_day_idx` ON `job_timing_daily` (`day`);