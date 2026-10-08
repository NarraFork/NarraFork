CREATE TABLE `narrator_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`granted_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_grant_unique` ON `narrator_grants` (`narrator_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_grant_principal` ON `narrator_grants` (`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_grant_narrator` ON `narrator_grants` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_grant_granted_by` ON `narrator_grants` (`granted_by`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `narrators` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_narrators_owner` ON `narrators` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_visibility` ON `narrators` (`visibility`);