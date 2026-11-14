-- The repo a runner added from GitHub is registered on, for repo-level runners (#162). Null for
-- org runners.

ALTER TABLE `machine` ADD `github_repository_id` integer;
