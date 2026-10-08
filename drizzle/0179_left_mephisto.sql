CREATE TABLE `workspace_write_leases` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`device_id` text NOT NULL,
	`owner_epoch` text NOT NULL,
	`runtime_epoch` text NOT NULL,
	`runtime_generation` integer NOT NULL,
	`fencing_token` integer NOT NULL,
	`scope_revision` integer NOT NULL,
	`path_flavor` text NOT NULL,
	`status` text NOT NULL,
	`ranges_json` text NOT NULL,
	`mutation_manifest_json` text NOT NULL,
	`execution_ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_lease_device_status` ON `workspace_write_leases` (`device_id`,`status`,`lease_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_lease_scope` ON `workspace_write_leases` (`scope_id`,`status`,`lease_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_lease_cleanup` ON `workspace_write_leases` (`status`,`updated_at`,`lease_id`);--> statement-breakpoint
ALTER TABLE `file_change_scope_recoveries` ADD `workspace_lease_id` text;