CREATE TABLE `signal_day` (
	`installation_id` integer NOT NULL,
	`day` integer NOT NULL,
	`signal` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`subject` text NOT NULL,
	`workflow_path` text,
	`count` integer NOT NULL,
	`run_ms` integer NOT NULL,
	`cost` real NOT NULL,
	PRIMARY KEY(`installation_id`, `day`, `signal`, `repository_id`, `subject`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signal_day_day_idx` ON `signal_day` (`day`);--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `workflow_id` integer;--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `workflow_path` text;--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `default_branch` text;--> statement-breakpoint
CREATE INDEX `workflow_run_branch_idx` ON `workflow_run` (`repository_id`,`head_branch`,`run_started_at`);--> statement-breakpoint
CREATE INDEX `workflow_run_sha_idx` ON `workflow_run` (`repository_id`,`head_sha`);