PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `api_requests` ADD `token_accounting_version` integer;
--> statement-breakpoint
CREATE INDEX `idx_api_requests_token_accounting_pending` ON `api_requests` (`created_at`,`id`) WHERE "token_accounting_version" IS NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
