ALTER TABLE `job_timing` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `job_timing` ADD `queued_at` integer;--> statement-breakpoint
CREATE INDEX `job_timing_machine_idx` ON `job_timing` (`machine_id`,`completed_at`) WHERE "job_timing"."machine_id" is not null;--> statement-breakpoint
CREATE INDEX `job_timing_job_idx` ON `job_timing` (`repository_id`,`workflow_name`,`name`,`completed_at`);