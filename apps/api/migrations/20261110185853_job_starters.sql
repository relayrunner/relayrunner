ALTER TABLE `route_decision` ADD `started_by_id` integer;--> statement-breakpoint
ALTER TABLE `route_decision` ADD `started_by_login` text;--> statement-breakpoint
ALTER TABLE `route_decision` ADD `triggered_by_id` integer;--> statement-breakpoint
ALTER TABLE `route_decision` ADD `triggered_by_login` text;--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `started_by_id` integer;--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `started_by_login` text;--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `triggered_by_id` integer;--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `triggered_by_login` text;