CREATE TABLE `pull_request` (
	`repository_id` integer NOT NULL,
	`number` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`opened_at` integer,
	`merged_at` integer,
	`closed_at` integer,
	`github_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `number`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_installation_idx` ON `pull_request` (`installation_id`);