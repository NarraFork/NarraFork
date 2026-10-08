CREATE TABLE `spec_file_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`parent_revision_id` text,
	`source_tool_use_id` text,
	`source_message_id` text,
	`created_by` text DEFAULT 'assistant' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `spec_namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_revision_id`) REFERENCES `spec_file_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_spec_file_revisions_namespace_path` ON `spec_file_revisions` (`namespace_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_spec_file_revisions_parent` ON `spec_file_revisions` (`parent_revision_id`);--> statement-breakpoint
CREATE TABLE `spec_namespace_files` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`path` text NOT NULL,
	`revision_id` text,
	`deleted` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `spec_namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `spec_file_revisions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_spec_namespace_files_namespace_path` ON `spec_namespace_files` (`namespace_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_spec_namespace_files_revision` ON `spec_namespace_files` (`revision_id`);--> statement-breakpoint
CREATE TABLE `spec_namespaces` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`forked_from_namespace_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forked_from_namespace_id`) REFERENCES `spec_namespaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_spec_namespaces_narrator` ON `spec_namespaces` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_spec_namespaces_forked_from` ON `spec_namespaces` (`forked_from_namespace_id`);--> statement-breakpoint
CREATE TABLE `spec_protected_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`text_hash` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`first_revision_id` text,
	`last_revision_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`deleted_at` text,
	FOREIGN KEY (`namespace_id`) REFERENCES `spec_namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_revision_id`) REFERENCES `spec_file_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_revision_id`) REFERENCES `spec_file_revisions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_spec_protected_tasks_namespace_hash` ON `spec_protected_tasks` (`namespace_id`,`text_hash`);--> statement-breakpoint
CREATE INDEX `idx_spec_protected_tasks_namespace_status` ON `spec_protected_tasks` (`namespace_id`,`status`);