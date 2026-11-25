CREATE TABLE `actions_usage_day` (
	`installation_id` integer NOT NULL,
	`cycle_start` integer NOT NULL,
	`day` text NOT NULL,
	`used_minutes` real NOT NULL,
	PRIMARY KEY(`installation_id`, `cycle_start`, `day`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
