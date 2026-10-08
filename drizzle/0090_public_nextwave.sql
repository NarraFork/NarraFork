CREATE TABLE `narrator_tool_continuations` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text NOT NULL,
	`narrator_id` text NOT NULL,
	`update_epoch` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'paused' NOT NULL,
	`payload_json` text,
	`deadline_at` text,
	`claim_token` text,
	`claimed_at` text,
	`error_message` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tool_call_id`) REFERENCES `narrator_tool_calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tool_continuations_tool_call` ON `narrator_tool_continuations` (`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_continuations_epoch_state` ON `narrator_tool_continuations` (`update_epoch`,`state`);--> statement-breakpoint
CREATE INDEX `idx_tool_continuations_narrator_state` ON `narrator_tool_continuations` (`narrator_id`,`state`);