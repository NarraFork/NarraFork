PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_container_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`worktree_resource_id` text,
	`container_id` text,
	`service_name` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`host_port` integer,
	`container_port` integer,
	`proxy_label` text,
	`container_ip` text,
	`volume_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_container_instances_owner" CHECK(("__new_container_instances"."chapter_id" is null) <> ("__new_container_instances"."worktree_resource_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_container_instances`("id", "chapter_id", "container_id", "service_name", "status", "host_port", "container_port", "proxy_label", "container_ip", "volume_name", "created_at", "updated_at") SELECT "id", "chapter_id", "container_id", "service_name", "status", "host_port", "container_port", "proxy_label", "container_ip", "volume_name", "created_at", "updated_at" FROM `container_instances`;
--> statement-breakpoint
DROP TABLE `container_instances`;
--> statement-breakpoint
ALTER TABLE `__new_container_instances` RENAME TO `container_instances`;
--> statement-breakpoint
CREATE INDEX `idx_container_instances_chapter` ON `container_instances` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_container_instances_chapter_service` ON `container_instances` (`chapter_id`,`service_name`);
--> statement-breakpoint
CREATE INDEX `idx_container_instances_container` ON `container_instances` (`container_id`);
--> statement-breakpoint
CREATE INDEX `idx_container_instances_status` ON `container_instances` (`chapter_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_container_instances_resource_service_status` ON `container_instances` (`worktree_resource_id`,`service_name`,`status`);
--> statement-breakpoint
CREATE TABLE `__new_volume_snapshot_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`chapter_id` text,
	`target_worktree_resource_id` text,
	`applied_at` text NOT NULL,
	`applied_by` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `volume_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_worktree_resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_snapshot_applications_owner" CHECK(("__new_volume_snapshot_applications"."chapter_id" is null) <> ("__new_volume_snapshot_applications"."target_worktree_resource_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_volume_snapshot_applications`("id", "snapshot_id", "chapter_id", "applied_at", "applied_by") SELECT "id", "snapshot_id", "chapter_id", "applied_at", "applied_by" FROM `volume_snapshot_applications`;
