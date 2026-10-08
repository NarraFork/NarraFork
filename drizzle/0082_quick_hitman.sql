CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`oauth_client_id` text,
	`grant_id` text,
	`user_id` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`expires_at` text NOT NULL,
	`refresh_token_hash` text,
	`refresh_expires_at` text,
	`refresh_family_id` text,
	`refresh_family_expires_at` text,
	`refresh_family_revoked_at` text,
	`refresh_parent_token_id` text,
	`refresh_replaced_by_token_id` text,
	`refresh_used_at` text,
	`refresh_reuse_detected_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_by_user_id` text,
	`revoked_by_type` text,
	`revoked_reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_access_tokens_token_hash` ON `oauth_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_access_tokens_refresh_hash` ON `oauth_access_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_client` ON `oauth_access_tokens` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_oauth_client` ON `oauth_access_tokens` (`oauth_client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_grant_revoked` ON `oauth_access_tokens` (`grant_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_refresh_family` ON `oauth_access_tokens` (`refresh_family_id`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_access_tokens_refresh_parent` ON `oauth_access_tokens` (`refresh_parent_token_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_user` ON `oauth_access_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`oauth_client_id` text,
	`grant_id` text,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`code_challenge` text NOT NULL,
	`code_challenge_method` text DEFAULT 'S256' NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_authorization_codes_code_hash` ON `oauth_authorization_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_authorization_codes_client` ON `oauth_authorization_codes` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_authorization_codes_oauth_client` ON `oauth_authorization_codes` (`oauth_client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_authorization_codes_grant` ON `oauth_authorization_codes` (`grant_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_authorization_codes_user` ON `oauth_authorization_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`grant_types` text DEFAULT '["authorization_code","refresh_token"]' NOT NULL,
	`public_client` integer DEFAULT true NOT NULL,
	`policy_json` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_by_user_id` text,
	`revoked_reason` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_clients_client_id` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_grant_events` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text,
	`oauth_client_id` text NOT NULL,
	`user_id` text,
	`actor_type` text NOT NULL,
	`actor_user_id` text,
	`event_type` text NOT NULL,
	`requested_scopes` text DEFAULT '[]' NOT NULL,
	`granted_scopes` text DEFAULT '[]' NOT NULL,
	`project_ids` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`metadata` text,
	`ip_address` text,
	`user_agent` text,
	`request_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_grant_events_grant_created` ON `oauth_grant_events` (`grant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_grant_events_client_created` ON `oauth_grant_events` (`oauth_client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_grant_events_user_created` ON `oauth_grant_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_grant_events_request` ON `oauth_grant_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `oauth_grant_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_grant_projects_grant_project` ON `oauth_grant_projects` (`grant_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_grant_projects_project` ON `oauth_grant_projects` (`project_id`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`oauth_client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`policy_json` text,
	`legacy_unscoped` integer DEFAULT false NOT NULL,
	`consented_at` text,
	`last_token_issued_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_by_user_id` text,
	`revoked_by_type` text,
	`revoked_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_grants_active_user_client` ON `oauth_grants` (`user_id`,`oauth_client_id`) WHERE "oauth_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_client_revoked` ON `oauth_grants` (`oauth_client_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_user_revoked` ON `oauth_grants` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `oauth_security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`endpoint` text NOT NULL,
	`bucket_type` text NOT NULL,
	`client_id` text,
	`grant_id` text,
	`user_id` text,
	`retry_after_seconds` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_security_events_created` ON `oauth_security_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_oauth_security_events_type_created` ON `oauth_security_events` (`event_type`,`created_at`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `oauth_owner_grant_id` text REFERENCES oauth_grants(id);--> statement-breakpoint
ALTER TABLE `narrators` ADD `oauth_provision_key` text;--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_project_id` text REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `narrators` ADD `oauth_policy_snapshot_json` text;--> statement-breakpoint
CREATE INDEX `idx_narrators_context_project` ON `narrators` (`context_project_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_oauth_owner` ON `narrators` (`oauth_owner_grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrators_oauth_provision` ON `narrators` (`oauth_owner_grant_id`,`oauth_provision_key`);--> statement-breakpoint
ALTER TABLE `remote_devices` ADD `oauth_owner_grant_id` text REFERENCES oauth_grants(id);--> statement-breakpoint
ALTER TABLE `remote_devices` ADD `oauth_provision_key` text;--> statement-breakpoint
CREATE INDEX `idx_remote_devices_oauth_owner` ON `remote_devices` (`oauth_owner_grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_devices_oauth_provision` ON `remote_devices` (`oauth_owner_grant_id`,`oauth_provision_key`);