-- Where each workspace sends its CI traces as OpenTelemetry spans (src/telemetry).

CREATE TABLE `telemetry_export` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`headers` text NOT NULL,
	`header_hints` text NOT NULL,
	`service_name` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_by` text,
	`last_sent_at` integer,
	`error` text,
	`failing_since` integer,
	`paused_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
