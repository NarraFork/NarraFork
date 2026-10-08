CREATE TABLE `acl_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_role` text,
	`event_type` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`outcome` text NOT NULL,
	`detail_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_acl_event_created` ON `acl_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_acl_event_scope` ON `acl_events` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_acl_event_subject` ON `acl_events` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_acl_event_actor` ON `acl_events` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `acl_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`capability` text NOT NULL,
	`domain_kind` text,
	`domain_value` text,
	`granted_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acl_grant_unique_scoped_domain` ON `acl_grants` (`scope_type`,`scope_id`,`principal_type`,`principal_id`,`capability`,`domain_kind`,`domain_value`) WHERE "acl_grants"."scope_id" is not null and "acl_grants"."domain_value" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acl_grant_unique_scoped_capability` ON `acl_grants` (`scope_type`,`scope_id`,`principal_type`,`principal_id`,`capability`) WHERE "acl_grants"."scope_id" is not null and "acl_grants"."domain_value" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acl_grant_unique_global_domain` ON `acl_grants` (`scope_type`,`principal_type`,`principal_id`,`capability`,`domain_kind`,`domain_value`) WHERE "acl_grants"."scope_id" is null and "acl_grants"."domain_value" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acl_grant_unique_global_capability` ON `acl_grants` (`scope_type`,`principal_type`,`principal_id`,`capability`) WHERE "acl_grants"."scope_id" is null and "acl_grants"."domain_value" is null;--> statement-breakpoint
CREATE INDEX `idx_acl_grant_principal` ON `acl_grants` (`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `idx_acl_grant_scope` ON `acl_grants` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_acl_grant_granted_by` ON `acl_grants` (`granted_by`);--> statement-breakpoint
ALTER TABLE `knowledge_collections` ADD `inherit_project_gate` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `visibility` text DEFAULT 'private' NOT NULL;