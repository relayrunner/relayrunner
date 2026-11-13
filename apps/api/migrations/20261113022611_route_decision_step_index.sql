DROP INDEX `route_decision_workspace_step_idx`;--> statement-breakpoint
CREATE INDEX `route_decision_step_workspace_idx` ON `route_decision` (`step`,`workspace_id`,`created_at`);