DROP INDEX `idx_api_requests_created`;--> statement-breakpoint
CREATE INDEX `idx_api_requests_created` ON `api_requests` (`created_at`,`id`);