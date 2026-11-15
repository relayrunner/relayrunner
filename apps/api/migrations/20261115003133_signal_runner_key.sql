-- The runner a queue-waits row's jobs went to, so the Signals page can open its panel. Older rows
-- stay null until the hourly rollup rewrites their day.
ALTER TABLE `signal_day` ADD `runner_key` text;
