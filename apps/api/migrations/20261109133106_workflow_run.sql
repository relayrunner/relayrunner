CREATE TABLE `workflow_run` (
	`id` integer NOT NULL,
	`run_attempt` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`workflow_name` text,
	`display_title` text,
	`event` text NOT NULL,
	`actor_login` text,
	`head_branch` text,
	`head_sha` text NOT NULL,
	`pull_request_number` integer,
	`status` text NOT NULL,
	`conclusion` text,
	`html_url` text,
	`run_started_at` integer,
	`github_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`id`, `run_attempt`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_run_installation_idx` ON `workflow_run` (`installation_id`,`github_updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_run_updated_idx` ON `workflow_run` (`github_updated_at`);--> statement-breakpoint
CREATE INDEX `job_timing_run_idx` ON `job_timing` (`run_id`,`run_attempt`);