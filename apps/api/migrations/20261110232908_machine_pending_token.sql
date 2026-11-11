ALTER TABLE `machine` ADD `pending_token_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_pending_token_hash_unique` ON `machine` (`pending_token_hash`);