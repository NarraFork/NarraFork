PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `knowledge_drafts_fts_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `knowledge_drafts_fts_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `knowledge_drafts_fts_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `knowledge_drafts_fts_entry_title`;--> statement-breakpoint
CREATE TABLE `__new_knowledge_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text,
	`author_user_id` text NOT NULL,
	`name` text,
	`title` text,
	`target_collection_id` text,
	`base_revision_id` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`format` text DEFAULT 'markdown' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_drafts`("id", "entry_id", "author_user_id", "name", "base_revision_id", "content", "content_hash", "format", "status", "created_at", "updated_at") SELECT "id", "entry_id", "author_user_id", "name", "base_revision_id", "content", "content_hash", "format", CASE WHEN "status" IN ('merged','abandoned') THEN 'archived' ELSE 'active' END, "created_at", "updated_at" FROM `knowledge_drafts`;--> statement-breakpoint
DROP TABLE `knowledge_drafts`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_drafts` RENAME TO `knowledge_drafts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_kd_entry_author` ON `knowledge_drafts` (`entry_id`,`author_user_id`);--> statement-breakpoint
CREATE INDEX `idx_kd_entry` ON `knowledge_drafts` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_kd_author` ON `knowledge_drafts` (`author_user_id`);--> statement-breakpoint
CREATE TABLE `__new_knowledge_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`entry_id` text,
	`collection_id` text,
	`title` text,
	`submitter_user_id` text NOT NULL,
	`base_revision_id` text,
	`proposed_content` text NOT NULL,
	`change_note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_user_id` text,
	`verdict` text,
	`findings_json` text,
	`reviewed_at` text,
	`merged_revision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `knowledge_drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_submissions`("id", "draft_id", "entry_id", "submitter_user_id", "base_revision_id", "proposed_content", "change_note", "status", "reviewer_user_id", "verdict", "findings_json", "reviewed_at", "merged_revision_id", "created_at") SELECT "id", "draft_id", "entry_id", "submitter_user_id", "base_revision_id", "proposed_content", "change_note", "status", "reviewer_user_id", "verdict", "findings_json", "reviewed_at", "merged_revision_id", "created_at" FROM `knowledge_submissions`;--> statement-breakpoint
DROP TABLE `knowledge_submissions`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_submissions` RENAME TO `knowledge_submissions`;--> statement-breakpoint
CREATE INDEX `idx_ks_entry` ON `knowledge_submissions` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_ks_status` ON `knowledge_submissions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_ks_submitter` ON `knowledge_submissions` (`submitter_user_id`);--> statement-breakpoint
CREATE INDEX `idx_ks_entry_created` ON `knowledge_submissions` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ks_status_created` ON `knowledge_submissions` (`status`,`created_at`);