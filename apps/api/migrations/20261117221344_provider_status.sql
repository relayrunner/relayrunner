ALTER TABLE `provider` ADD `status` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider` ADD `featured` integer;--> statement-breakpoint
ALTER TABLE `provider` ADD `platforms` text;--> statement-breakpoint
ALTER TABLE `provider` ADD `fee_usd` real;--> statement-breakpoint
ALTER TABLE `provider` ADD `per_minute` real;--> statement-breakpoint
ALTER TABLE `provider` ADD `connect_url` text;
