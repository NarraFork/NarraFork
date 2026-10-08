CREATE TABLE `chat_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`member_type` text NOT NULL,
	`user_id` text,
	`narrator_id` text,
	`role` text DEFAULT 'participant' NOT NULL,
	`can_control` integer DEFAULT false NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `chat_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_group_members_group` ON `chat_group_members` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_group_members_narrator` ON `chat_group_members` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_group_members_group_narrator` ON `chat_group_members` (`group_id`,`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_group_members_group_user` ON `chat_group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `chat_group_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`sender_type` text NOT NULL,
	`sender_user_id` text,
	`sender_narrator_id` text,
	`content` text NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `chat_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sender_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_chat_group_messages_group` ON `chat_group_messages` (`group_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`origin_narrator_id` text,
	`project_id` text,
	`created_by` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`origin_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_chat_groups_origin` ON `chat_groups` (`origin_narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_groups_project` ON `chat_groups` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_groups_status` ON `chat_groups` (`status`,`updated_at`);