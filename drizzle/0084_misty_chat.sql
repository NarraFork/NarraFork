CREATE TABLE `integration_resource_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`authority_type` text NOT NULL,
	`authority_id` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text,
	`orphaned_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_resource_binding_resource` ON `integration_resource_bindings` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_integration_resource_binding_authority` ON `integration_resource_bindings` (`authority_type`,`authority_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `idx_integration_resource_binding_source` ON `integration_resource_bindings` (`source_type`,`source_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_integration_resource_binding_state_updated` ON `integration_resource_bindings` (`state`,`updated_at`);