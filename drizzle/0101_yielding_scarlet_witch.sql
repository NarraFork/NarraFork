ALTER TABLE `knowledge_submissions` ADD `previous_submission_id` text;--> statement-breakpoint
ALTER TABLE `knowledge_submissions` ADD `round` integer DEFAULT 1 NOT NULL;