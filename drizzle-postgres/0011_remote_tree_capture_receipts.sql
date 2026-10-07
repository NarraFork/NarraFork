CREATE TABLE "remote_tree_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"edge" text NOT NULL,
	"device_id" text NOT NULL,
	"context_key" text NOT NULL,
	"workspace_revision" integer NOT NULL,
	"source_instance_id" text NOT NULL,
	"workspace_instance_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"root_identity" text NOT NULL,
	"remote_operation_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"actor_subject_key" text NOT NULL,
	"state" text NOT NULL,
	"descriptor_json" text,
	"receipt_metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_tree_captures" ADD CONSTRAINT "remote_tree_captures_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_tree_captures" ADD CONSTRAINT "remote_tree_captures_tool_call_id_narrator_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."narrator_tool_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_remote_tree_capture_operation" ON "remote_tree_captures" USING btree ("source_instance_id","scope_id","remote_operation_id");--> statement-breakpoint
CREATE INDEX "idx_remote_tree_capture_boundary" ON "remote_tree_captures" USING btree ("tool_call_id","attempt","edge");--> statement-breakpoint
CREATE INDEX "idx_remote_tree_capture_narrator" ON "remote_tree_captures" USING btree ("narrator_id","created_at");