DROP INDEX `idx_file_snapshots_narrator`;--> statement-breakpoint
CREATE INDEX `idx_file_snapshots_narrator` ON `narrator_file_snapshots` (`narrator_id`);