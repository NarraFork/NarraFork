ALTER TABLE `narrator_messages` ADD `edited_at` text;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `edited_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `original_content_json` text;