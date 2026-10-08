CREATE TABLE `knowledge_pack_activations` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`narrator_id` text NOT NULL,
	`extract_dir` text NOT NULL,
	`whitelist_dir_id` text,
	`archive_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`released_at` text,
	FOREIGN KEY (`pack_id`) REFERENCES `knowledge_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_kpackact_narrator` ON `knowledge_pack_activations` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_kpackact_pack` ON `knowledge_pack_activations` (`pack_id`);--> statement-breakpoint
CREATE INDEX `idx_kpackact_narrator_pack_status` ON `knowledge_pack_activations` (`narrator_id`,`pack_id`,`status`);--> statement-breakpoint
CREATE TABLE `knowledge_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`project_id` text,
	`entry_id` text,
	`classification_level` text,
	`controlled_tags_json` text,
	`owner_user_id` text,
	`archive_format` text NOT NULL,
	`archive_size` integer NOT NULL,
	`archive_hash` text NOT NULL,
	`uncompressed_size` integer,
	`manifest_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kpack_project_slug` ON `knowledge_packs` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_kpack_project` ON `knowledge_packs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_kpack_entry` ON `knowledge_packs` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_kpack_status` ON `knowledge_packs` (`status`);