--> statement-breakpoint
DROP TABLE `volume_snapshot_applications`;
--> statement-breakpoint
ALTER TABLE `__new_volume_snapshot_applications` RENAME TO `volume_snapshot_applications`;
--> statement-breakpoint
CREATE INDEX `idx_snapshot_applications_snapshot` ON `volume_snapshot_applications` (`snapshot_id`);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_applications_chapter` ON `volume_snapshot_applications` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_applications_target_resource` ON `volume_snapshot_applications` (`target_worktree_resource_id`);
--> statement-breakpoint
CREATE TABLE `__new_narrator_worktree_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_narrator_id` text,
	`scope_kind` text DEFAULT 'unknown' NOT NULL,
	`scope_project_id` text,
	`scope_owner_user_id` text,
	`ownership_revision` integer DEFAULT 0 NOT NULL,
	`container_config` text,
	`device_id` text NOT NULL,
	`repository_key` text NOT NULL,
	`worktree_path` text NOT NULL,
	`state` text NOT NULL,
	`create_request_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`scope_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`scope_owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_worktree_resource_scope_kind" CHECK("__new_narrator_worktree_resources"."scope_kind" in ('unknown', 'standalone', 'project')),
	CONSTRAINT "ck_worktree_resource_scope_project" CHECK("__new_narrator_worktree_resources"."scope_project_id" is null or "__new_narrator_worktree_resources"."scope_kind" = 'project'),
	CONSTRAINT "ck_worktree_resource_revision" CHECK("__new_narrator_worktree_resources"."ownership_revision" >= 0),
	CONSTRAINT "ck_worktree_resource_config_bytes" CHECK("__new_narrator_worktree_resources"."container_config" is null or length(cast("__new_narrator_worktree_resources"."container_config" as blob)) <= 16384)
);
--> statement-breakpoint
INSERT INTO `__new_narrator_worktree_resources`("id", "owner_narrator_id", "device_id", "repository_key", "worktree_path", "state", "create_request_id", "created_at", "updated_at") SELECT "id", "owner_narrator_id", "device_id", "repository_key", "worktree_path", "state", "create_request_id", "created_at", "updated_at" FROM `narrator_worktree_resources`;
--> statement-breakpoint
DROP TABLE `narrator_worktree_resources`;
--> statement-breakpoint
ALTER TABLE `__new_narrator_worktree_resources` RENAME TO `narrator_worktree_resources`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_narrator_worktree_resource_path` ON `narrator_worktree_resources` (`device_id`,`worktree_path`);
--> statement-breakpoint
CREATE INDEX `idx_narrator_worktree_resource_owner` ON `narrator_worktree_resources` (`owner_narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_resource_scope_project` ON `narrator_worktree_resources` (`scope_project_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_resource_scope_owner` ON `narrator_worktree_resources` (`scope_owner_user_id`);
--> statement-breakpoint
CREATE TABLE `__new_port_allocations` (
	`port` integer PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`worktree_resource_id` text,
	`service_name` text,
	`allocated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_port_allocations_owner" CHECK("__new_port_allocations"."chapter_id" is null or "__new_port_allocations"."worktree_resource_id" is null)
);
--> statement-breakpoint
INSERT INTO `__new_port_allocations`("port", "chapter_id", "service_name", "allocated_at") SELECT "port", "chapter_id", "service_name", "allocated_at" FROM `port_allocations`;
--> statement-breakpoint
DROP TABLE `port_allocations`;
--> statement-breakpoint
ALTER TABLE `__new_port_allocations` RENAME TO `port_allocations`;
--> statement-breakpoint
CREATE INDEX `idx_port_allocations_chapter` ON `port_allocations` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_port_allocations_resource` ON `port_allocations` (`worktree_resource_id`);
--> statement-breakpoint
CREATE TABLE `__new_terminal_view_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`worktree_resource_id` text,
	`layout` text DEFAULT 'single' NOT NULL,
	`active_tab_id` text,
	`panel_assignments` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_view_state_resource_owner" CHECK("__new_terminal_view_state"."worktree_resource_id" is null or ("__new_terminal_view_state"."chapter_id" is null and "__new_terminal_view_state"."narrator_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_terminal_view_state`("id", "user_id", "chapter_id", "narrator_id", "layout", "active_tab_id", "panel_assignments", "updated_at") SELECT "id", "user_id", "chapter_id", "narrator_id", "layout", "active_tab_id", "panel_assignments", "updated_at" FROM `terminal_view_state`;
--> statement-breakpoint
DROP TABLE `terminal_view_state`;
--> statement-breakpoint
ALTER TABLE `__new_terminal_view_state` RENAME TO `terminal_view_state`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_chapter` ON `terminal_view_state` (`user_id`,`chapter_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_narrator` ON `terminal_view_state` (`user_id`,`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_view_state_chapter` ON `terminal_view_state` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_view_state_narrator` ON `terminal_view_state` (`narrator_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_resource` ON `terminal_view_state` (`user_id`,`worktree_resource_id`);
--> statement-breakpoint
CREATE INDEX `idx_view_state_resource` ON `terminal_view_state` (`worktree_resource_id`);
--> statement-breakpoint
CREATE TABLE `__new_terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`worktree_resource_id` text,
	`name` text NOT NULL,
	`cwd` text,
	`dtach_socket` text,
	`device_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`graph_opened` integer DEFAULT 0 NOT NULL,
	`graph_x` real,
	`graph_y` real,
	`graph_width` real,
	`graph_height` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worktree_resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_terminals_resource_owner" CHECK("__new_terminals"."worktree_resource_id" is null or ("__new_terminals"."chapter_id" is null and "__new_terminals"."narrator_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_terminals`("id", "chapter_id", "narrator_id", "name", "cwd", "dtach_socket", "device_id", "status", "exit_code", "graph_opened", "graph_x", "graph_y", "graph_width", "graph_height", "created_at") SELECT "id", "chapter_id", "narrator_id", "name", "cwd", "dtach_socket", "device_id", "status", "exit_code", "graph_opened", "graph_x", "graph_y", "graph_width", "graph_height", "created_at" FROM `terminals`;
--> statement-breakpoint
DROP TABLE `terminals`;
--> statement-breakpoint
ALTER TABLE `__new_terminals` RENAME TO `terminals`;
--> statement-breakpoint
CREATE INDEX `idx_terminals_chapter` ON `terminals` (`chapter_id`,`status`,`graph_opened`);
--> statement-breakpoint
CREATE INDEX `idx_terminals_narrator` ON `terminals` (`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_terminals_status` ON `terminals` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_terminals_resource_status` ON `terminals` (`worktree_resource_id`,`status`,`id`);
--> statement-breakpoint
ALTER TABLE `volume_snapshots` ADD `source_worktree_resource_id` text REFERENCES narrator_worktree_resources(id) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `idx_volume_snapshots_source_resource` ON `volume_snapshots` (`source_worktree_resource_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
