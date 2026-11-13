CREATE TABLE `job_count` (
	`hour` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour`, `installation_id`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Counts the jobs job_timing still holds (its last 31 days), the way countFinishedJob does
-- (src/job-counts.ts): skipped jobs and picks left out.
INSERT INTO `job_count` (`hour`, `installation_id`, `success`, `failed`, `cancelled`)
SELECT `completed_at` / 3600000 * 3600000, `installation_id`,
	sum(`conclusion` = 'success'),
	sum(`conclusion` IN ('failure', 'timed_out')),
	sum(coalesce(`conclusion`, '') NOT IN ('success', 'failure', 'timed_out'))
FROM `job_timing`
WHERE `completed_at` IS NOT NULL
	AND coalesce(`conclusion`, '') != 'skipped'
	AND lower(`labels`) NOT LIKE '%"relayrunner"%'
GROUP BY 1, 2;
