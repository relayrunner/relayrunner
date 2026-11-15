CREATE TABLE `pull_request_paths` (
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`pull_request_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`areas` text NOT NULL,
	`docs_only` integer NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `pull_request_number`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_paths_read_idx` ON `pull_request_paths` (`read_at`);