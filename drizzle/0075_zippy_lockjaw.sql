CREATE TABLE `narrator_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`narrator_id` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`source_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_drafts_user_narrator` ON `narrator_drafts` (`user_id`,`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_drafts_narrator` ON `narrator_drafts` (`narrator_id`);