CREATE TABLE `knowledge_acl_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_role` text,
	`event_type` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`target_type` text,
	`target_id` text,
	`detail_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_kacl_events_created` ON `knowledge_acl_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_kacl_events_subject` ON `knowledge_acl_events` (`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kacl_events_target` ON `knowledge_acl_events` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kacl_events_actor` ON `knowledge_acl_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kacl_events_type` ON `knowledge_acl_events` (`event_type`,`created_at`);