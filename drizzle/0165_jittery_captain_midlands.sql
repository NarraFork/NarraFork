CREATE TABLE `runtime_publication_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`producer_kind` text NOT NULL,
	`task_id` text NOT NULL,
	`logical_run_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`recipient_id` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`arrival_seq` integer,
	`result_ref` text,
	`summary` text,
	`delivery_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runtime_outbox_event` ON `runtime_publication_outbox` (`producer_kind`,`task_id`,`logical_run_id`,`event_kind`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_outbox_order` ON `runtime_publication_outbox` (`recipient_id`,`producer_kind`,`state`,`arrival_seq`);--> statement-breakpoint
CREATE INDEX `idx_runtime_outbox_recipient` ON `runtime_publication_outbox` (`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_outbox_state` ON `runtime_publication_outbox` (`state`,`id`);--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `kind` text DEFAULT 'user_input' NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `notice_kind` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `envelope_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `metadata_json` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `source_narrator_id` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `source_tool_call_id` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `source_attempt` integer;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `source_key` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `dedupe_key` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `delivery_id` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `recipient_message_id` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `recipient_ref_id` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `current_message_id` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `content_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `adopted_revision` integer;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `adopted_at` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `receipt_disposition` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `arrival_seq` integer;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `state` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `claim_epoch` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `claimed_at` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `claim_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `byte_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `projected_byte_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `payload_ref_json` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `dedupe_expires_at` text;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `updated_at` text;--> statement-breakpoint
CREATE INDEX `idx_nbm_state_arrival` ON `narrator_buffered_messages` (`narrator_id`,`state`,`arrival_seq`);--> statement-breakpoint
CREATE INDEX `idx_nbm_quota` ON `narrator_buffered_messages` (`narrator_id`,`kind`,`notice_kind`,`state`);--> statement-breakpoint
CREATE INDEX `idx_nbm_legacy` ON `narrator_buffered_messages` (`narrator_id`,`arrival_seq`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nbm_dedupe` ON `narrator_buffered_messages` (`narrator_id`,`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nbm_delivery` ON `narrator_buffered_messages` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_nbm_ref` ON `narrator_buffered_messages` (`narrator_id`,`recipient_ref_id`);--> statement-breakpoint
CREATE INDEX `idx_nbm_source` ON `narrator_buffered_messages` (`source_narrator_id`,`source_tool_call_id`,`source_attempt`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `logical_run_id` text;--> statement-breakpoint
ALTER TABLE `narrators` ADD `inbox_sequence` integer DEFAULT 0 NOT NULL;