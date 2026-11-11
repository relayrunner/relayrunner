CREATE INDEX `activity_event_type_time_idx` ON `activity_event` (`type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `route_decision_created_idx` ON `route_decision` (`created_at`);--> statement-breakpoint
CREATE INDEX `route_decision_workspace_step_idx` ON `route_decision` (`workspace_id`,`step`);