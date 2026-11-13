PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_narrators_status` ON `narrators` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_narrators_variant_list` ON `narrators` (`variant`,`hidden_from_lists`,`status`,`updated_at`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
