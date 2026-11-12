CREATE TABLE `provider` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`summary` text NOT NULL,
	`labels` text NOT NULL,
	`prefixes` text NOT NULL,
	`example` text,
	`setup` text,
	`dashboard_url` text,
	`docs_url` text,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
