CREATE TABLE `narrator_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`time_used_seconds` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_narrator_goals_narrator_order` ON `narrator_goals` (`narrator_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_narrator_goals_status` ON `narrator_goals` (`narrator_id`,`status`);