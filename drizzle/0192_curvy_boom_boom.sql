PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_fc_segment_input` ON `file_change_execution_segments` (`narrator_id`,`source_input_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
