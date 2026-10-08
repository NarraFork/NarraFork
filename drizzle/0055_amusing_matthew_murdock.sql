CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`display_name` text,
	`last_login_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_identities_provider_subject` ON `user_identities` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_user` ON `user_identities` (`user_id`);