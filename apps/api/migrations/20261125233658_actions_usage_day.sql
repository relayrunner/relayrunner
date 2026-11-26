CREATE TABLE `actions_usage_day` (
	`installation_id` integer NOT NULL,
	`day` text NOT NULL,
	`used_minutes` real NOT NULL,
	PRIMARY KEY(`installation_id`, `day`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
