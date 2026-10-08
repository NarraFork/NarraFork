ALTER TABLE `revert_operation_files` ADD `compensation_after_state_json` text;--> statement-breakpoint
ALTER TABLE `revert_operation_files` ADD `compensation_after_blob_digest` text REFERENCES file_change_blobs(digest);--> statement-breakpoint
CREATE INDEX `idx_revert_file_compensation_blob` ON `revert_operation_files` (`compensation_after_blob_digest`);