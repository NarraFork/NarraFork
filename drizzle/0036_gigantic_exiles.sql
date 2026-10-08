CREATE TABLE `narrator_sidecars` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`message_id` text,
	`tool_use_id` text,
	`target` text NOT NULL,
	`source` text NOT NULL,
	`content` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sidecars_message` ON `narrator_sidecars` (`message_id`,`target`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_sidecars_tool_use` ON `narrator_sidecars` (`tool_use_id`,`target`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_sidecars_narrator` ON `narrator_sidecars` (`narrator_id`,`created_at`);