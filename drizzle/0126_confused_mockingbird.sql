ALTER TABLE `projects` ADD `traits` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_devices` ADD `owner_scope` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `traits` text DEFAULT '[]' NOT NULL;