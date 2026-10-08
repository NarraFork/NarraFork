DROP INDEX `idx_file_snapshots_narrator`;--> statement-breakpoint
CREATE INDEX `idx_file_snapshots_narrator` ON `narrator_file_snapshots` (`narrator_id`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_messages_parent_tool_use_lookup`;--> statement-breakpoint
CREATE INDEX `idx_messages_parent_tool_use_lookup` ON `narrator_messages` (`parent_tool_use_id`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_sidecars_tool_use`;--> statement-breakpoint
CREATE INDEX `idx_sidecars_tool_use` ON `narrator_sidecars` (`tool_use_id`,`target`,`order_index`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_terminals_chapter`;--> statement-breakpoint
CREATE INDEX `idx_terminals_chapter` ON `terminals` (`chapter_id`,`status`,`graph_opened`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_chapter` ON `container_instances` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_chapter_service` ON `container_instances` (`chapter_id`,`service_name`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_container` ON `container_instances` (`container_id`);--> statement-breakpoint
CREATE INDEX `idx_container_instances_status` ON `container_instances` (`chapter_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_exploration_groups_project` ON `exploration_groups` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_variant_updated` ON `narrators` (`variant`,`updated_at`,`id`);