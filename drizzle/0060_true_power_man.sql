CREATE TABLE `knowledge_injection_events` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`compact_seq` integer NOT NULL,
	`entry_id` text NOT NULL,
	`entry_revision_id` text,
	`source` text NOT NULL,
	`trigger_message_id` text,
	`trigger_tool_call_id` text,
	`summary` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_revision_id`) REFERENCES `knowledge_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`trigger_tool_call_id`) REFERENCES `narrator_tool_calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kie_cycle_entry` ON `knowledge_injection_events` (`narrator_id`,`compact_seq`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_kie_narrator_cycle` ON `knowledge_injection_events` (`narrator_id`,`compact_seq`);--> statement-breakpoint
CREATE INDEX `idx_kie_entry` ON `knowledge_injection_events` (`entry_id`);