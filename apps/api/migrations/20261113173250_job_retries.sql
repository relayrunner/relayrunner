CREATE TABLE `job_retry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt` integer NOT NULL,
	`job_id` integer NOT NULL,
	`relay_job_id` integer NOT NULL,
	`kind` text NOT NULL,
	`runner` text NOT NULL,
	`failed_step` text,
	`failed_machine_id` text,
	`triggered_by_id` integer,
	`triggered_by_login` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_retry_attempt_idx` ON `job_retry` (`repository_id`,`run_id`,`run_attempt`);--> statement-breakpoint
CREATE INDEX `job_retry_workspace_idx` ON `job_retry` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `workflow_job` ADD `ran_steps` integer;--> statement-breakpoint
ALTER TABLE `workspace` ADD `retry_settings` text;