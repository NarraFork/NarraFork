PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `folder_git_identity_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`folder_id` text NOT NULL,
	`user_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`identity_id`) REFERENCES `user_git_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_folder_git_identity_unique` ON `folder_git_identity_bindings` (`folder_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_folder_git_identity_user` ON `folder_git_identity_bindings` (`user_id`);
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `git_identity_folder_context_menu` integer DEFAULT false NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
