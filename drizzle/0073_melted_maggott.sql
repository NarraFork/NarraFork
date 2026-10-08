CREATE TABLE `device_transfer_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`direction` text NOT NULL,
	`remote_path` text NOT NULL,
	`local_path` text NOT NULL,
	`recursive` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`files_transferred` integer DEFAULT 0 NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`total_files` integer,
	`total_bytes` integer,
	`current_file` text,
	`error` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `remote_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_device_transfer_tasks_device_created` ON `device_transfer_tasks` (`device_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_device_transfer_tasks_status_updated` ON `device_transfer_tasks` (`status`,`updated_at`);