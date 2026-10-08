CREATE TABLE `skill_directory_caches` (
	`id` text PRIMARY KEY NOT NULL,
	`root_kind` text NOT NULL,
	`normalized_root_path` text NOT NULL,
	`skills_json` text NOT NULL,
	`signature_json` text NOT NULL,
	`scanned_at` text NOT NULL,
	`last_accessed_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skill_dir_cache_root` ON `skill_directory_caches` (`root_kind`,`normalized_root_path`);--> statement-breakpoint
CREATE INDEX `idx_skill_dir_cache_last_accessed` ON `skill_directory_caches` (`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_dir_cache_expires` ON `skill_directory_caches` (`expires_at`);