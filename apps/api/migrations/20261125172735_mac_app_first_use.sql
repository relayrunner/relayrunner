CREATE TABLE `mac_app_first_use` (
	`user_id` text PRIMARY KEY NOT NULL,
	`machine_id` text,
	`mac_app_version` text NOT NULL,
	`first_used_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mac_app_first_use_at_idx` ON `mac_app_first_use` (`first_used_at`);
--> statement-breakpoint
-- People already on the Mac app have used it, so the operator ping stays quiet for them.
INSERT INTO `mac_app_first_use` (`user_id`, `machine_id`, `mac_app_version`, `first_used_at`)
SELECT `user_id`, `id`, `mac_app_version`, min(`created_at`) FROM `machine`
WHERE `user_id` IS NOT NULL AND `mac_app_version` IS NOT NULL
GROUP BY `user_id`;
