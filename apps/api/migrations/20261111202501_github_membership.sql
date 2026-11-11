-- Membership comes from GitHub (#317): the installer is recorded as the workspace's owner, and
-- each user remembers when their memberships were last synced. Old invites are cleared; nothing
-- writes them any more.
ALTER TABLE `github_installation` ADD `installer_github_id` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `installations_synced_at` integer;--> statement-breakpoint
DELETE FROM `workspace_invitation`;
