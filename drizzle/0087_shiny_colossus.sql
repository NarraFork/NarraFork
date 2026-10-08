ALTER TABLE `integration_authorities` ADD `source_grant_id` text;--> statement-breakpoint
ALTER TABLE `integration_authorities` ADD `metadata_json` text;--> statement-breakpoint
ALTER TABLE `integration_authorities` ADD `expires_at` text;--> statement-breakpoint
CREATE INDEX `idx_integration_authorities_expiry` ON `integration_authorities` (`state`,`expires_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_authorities_source_grant` ON `integration_authorities` (`source_grant_id`) WHERE "integration_authorities"."source_grant_id" is not null;