-- Connected machines belong to their user, not a workspace (#318). machine.workspace_id becomes
-- nullable and is kept only for adopted GitHub runners; created_by becomes user_id, set only for
-- connected machines, and deleting the user deletes them. A connected machine whose owner is
-- already gone has nobody to belong to, so it goes.
--
-- SQLite can't drop NOT NULL in place, so the table is rebuilt. D1 always enforces foreign keys,
-- and dropping the old table runs an implicit DELETE that sets workflow_job.machine_id and
-- activity_event.machine_id to null (ON DELETE set null). Those links are copied aside first and
-- put back after.
CREATE TABLE `_machine_link` (
	`kind` text NOT NULL,
	`row_id` integer NOT NULL,
	`machine_id` text NOT NULL
);--> statement-breakpoint
INSERT INTO `_machine_link` (`kind`, `row_id`, `machine_id`)
SELECT 'job', `id`, `machine_id` FROM `workflow_job` WHERE `machine_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `_machine_link` (`kind`, `row_id`, `machine_id`)
SELECT 'event', `id`, `machine_id` FROM `activity_event` WHERE `machine_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_machine` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`name` text NOT NULL,
	`os` text,
	`arch` text,
	`token_hash` text,
	`pending_token_hash` text,
	`enrollment_hash` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	`paused_at` integer,
	`paused_by` text,
	`source` text DEFAULT 'connect' NOT NULL,
	`sharing` text DEFAULT 'only_me' NOT NULL,
	`installation_id` integer,
	`github_runner_id` integer,
	`routing_label` text,
	`github_labels` text,
	`device_kind` text,
	`device_model` text,
	`device_model_id` text,
	`chip` text,
	`cpu_cores` integer,
	`memory_mb` integer,
	`os_version` text,
	`device_reported_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`paused_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_machine`("id", "workspace_id", "user_id", "name", "os", "arch", "token_hash", "pending_token_hash", "enrollment_hash", "last_seen_at", "revoked_at", "paused_at", "paused_by", "source", "sharing", "installation_id", "github_runner_id", "routing_label", "github_labels", "device_kind", "device_model", "device_model_id", "chip", "cpu_cores", "memory_mb", "os_version", "device_reported_at", "created_at", "updated_at")
SELECT "id",
	CASE WHEN "source" = 'github' THEN "workspace_id" END,
	CASE WHEN "source" = 'github' THEN NULL ELSE "created_by" END,
	"name", "os", "arch", "token_hash", "pending_token_hash", "enrollment_hash", "last_seen_at", "revoked_at", "paused_at", "paused_by", "source", "sharing", "installation_id", "github_runner_id", "routing_label", "github_labels", "device_kind", "device_model", "device_model_id", "chip", "cpu_cores", "memory_mb", "os_version", "device_reported_at", "created_at", "updated_at"
FROM `machine`
WHERE "source" = 'github' OR "created_by" IS NOT NULL;--> statement-breakpoint
DROP TABLE `machine`;--> statement-breakpoint
ALTER TABLE `__new_machine` RENAME TO `machine`;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_token_hash_unique` ON `machine` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_pending_token_hash_unique` ON `machine` (`pending_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_enrollment_hash_unique` ON `machine` (`enrollment_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_routing_label_unique` ON `machine` (`routing_label`);--> statement-breakpoint
CREATE INDEX `machine_workspace_idx` ON `machine` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `machine_user_idx` ON `machine` (`user_id`);--> statement-breakpoint
CREATE INDEX `machine_github_runner_idx` ON `machine` (`installation_id`,`github_runner_id`);--> statement-breakpoint
UPDATE `workflow_job` SET `machine_id` = (
	SELECT l.`machine_id` FROM `_machine_link` l WHERE l.`kind` = 'job' AND l.`row_id` = `workflow_job`.`id`
)
WHERE `id` IN (
	SELECT l.`row_id` FROM `_machine_link` l JOIN `machine` m ON m.`id` = l.`machine_id` WHERE l.`kind` = 'job'
);--> statement-breakpoint
UPDATE `activity_event` SET `machine_id` = (
	SELECT l.`machine_id` FROM `_machine_link` l WHERE l.`kind` = 'event' AND l.`row_id` = `activity_event`.`id`
)
WHERE `id` IN (
	SELECT l.`row_id` FROM `_machine_link` l JOIN `machine` m ON m.`id` = l.`machine_id` WHERE l.`kind` = 'event'
);--> statement-breakpoint
DROP TABLE `_machine_link`;
