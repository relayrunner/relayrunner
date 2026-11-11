CREATE TABLE `price_check` (
	`provider` text PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `price_finding` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`rate` text NOT NULL,
	`usd` real NOT NULL,
	`effective_from` text NOT NULL,
	`source` text NOT NULL,
	`found_at` integer NOT NULL,
	`dismissed_at` integer
);
