-- Which GitHub accounts installed the opt-in RelayRunner Spend App (org billing), from its
-- installation webhooks and an hourly reconcile (src/spend-app.ts).
CREATE TABLE `spend_installation` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`account_login` text NOT NULL,
	`installation_id` integer NOT NULL,
	`suspended_at` integer,
	`github_state_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
