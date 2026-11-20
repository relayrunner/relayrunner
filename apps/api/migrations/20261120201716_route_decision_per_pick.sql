DROP INDEX `route_decision_run_idx`;--> statement-breakpoint
ALTER TABLE `route_decision` ADD `pick_job_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `route_decision_pick_idx` ON `route_decision` (`repository_id`,`run_id`,`run_attempt`,`pick_job_id`);