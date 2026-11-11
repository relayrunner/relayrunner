ALTER TABLE `route_decision` ADD `hosted` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `route_decision` SET `hosted` = json_object('blacksmith', json(`blacksmith`)) WHERE `blacksmith` != '[]';
