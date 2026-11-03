PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_questions` (
	`block_id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`state` text NOT NULL,
	`proceed` integer DEFAULT false NOT NULL,
	`to_user_id` text,
	`asker_narrator_id` text,
	`asker_user_id` text,
	`asker_tool_call_id` text,
	`created_at` text NOT NULL,
	`answered_at` text,
	`answer_commit_id` text,
	`delivered_at` text,
	FOREIGN KEY (`block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_questions_to_open` ON `outline_questions` (`to_user_id`) WHERE "state" = 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_questions_space_open` ON `outline_questions` (`space_id`) WHERE "state" = 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_questions_asker_open` ON `outline_questions` (`asker_narrator_id`) WHERE "state" = 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_questions_undelivered` ON `outline_questions` (`answered_at`) WHERE "state" = 'answered' AND "delivered_at" IS NULL;
--> statement-breakpoint
ALTER TABLE `outline_block_versions` ADD `ask_json` text;
--> statement-breakpoint
ALTER TABLE `outline_blocks` ADD `ask_json` text;
--> statement-breakpoint
ALTER TABLE `outline_pending` ADD `digest_seen_at` text;
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_digest` ON `outline_pending` (`decider_user_id`) WHERE "status" = 'confirmed' AND "digest_seen_at" IS NULL AND json_extract("decided_by_json", '$.kind') = 'agent';
--> statement-breakpoint
PRAGMA foreign_keys=ON;
