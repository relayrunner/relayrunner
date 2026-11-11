ALTER TABLE `machine` ADD `source` text DEFAULT 'connect' NOT NULL;--> statement-breakpoint
ALTER TABLE `machine` ADD `installation_id` integer REFERENCES github_installation(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `machine` ADD `github_runner_id` integer;--> statement-breakpoint
ALTER TABLE `machine` ADD `routing_label` text;--> statement-breakpoint
ALTER TABLE `machine` ADD `github_labels` text;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_routing_label_unique` ON `machine` (`routing_label`);--> statement-breakpoint
CREATE INDEX `machine_github_runner_idx` ON `machine` (`installation_id`,`github_runner_id`);