CREATE TABLE `job_count` (
	`installation_id` integer NOT NULL,
	`hour` integer NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`installation_id`, `hour`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_count_hour_idx` ON `job_count` (`hour`);--> statement-breakpoint
CREATE TABLE `job_count_day` (
	`day` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `installation_id`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_count_hour` (
	`hour` integer PRIMARY KEY NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- Counts the jobs job_timing still holds (its last 31 days), the way countFinishedJob does
-- (src/job-counts.ts): skipped jobs and picks left out. The other two rollups sum this one.
INSERT INTO `job_count` (`installation_id`, `hour`, `success`, `failed`, `cancelled`)
SELECT `installation_id`, `completed_at` / 3600000 * 3600000,
	sum(`conclusion` = 'success'),
	sum(`conclusion` IN ('failure', 'timed_out')),
	sum(coalesce(`conclusion`, '') NOT IN ('success', 'failure', 'timed_out'))
FROM `job_timing`
WHERE `completed_at` IS NOT NULL
	AND coalesce(`conclusion`, '') != 'skipped'
	AND lower(`labels`) NOT LIKE '%"relayrunner"%'
GROUP BY 1, 2;
--> statement-breakpoint
INSERT INTO `job_count_hour` (`hour`, `success`, `failed`, `cancelled`)
SELECT `hour`, sum(`success`), sum(`failed`), sum(`cancelled`) FROM `job_count` GROUP BY 1;
--> statement-breakpoint
INSERT INTO `job_count_day` (`day`, `installation_id`, `success`, `failed`, `cancelled`)
SELECT `hour` / 86400000 * 86400000, `installation_id`, sum(`success`), sum(`failed`), sum(`cancelled`)
FROM `job_count` GROUP BY 1, 2;
