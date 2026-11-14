-- Jobs that ran on a runner added from GitHub before RelayRunner matched them by the runner's name
-- (they asked for it by hand, such as `runs-on: self-hosted`): put them under that runner too.
-- The same match recordJobTiming makes for new jobs, and claimRunnerJobs for a newly added runner.
UPDATE `job_timing` SET `machine_id` = (
	SELECT `machine`.`id` FROM `machine`
	WHERE `machine`.`installation_id` = `job_timing`.`installation_id`
		AND `machine`.`source` = 'github'
		AND `machine`.`name` = `job_timing`.`runner_name`
		AND `machine`.`revoked_at` IS NULL
		AND (`machine`.`github_repository_id` IS NULL OR `machine`.`github_repository_id` = `job_timing`.`repository_id`)
	LIMIT 1
)
WHERE `machine_id` IS NULL
	AND `runner_name` IS NOT NULL
	AND coalesce(`runner_group_name`, '') <> 'GitHub Actions'
	AND EXISTS (
		SELECT 1 FROM `machine`
		WHERE `machine`.`installation_id` = `job_timing`.`installation_id`
			AND `machine`.`source` = 'github'
			AND `machine`.`name` = `job_timing`.`runner_name`
			AND `machine`.`revoked_at` IS NULL
			AND (`machine`.`github_repository_id` IS NULL OR `machine`.`github_repository_id` = `job_timing`.`repository_id`)
	);
