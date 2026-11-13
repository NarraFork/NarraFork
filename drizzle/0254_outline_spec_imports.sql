PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_spec_imports` (
	`narrator_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`trigger` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`last_error_count` integer,
	`last_error_detail` text,
	`attention_reason` text,
	`switch_count` integer DEFAULT 0 NOT NULL,
	`switched_at` text,
	`notice_switch` integer DEFAULT 0 NOT NULL,
	`space_id` text,
	`task_page_id` text,
	`fence_revision_id` text,
	`tasks` integer,
	`pages` integer,
	`revert_count` integer DEFAULT 0 NOT NULL,
	`reverted_at` text,
	`reverted_by` text,
	`revert_source_key` text,
	`revert_note_ids` text,
	`last_actor` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_spec_imports_status` ON `outline_spec_imports` (`status`,`updated_at`,`narrator_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
