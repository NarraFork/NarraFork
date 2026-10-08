CREATE TABLE `runtime_awaited_terminal_consumptions` (
	`producer_kind` text NOT NULL,
	`task_id` text NOT NULL,
	`logical_run_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`consumed_at` text NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runtime_awaited_terminal_run` ON `runtime_awaited_terminal_consumptions` (`producer_kind`,`task_id`,`logical_run_id`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_awaited_terminal_recipient` ON `runtime_awaited_terminal_consumptions` (`recipient_id`);