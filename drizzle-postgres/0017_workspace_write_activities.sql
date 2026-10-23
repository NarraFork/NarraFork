CREATE TABLE "workspace_write_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_id" text NOT NULL,
	"source_instance_id" text NOT NULL,
	"workspace_instance_id" text NOT NULL,
	"narrator_id" text,
	"user_id" text NOT NULL,
	"project_id" text,
	"device_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_revision" integer NOT NULL,
	"context_key" text NOT NULL,
	"canonical_root" text NOT NULL,
	"path_flavor" text NOT NULL,
	"root_evidence_digest" text NOT NULL,
	"owner_epoch" text NOT NULL,
	"kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE INDEX "idx_workspace_activity_status_id" ON "workspace_write_activities" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "idx_workspace_activity_scope_status" ON "workspace_write_activities" USING btree ("scope_id","status");--> statement-breakpoint
CREATE INDEX "idx_workspace_activity_device_status" ON "workspace_write_activities" USING btree ("device_id","status","id");