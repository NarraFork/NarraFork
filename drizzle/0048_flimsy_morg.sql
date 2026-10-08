CREATE TABLE `knowledge_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`project_id` text,
	`default_level` text DEFAULT 'public' NOT NULL,
	`owner_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kc_project_slug` ON `knowledge_collections` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_kc_project` ON `knowledge_collections` (`project_id`);--> statement-breakpoint
CREATE TABLE `knowledge_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`name` text,
	`base_revision_id` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`format` text DEFAULT 'markdown' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_kd_entry_author` ON `knowledge_drafts` (`entry_id`,`author_user_id`);--> statement-breakpoint
CREATE INDEX `idx_kd_entry` ON `knowledge_drafts` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_kd_author` ON `knowledge_drafts` (`author_user_id`);--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`current_revision_id` text,
	`current_content` text,
	`tags_json` text,
	`metadata_json` text,
	`classification_level` text,
	`controlled_tags_json` text,
	`review_tags_json` text,
	`owner_user_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ke_collection_slug` ON `knowledge_entries` (`collection_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_ke_collection` ON `knowledge_entries` (`collection_id`);--> statement-breakpoint
CREATE INDEX `idx_ke_status` ON `knowledge_entries` (`status`);--> statement-breakpoint
CREATE TABLE `knowledge_entry_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_entry_id` text NOT NULL,
	`to_entry_id` text NOT NULL,
	`link_type` text NOT NULL,
	`label` text,
	`to_revision_id` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`from_entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_revision_id`) REFERENCES `knowledge_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kelink_entry_from_to_type` ON `knowledge_entry_links` (`from_entry_id`,`to_entry_id`,`link_type`);--> statement-breakpoint
CREATE INDEX `idx_kelink_from` ON `knowledge_entry_links` (`from_entry_id`);--> statement-breakpoint
CREATE INDEX `idx_kelink_to` ON `knowledge_entry_links` (`to_entry_id`);--> statement-breakpoint
CREATE TABLE `knowledge_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`grant_type` text NOT NULL,
	`clearance_level` text,
	`tag_id` text,
	`can_write` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `knowledge_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_kgrant_principal` ON `knowledge_grants` (`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `idx_kgrant_tag` ON `knowledge_grants` (`tag_id`);--> statement-breakpoint
CREATE TABLE `knowledge_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rank` integer NOT NULL,
	`label` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_levels_name_unique` ON `knowledge_levels` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_klevel_rank` ON `knowledge_levels` (`rank`);--> statement-breakpoint
CREATE TABLE `knowledge_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`version` integer NOT NULL,
	`format` text DEFAULT 'markdown' NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`change_note` text,
	`author_user_id` text,
	`base_revision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kr_entry_version` ON `knowledge_revisions` (`entry_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_kr_entry` ON `knowledge_revisions` (`entry_id`);--> statement-breakpoint
CREATE TABLE `knowledge_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`submitter_user_id` text NOT NULL,
	`base_revision_id` text,
	`proposed_content` text NOT NULL,
	`change_note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_user_id` text,
	`verdict` text,
	`findings_json` text,
	`reviewed_at` text,
	`merged_revision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `knowledge_drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_ks_entry` ON `knowledge_submissions` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_ks_status` ON `knowledge_submissions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_ks_submitter` ON `knowledge_submissions` (`submitter_user_id`);--> statement-breakpoint
CREATE TABLE `knowledge_tag_types` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_tag_types_name_unique` ON `knowledge_tag_types` (`name`);--> statement-breakpoint
CREATE INDEX `idx_ktagtype_sort` ON `knowledge_tag_types` (`sort_order`);--> statement-breakpoint
CREATE TABLE `knowledge_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text,
	`type_id` text,
	`name` text NOT NULL,
	`controlled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `knowledge_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `knowledge_tag_types`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ktag_collection_name` ON `knowledge_tags` (`collection_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_ktag_controlled` ON `knowledge_tags` (`controlled`);--> statement-breakpoint
CREATE INDEX `idx_ktag_type` ON `knowledge_tags` (`type_id`);