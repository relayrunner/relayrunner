CREATE TABLE `auto_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository` text NOT NULL,
	`workflow_path` text NOT NULL,
	`workflow` text,
	`relay_job` text NOT NULL,
	`size` integer,
	`first` text,
	`updated_by` text,
	`updated_at` integer,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auto_job_identity_idx` ON `auto_job` (`workspace_id`,`repository_id`,`workflow_path`,`relay_job`);--> statement-breakpoint
ALTER TABLE `workspace` ADD `auto_size` integer;