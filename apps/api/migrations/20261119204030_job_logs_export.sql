ALTER TABLE `telemetry_export` ADD `logs` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `telemetry_export` ADD `logs_skipped` text;--> statement-breakpoint
ALTER TABLE `telemetry_export` ADD `logs_skipped_at` integer;