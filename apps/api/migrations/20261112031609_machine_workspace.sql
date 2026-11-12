-- Which workspaces a connected machine takes jobs in (#363). Every machine that isn't revoked
-- starts in each of its owner's current workspaces, so nothing that routes today stops.
CREATE TABLE `machine_workspace` (
	`machine_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `workspace_id`),
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `machine_workspace_workspace_idx` ON `machine_workspace` (`workspace_id`);--> statement-breakpoint
INSERT INTO `machine_workspace` (`machine_id`, `workspace_id`, `created_at`)
SELECT `machine`.`id`, `workspace_member`.`workspace_id`, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM `machine`
INNER JOIN `workspace_member` ON `workspace_member`.`user_id` = `machine`.`user_id`
WHERE `machine`.`source` = 'connect' AND `machine`.`revoked_at` IS NULL;