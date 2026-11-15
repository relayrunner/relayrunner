CREATE TABLE `provider_spend_month` (
	`installation_id` integer NOT NULL,
	`month` integer NOT NULL,
	`provider` text NOT NULL,
	`usd_micros` integer DEFAULT 0 NOT NULL,
	`jobs` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`installation_id`, `month`, `provider`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runner_wait_day` (
	`day` integer NOT NULL,
	`provider` text NOT NULL,
	`platform` text NOT NULL,
	`vcpus` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`jobs` integer DEFAULT 0 NOT NULL,
	`wait_ms` integer DEFAULT 0 NOT NULL,
	`under_10s` integer DEFAULT 0 NOT NULL,
	`under_30s` integer DEFAULT 0 NOT NULL,
	`under_1m` integer DEFAULT 0 NOT NULL,
	`under_2m` integer DEFAULT 0 NOT NULL,
	`under_5m` integer DEFAULT 0 NOT NULL,
	`under_15m` integer DEFAULT 0 NOT NULL,
	`over_15m` integer DEFAULT 0 NOT NULL,
	`runner_failures` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `provider`, `platform`, `vcpus`, `installation_id`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `job_timing` ADD `ran_steps` integer;--> statement-breakpoint
ALTER TABLE `job_timing` ADD `failed_step` text;