ALTER TABLE "api_requests" ADD COLUMN "context_usage_snapshot_json" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "context_usage_snapshot_json" text;--> statement-breakpoint
CREATE INDEX "idx_fc_segment_input" ON "file_change_execution_segments" USING btree ("narrator_id","source_input_id");