ALTER TABLE `narrators` ADD `behavior_fence_interval_override` integer;--> statement-breakpoint
ALTER TABLE `narrators` ADD `behavior_fence_attach_override` text DEFAULT 'inherit' NOT NULL;