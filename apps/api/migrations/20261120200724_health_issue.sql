CREATE TABLE `health_issue` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`installation_id` integer,
	`error` text NOT NULL,
	`failures` integer NOT NULL,
	`first_failed_at` integer NOT NULL,
	`last_failed_at` integer NOT NULL,
	`cleared_at` integer,
	`alerted_at` integer
);
--> statement-breakpoint
CREATE INDEX `health_issue_kind_idx` ON `health_issue` (`kind`);