ALTER TABLE `narrators` ADD `write_audience` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `acl_root_narrator_id` text REFERENCES narrators(id);--> statement-breakpoint
CREATE INDEX `idx_narrators_write_audience` ON `narrators` (`write_audience`);--> statement-breakpoint
CREATE INDEX `idx_narrators_acl_root` ON `narrators` (`acl_root_narrator_id`);