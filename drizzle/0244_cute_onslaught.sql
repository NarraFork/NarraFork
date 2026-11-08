PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `knowledge_submissions` ADD `author_read_at` text;
--> statement-breakpoint
CREATE INDEX `idx_ks_submitter_author_read` ON `knowledge_submissions` (`submitter_user_id`,`author_read_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
