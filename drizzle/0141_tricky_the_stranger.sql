ALTER TABLE `device_transfer_tasks` ADD `parent_narrator_id` text REFERENCES narrators(id);--> statement-breakpoint
ALTER TABLE `device_transfer_tasks` ADD `tool_use_id` text;--> statement-breakpoint
CREATE INDEX `idx_device_transfer_tasks_parent_narrator` ON `device_transfer_tasks` (`parent_narrator_id`);