CREATE TABLE `job_type` (
	`workspace_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`workflow` text NOT NULL,
	`job` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real NOT NULL,
	`classified_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `repository_id`, `workflow`, `job`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
