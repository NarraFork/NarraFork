CREATE TABLE `integration_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text,
	`authority_id` text,
	`credential_type` text,
	`credential_id` text,
	`transport` text NOT NULL,
	`operation_id` text NOT NULL,
	`capability_id` text,
	`resource_type` text,
	`resource_id` text,
	`scope_type` text,
	`scope_id` text,
	`outcome` text NOT NULL,
	`reason_code` text,
	`duration_ms` integer,
	`request_bytes` integer DEFAULT 0 NOT NULL,
	`response_bytes` integer DEFAULT 0 NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_integration_audit_created` ON `integration_audit_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_integration_audit_authority` ON `integration_audit_events` (`authority_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_integration_audit_operation` ON `integration_audit_events` (`operation_id`,`outcome`,`created_at`);--> statement-breakpoint
CREATE TABLE `integration_authorities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`integration_type` text NOT NULL,
	`integration_id` text NOT NULL,
	`owner_user_id` text,
	`state` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`policy_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text,
	`revoked_reason` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_integration_authorities_integration` ON `integration_authorities` (`integration_type`,`integration_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `idx_integration_authorities_owner` ON `integration_authorities` (`owner_user_id`,`state`,`id`);--> statement-breakpoint
CREATE TABLE `integration_capability_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`authority_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`scope_key` text NOT NULL,
	`constraints_json` text,
	`expires_at` text,
	`revoked_at` text,
	`created_by_type` text NOT NULL,
	`created_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`authority_id`) REFERENCES `integration_authorities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_capability_grants_active_scope` ON `integration_capability_grants` (`authority_id`,`capability_id`,`scope_key`) WHERE "integration_capability_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `idx_integration_capability_grants_authority` ON `integration_capability_grants` (`authority_id`,`capability_id`,`revoked_at`,`expires_at`,`id`);--> statement-breakpoint
ALTER TABLE `integration_resource_bindings` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_resource_bindings` ADD `provision_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_resource_binding_provision` ON `integration_resource_bindings` (`authority_id`,`resource_type`,`provision_key`);