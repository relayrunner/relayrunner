-- GitHub sends an empty runner name and group for a job that ended before any runner took it
-- (cancelled while queued). Stored as is, those jobs counted as runs on a runner named "" in the
-- Default group. Null is how every report already says "no runner".
UPDATE `job_timing` SET `runner_name` = NULL WHERE `runner_name` = '';--> statement-breakpoint
UPDATE `job_timing` SET `runner_group_name` = NULL WHERE `runner_group_name` = '';--> statement-breakpoint
UPDATE `workflow_job` SET `runner_name` = NULL WHERE `runner_name` = '';
