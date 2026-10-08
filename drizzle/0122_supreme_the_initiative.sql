CREATE TABLE `registration_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`note` text,
	`role` text DEFAULT 'user' NOT NULL,
	`bound_username` text,
	`expires_at` text NOT NULL,
	`created_by_user_id` text,
	`used_at` text,
	`used_by_user_id` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_registration_codes_code_hash` ON `registration_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_registration_codes_created_by` ON `registration_codes` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `idx_registration_codes_used_by` ON `registration_codes` (`used_by_user_id`);