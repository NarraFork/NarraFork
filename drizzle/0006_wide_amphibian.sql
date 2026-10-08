CREATE TABLE `volume_snapshot_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`applied_at` text NOT NULL,
	`applied_by` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `volume_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_applications_snapshot` ON `volume_snapshot_applications` (`snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_applications_chapter` ON `volume_snapshot_applications` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `volume_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source_chapter_id` text,
	`service_name` text NOT NULL,
	`container_path` text NOT NULL,
	`size_bytes` integer,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_volume_snapshots_project` ON `volume_snapshots` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_volume_snapshots_source_chapter` ON `volume_snapshots` (`source_chapter_id`);