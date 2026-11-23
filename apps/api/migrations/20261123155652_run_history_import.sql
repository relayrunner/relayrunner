CREATE TABLE `run_history_import` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`error` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
