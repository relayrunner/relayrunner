CREATE TABLE `runner_release` (
	`version` text PRIMARY KEY NOT NULL,
	`published_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `machine` ADD `runner_version` text;