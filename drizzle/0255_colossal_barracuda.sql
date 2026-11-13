PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_spec_loss_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`path` text NOT NULL,
	`before_revision_id` text NOT NULL,
	`after_revision_id` text NOT NULL,
	`before_at` text,
	`saved_at` text,
	`kinds` text NOT NULL,
	`items` integer DEFAULT 0 NOT NULL,
	`excerpt` text NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`block_id` text,
	`resolved_by` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_spec_loss_findings_status` ON `outline_spec_loss_findings` (`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_spec_loss_findings_narrator` ON `outline_spec_loss_findings` (`narrator_id`,`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `outline_spec_loss_scans` (
	`narrator_id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`saves` integer DEFAULT 0 NOT NULL,
	`findings` integer DEFAULT 0 NOT NULL,
	`note` text,
	`scanned_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
