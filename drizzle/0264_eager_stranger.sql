PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `title_slug` text;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `alias_selector` text;
--> statement-breakpoint
CREATE INDEX `idx_narrators_parent_title_slug` ON `narrators` (`parent_narrator_id`,`title_slug`) WHERE "parent_narrator_id" IS NOT NULL AND "title_slug" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_narrators_parent_alias_selector` ON `narrators` (`parent_narrator_id`,`alias_selector`) WHERE "parent_narrator_id" IS NOT NULL AND "alias_selector" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_narrators_addressable_parent_created` ON `narrators` (`parent_narrator_id`,`created_at`,`id`) WHERE "parent_narrator_id" IS NOT NULL AND "status" IN ('idle', 'working', 'waiting');
--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_parent_alias` ON `background_tasks` (`parent_narrator_id`,`alias`,`created_at`) WHERE "alias" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_parent_live_alias` ON `background_tasks` (`parent_narrator_id`,`alias`) WHERE "alias" IS NOT NULL AND "status" IN ('running', 'paused');
--> statement-breakpoint
PRAGMA foreign_keys=ON;
