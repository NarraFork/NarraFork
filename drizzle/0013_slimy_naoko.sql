ALTER TABLE `narrator_messages` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `model` text;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `cached_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `cache_creation_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `cache_creation_5m_tokens` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `cache_creation_1h_tokens` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `duration_ms` integer;