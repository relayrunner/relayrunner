CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_provider_account_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `activity_event_machine_idx` ON `activity_event` (`machine_id`) WHERE "activity_event"."machine_id" is not null;--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `workflow_job_kind_created_idx` ON `workflow_job` (`kind`,`github_created_at`);--> statement-breakpoint
CREATE INDEX `workflow_job_machine_idx` ON `workflow_job` (`machine_id`,`status`) WHERE "workflow_job"."machine_id" is not null;--> statement-breakpoint
-- Refresh the planner stats so it picks the new indexes.
PRAGMA optimize;
