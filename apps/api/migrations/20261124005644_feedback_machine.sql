PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`workspace_id` text,
	`machine_id` text,
	`grant_id` text,
	`client_id` text,
	`category` text NOT NULL,
	`summary` text NOT NULL,
	`details` text,
	`tool` text,
	`created_at` integer NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`page` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_feedback`("id", "user_id", "workspace_id", "machine_id", "grant_id", "client_id", "category", "summary", "details", "tool", "created_at", "source", "page") SELECT "id", "user_id", "workspace_id", NULL, "grant_id", "client_id", "category", "summary", "details", "tool", "created_at", "source", "page" FROM `feedback`;--> statement-breakpoint
DROP TABLE `feedback`;--> statement-breakpoint
ALTER TABLE `__new_feedback` RENAME TO `feedback`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `feedback_user_id_created_at_idx` ON `feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_machine_id_created_at_idx` ON `feedback` (`machine_id`,`created_at`);