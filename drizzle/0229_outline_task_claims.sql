PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_task_claims` (
	`task_block_id` text PRIMARY KEY NOT NULL,
	`holder_narrator_id` text,
	`holder_user_id` text,
	`epoch` integer NOT NULL,
	`task_version_at_claim` integer NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text,
	`last_holder_narrator_id` text,
	`last_holder_user_id` text,
	FOREIGN KEY (`task_block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_task_claims_holder` ON `outline_task_claims` (`holder_narrator_id`) WHERE "holder_narrator_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_outline_task_claims_expiry` ON `outline_task_claims` (`expires_at`) WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `outline_blocks` ADD `in_process` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_open_tasks` ON `outline_blocks` (`space_id`) WHERE json_extract("task_json", '$.status') IN ('todo', 'doing') AND "deleted" = 0;
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_doing_tasks` ON `outline_blocks` (`id`) WHERE json_extract("task_json", '$.status') = 'doing' AND "deleted" = 0;
--> statement-breakpoint
ALTER TABLE `outline_spaces` ADD `in_process_ready` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `outline_spaces` ADD `in_process_epoch` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_in_process_pending` ON `outline_spaces` (`id`) WHERE "in_process_ready" = 0;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
