PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `git_identity_context_menu` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `git_identity_create_modal` integer DEFAULT false NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
