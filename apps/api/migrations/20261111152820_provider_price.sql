CREATE TABLE `provider_price` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`rate` text NOT NULL,
	`usd` real NOT NULL,
	`effective_from` text NOT NULL,
	`source` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_price_rate_from_idx` ON `provider_price` (`provider`,`rate`,`effective_from`);