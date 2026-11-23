CREATE TABLE `repo_runner_order` (
	`workspace_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository` text NOT NULL,
	`runner_order` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `repository_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
