CREATE TABLE `review_conclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`review_chapter_id` text NOT NULL,
	`source_chapter_id` text NOT NULL,
	`verdict` text NOT NULL,
	`findings_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_conclusions_review` ON `review_conclusions` (`review_chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_review_conclusions_source` ON `review_conclusions` (`source_chapter_id`);