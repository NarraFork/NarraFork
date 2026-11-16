PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `api_requests` ADD `cache_usage_reported` integer;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
