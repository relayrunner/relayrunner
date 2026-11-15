CREATE TABLE `github_enterprise_organization` (
	`organization_id` integer PRIMARY KEY NOT NULL,
	`enterprise_installation_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`enterprise_installation_id`) REFERENCES `github_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
