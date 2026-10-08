PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_container_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
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
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_container_instances`("id", "chapter_id", "container_id", "service_name", "status", "host_port", "container_port", "proxy_label", "container_ip", "volume_name", "created_at", "updated_at") SELECT "id", "chapter_id", "container_id", "service_name", "status", "host_port", "container_port", "proxy_label", "container_ip", "volume_name", "created_at", "updated_at" FROM `container_instances`;--> statement-breakpoint
DROP TABLE `container_instances`;--> statement-breakpoint
ALTER TABLE `__new_container_instances` RENAME TO `container_instances`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_container_instances_chapter` ON `container_instances` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_chapter_service` ON `container_instances` (`chapter_id`,`service_name`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_container` ON `container_instances` (`container_id`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_status` ON `container_instances` (`chapter_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_merge_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_chapter_id` text NOT NULL,
	`source_chapter_ids` text NOT NULL,
	`strategy` text DEFAULT 'merge' NOT NULL,
	`status` text NOT NULL,
	`current_index` integer DEFAULT 0 NOT NULL,
	`merged_count` integer DEFAULT 0 NOT NULL,
	`current_source_chapter_id` text,
	`conflict_files` text,
	`pre_merge_tree` text,
	`conflict_tree` text,
	`pre_merge_target_snapshot` text,
	`merge_source_snapshot` text,
	`pre_merge_target_sha` text,
	`error` text,
	`locale` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`target_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_merge_sessions`("id", "target_chapter_id", "source_chapter_ids", "strategy", "status", "current_index", "merged_count", "current_source_chapter_id", "conflict_files", "pre_merge_tree", "conflict_tree", "pre_merge_target_snapshot", "merge_source_snapshot", "pre_merge_target_sha", "error", "locale", "created_at", "updated_at") SELECT "id", "target_chapter_id", "source_chapter_ids", "strategy", "status", "current_index", "merged_count", "current_source_chapter_id", "conflict_files", "pre_merge_tree", "conflict_tree", "pre_merge_target_snapshot", "merge_source_snapshot", "pre_merge_target_sha", "error", "locale", "created_at", "updated_at" FROM `merge_sessions`;--> statement-breakpoint
DROP TABLE `merge_sessions`;--> statement-breakpoint
ALTER TABLE `__new_merge_sessions` RENAME TO `merge_sessions`;--> statement-breakpoint
CREATE INDEX `idx_merge_sessions_target_chapter` ON `merge_sessions` (`target_chapter_id`);--> statement-breakpoint
CREATE TABLE `__new_port_allocations` (
	`port` integer PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`service_name` text,
	`allocated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_port_allocations`("port", "chapter_id", "service_name", "allocated_at") SELECT "port", "chapter_id", "service_name", "allocated_at" FROM `port_allocations`;--> statement-breakpoint
DROP TABLE `port_allocations`;--> statement-breakpoint
ALTER TABLE `__new_port_allocations` RENAME TO `port_allocations`;--> statement-breakpoint
CREATE INDEX `idx_port_allocations_chapter` ON `port_allocations` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `__new_terminal_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_terminal_tabs`("id", "chapter_id", "narrator_id", "name", "sort_order", "created_at") SELECT "id", "chapter_id", "narrator_id", "name", "sort_order", "created_at" FROM `terminal_tabs`;--> statement-breakpoint
DROP TABLE `terminal_tabs`;--> statement-breakpoint
ALTER TABLE `__new_terminal_tabs` RENAME TO `terminal_tabs`;--> statement-breakpoint
CREATE INDEX `idx_terminal_tabs_chapter` ON `terminal_tabs` (`chapter_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_terminal_tabs_narrator` ON `terminal_tabs` (`narrator_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `__new_terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
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
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_terminals`("id", "chapter_id", "narrator_id", "name", "cwd", "dtach_socket", "device_id", "status", "exit_code", "graph_opened", "graph_x", "graph_y", "graph_width", "graph_height", "created_at") SELECT "id", "chapter_id", "narrator_id", "name", "cwd", "dtach_socket", "device_id", "status", "exit_code", "graph_opened", "graph_x", "graph_y", "graph_width", "graph_height", "created_at" FROM `terminals`;--> statement-breakpoint
DROP TABLE `terminals`;--> statement-breakpoint
ALTER TABLE `__new_terminals` RENAME TO `terminals`;--> statement-breakpoint
CREATE INDEX `idx_terminals_chapter` ON `terminals` (`chapter_id`,`status`,`graph_opened`);--> statement-breakpoint
CREATE INDEX `idx_terminals_narrator` ON `terminals` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_terminals_status` ON `terminals` (`status`);