CREATE TABLE `evaluation` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`workflow_path` text NOT NULL,
	`workflow_name` text,
	`provider` text NOT NULL,
	`vcpus` integer NOT NULL,
	`label` text NOT NULL,
	`ref` text NOT NULL,
	`runs` integer NOT NULL,
	`run_id` integer,
	`attempt` integer DEFAULT 1 NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`started_by_id` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_run_idx` ON `evaluation` (`repository_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `evaluation_workspace_idx` ON `evaluation` (`workspace_id`,`created_at`);