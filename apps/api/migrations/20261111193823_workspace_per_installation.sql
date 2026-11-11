-- One workspace per GitHub App installation (#316). Pre-launch, so workspace data is reset and
-- rebuilt rather than migrated: installations, repos, job history and machines stay; invitations,
-- runner orders, agent grants, activity and route decisions go. Each old workspace's members are
-- copied into the workspaces rebuilt from its installations, until membership comes from GitHub
-- (#317).
--
-- D1 always enforces foreign keys, and rebuilding a table (drizzle-kit's usual DROP + RENAME)
-- would cascade-delete everything under it, so this only uses ALTER TABLE (see the end). SQLite can't add a
-- NOT NULL column with no default, so workspace.installation_id is nullable in the database;
-- the app always sets it (src/installations.ts ensureWorkspace) and schema.ts types it NOT NULL.
ALTER TABLE `workspace` ADD `installation_id` integer REFERENCES `github_installation`(`id`) ON DELETE cascade;--> statement-breakpoint

-- Which workspace each installation gets. An old workspace keeps its id (so its machines and
-- members stay put) for its lowest installation id; every other installation, including unclaimed
-- ones, gets a new workspace.
CREATE TABLE `_workspace_reset` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`old_workspace_id` text,
	`workspace_id` text NOT NULL
);--> statement-breakpoint
INSERT INTO `_workspace_reset` (`installation_id`, `old_workspace_id`, `workspace_id`)
SELECT
	i.`id`,
	i.`workspace_id`,
	CASE
		WHEN i.`workspace_id` IS NOT NULL AND i.`id` = (
			SELECT min(o.`id`) FROM `github_installation` o WHERE o.`workspace_id` = i.`workspace_id`
		) THEN i.`workspace_id`
		ELSE lower(hex(randomblob(16)))
	END
FROM `github_installation` i;--> statement-breakpoint

-- Free every slug first, so renaming kept workspaces after their accounts can't collide with an
-- old workspace's slug.
UPDATE `workspace` SET `slug` = `id`;--> statement-breakpoint
UPDATE `workspace` SET
	`installation_id` = (SELECT r.`installation_id` FROM `_workspace_reset` r WHERE r.`workspace_id` = `workspace`.`id`),
	`runner_order` = NULL,
	`metadata` = NULL
WHERE `id` IN (SELECT `workspace_id` FROM `_workspace_reset`);--> statement-breakpoint
INSERT INTO `workspace` (`id`, `installation_id`, `name`, `slug`, `created_at`)
SELECT r.`workspace_id`, r.`installation_id`, r.`workspace_id`, r.`workspace_id`, CAST(unixepoch('subsec') * 1000 AS integer)
FROM `_workspace_reset` r
WHERE r.`workspace_id` NOT IN (SELECT `id` FROM `workspace`);--> statement-breakpoint
UPDATE `workspace` SET
	`name` = (SELECT i.`account_login` FROM `github_installation` i WHERE i.`id` = `workspace`.`installation_id`),
	`slug` = (SELECT lower(i.`account_login`) FROM `github_installation` i WHERE i.`id` = `workspace`.`installation_id`),
	`logo` = (SELECT 'https://avatars.githubusercontent.com/u/' || i.`account_id` || '?v=4' FROM `github_installation` i WHERE i.`id` = `workspace`.`installation_id`)
WHERE `installation_id` IS NOT NULL;--> statement-breakpoint

-- Members of an old workspace join every workspace rebuilt from its installations, same role.
INSERT INTO `workspace_member` (`id`, `workspace_id`, `user_id`, `role`, `created_at`)
SELECT lower(hex(randomblob(16))), r.`workspace_id`, m.`user_id`, m.`role`, m.`created_at`
FROM `_workspace_reset` r
JOIN `workspace_member` m ON m.`workspace_id` = r.`old_workspace_id`
WHERE r.`workspace_id` <> r.`old_workspace_id`;--> statement-breakpoint

-- Adopted GitHub runners follow their installation. Connected machines in a workspace with no
-- installation move to another workspace their owner is in, if there is one.
UPDATE `machine` SET `workspace_id` = (
	SELECT r.`workspace_id` FROM `_workspace_reset` r WHERE r.`installation_id` = `machine`.`installation_id`
)
WHERE `source` = 'github' AND `installation_id` IN (SELECT `installation_id` FROM `_workspace_reset`);--> statement-breakpoint
UPDATE `machine` SET `workspace_id` = (
	SELECT min(m.`workspace_id`) FROM `workspace_member` m
	JOIN `workspace` w ON w.`id` = m.`workspace_id` AND w.`installation_id` IS NOT NULL
	WHERE m.`user_id` = `machine`.`created_by`
)
WHERE `workspace_id` IN (SELECT `id` FROM `workspace` WHERE `installation_id` IS NULL)
	AND EXISTS (
		SELECT 1 FROM `workspace_member` m
		JOIN `workspace` w ON w.`id` = m.`workspace_id` AND w.`installation_id` IS NOT NULL
		WHERE m.`user_id` = `machine`.`created_by`
	);--> statement-breakpoint

-- Workspace-scoped data that doesn't carry over.
DELETE FROM `workspace_invitation`;--> statement-breakpoint
DELETE FROM `agent_grant`;--> statement-breakpoint
DELETE FROM `activity_event`;--> statement-breakpoint
DELETE FROM `route_decision`;--> statement-breakpoint
-- Workspaces with no installation go, with whatever is still under them.
DELETE FROM `workspace` WHERE `installation_id` IS NULL;--> statement-breakpoint
UPDATE `session` SET `active_workspace_id` = NULL
WHERE `active_workspace_id` NOT IN (SELECT `id` FROM `workspace`);--> statement-breakpoint
DROP TABLE `_workspace_reset`;--> statement-breakpoint

CREATE UNIQUE INDEX `workspace_installation_id_unique` ON `workspace` (`installation_id`);--> statement-breakpoint
-- github_installation.workspace_id is gone from schema.ts, but SQLite won't drop a column with a
-- foreign key, and rebuilding the table would cascade-delete its repos and jobs. So the column
-- stays in the database, empty and unread.
DROP INDEX `github_installation_workspace_idx`;--> statement-breakpoint
UPDATE `github_installation` SET `workspace_id` = NULL;
