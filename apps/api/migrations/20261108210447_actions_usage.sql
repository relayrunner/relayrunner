CREATE TABLE `actions_billing` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`plan` text,
	`budget_amount` integer,
	`budget_prevent_further_usage` integer,
	`failure` text,
	`error` text,
	`checked_at` integer NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `actions_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installation_id` integer NOT NULL,
	`cycle_start` integer NOT NULL,
	`repository_name` text NOT NULL,
	`sku` text NOT NULL,
	`unit_type` text NOT NULL,
	`quantity` real NOT NULL,
	`gross_amount` real NOT NULL,
	`net_amount` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_usage_row_idx` ON `actions_usage` (`installation_id`,`cycle_start`,`repository_name`,`sku`);--> statement-breakpoint
CREATE TABLE `actions_usage_reading` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installation_id` integer NOT NULL,
	`read_at` integer NOT NULL,
	`cycle_start` integer NOT NULL,
	`used_minutes` real NOT NULL,
	`gross_amount` real NOT NULL,
	`net_amount` real NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actions_usage_reading_installation_idx` ON `actions_usage_reading` (`installation_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `actions_usage_reading_read_idx` ON `actions_usage_reading` (`read_at`);