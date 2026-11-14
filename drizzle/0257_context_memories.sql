PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `context_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_key` text NOT NULL,
	`project_id` text,
	`narrator_id` text,
	`key` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`source_narrator_id` text,
	`source_message_id` text,
	`created_by_kind` text NOT NULL,
	`confirmed_at` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "context_memory_scope" CHECK(("context_memories"."scope" = 'user' and "context_memories"."scope_key" = 'user' and "context_memories"."project_id" is null and "context_memories"."narrator_id" is null) or ("context_memories"."scope" = 'project' and "context_memories"."project_id" is not null and "context_memories"."scope_key" = 'project:' || "context_memories"."project_id" and "context_memories"."narrator_id" is null) or ("context_memories"."scope" = 'session' and "context_memories"."narrator_id" is not null and "context_memories"."scope_key" = 'session:' || "context_memories"."narrator_id" and "context_memories"."project_id" is null)),
	CONSTRAINT "context_memory_version" CHECK("context_memories"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_memory_key` ON `context_memories` (`owner_user_id`,`scope_key`,`key`);
--> statement-breakpoint
CREATE INDEX `idx_context_memory_recall` ON `context_memories` (`owner_user_id`,`scope_key`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_context_memory_project` ON `context_memories` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_context_memory_narrator` ON `context_memories` (`narrator_id`);
--> statement-breakpoint
CREATE TABLE `context_memory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`version` integer NOT NULL,
	`action` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `context_memories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_memory_event_version` ON `context_memory_events` (`memory_id`,`version`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
