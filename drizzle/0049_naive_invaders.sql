CREATE INDEX `idx_ke_collection_updated` ON `knowledge_entries` (`collection_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_ks_entry_created` ON `knowledge_submissions` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ks_status_created` ON `knowledge_submissions` (`status`,`created_at`);