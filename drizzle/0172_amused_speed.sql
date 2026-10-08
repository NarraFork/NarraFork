DROP INDEX `idx_fc_operation_sequence`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_operation_sequence` ON `file_change_operations` (`source_instance_id`,`journal_seq`);