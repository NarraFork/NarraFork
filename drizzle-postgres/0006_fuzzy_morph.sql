CREATE TABLE "narrator_worktree_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_narrator_id" text,
	"scope_kind" text DEFAULT 'unknown' NOT NULL,
	"scope_project_id" text,
	"scope_owner_user_id" text,
	"ownership_revision" integer DEFAULT 0 NOT NULL,
	"container_config" text,
	"device_id" text NOT NULL,
	"repository_key" text NOT NULL,
	"worktree_path" text NOT NULL,
	"state" text NOT NULL,
	"create_request_id" text NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP::text NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP::text NOT NULL,
	CONSTRAINT "ck_worktree_resource_scope_kind" CHECK ("scope_kind" in ('unknown', 'standalone', 'project')),
	CONSTRAINT "ck_worktree_resource_scope_project" CHECK ("scope_project_id" is null or "scope_kind" = 'project'),
	CONSTRAINT "ck_worktree_resource_revision" CHECK ("ownership_revision" >= 0),
	CONSTRAINT "ck_worktree_resource_config_bytes" CHECK ("container_config" is null or octet_length("container_config") <= 16384)
);
--> statement-breakpoint
CREATE TABLE "permission_rule_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"proposal_json" text NOT NULL,
	"proposal_hash" text NOT NULL,
	"reason" text NOT NULL,
	"scope" text DEFAULT 'narrator' NOT NULL,
	"device_id" text NOT NULL,
	"context_revision" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rule_id" text,
	"approval_source" text,
	"approval_user_id" text,
	"reflection_conclusion" text,
	"error" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP::text NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "container_instances" ALTER COLUMN "chapter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "volume_snapshot_applications" ALTER COLUMN "chapter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "container_instances" ADD COLUMN "worktree_resource_id" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "workspace_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "workspace_context" text;--> statement-breakpoint
ALTER TABLE "port_allocations" ADD COLUMN "worktree_resource_id" text;--> statement-breakpoint
ALTER TABLE "terminal_view_state" ADD COLUMN "worktree_resource_id" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "worktree_resource_id" text;--> statement-breakpoint
ALTER TABLE "volume_snapshot_applications" ADD COLUMN "target_worktree_resource_id" text;--> statement-breakpoint
ALTER TABLE "volume_snapshots" ADD COLUMN "source_worktree_resource_id" text;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resources" ADD CONSTRAINT "narrator_worktree_resources_owner_narrator_id_narrators_id_fk" FOREIGN KEY ("owner_narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resources" ADD CONSTRAINT "narrator_worktree_resources_scope_project_id_projects_id_fk" FOREIGN KEY ("scope_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_worktree_resources" ADD CONSTRAINT "narrator_worktree_resources_scope_owner_user_id_users_id_fk" FOREIGN KEY ("scope_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rule_requests" ADD CONSTRAINT "permission_rule_requests_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rule_requests" ADD CONSTRAINT "permission_rule_requests_tool_call_id_narrator_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."narrator_tool_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_narrator_worktree_resource_path" ON "narrator_worktree_resources" USING btree ("device_id","worktree_path");--> statement-breakpoint
CREATE INDEX "idx_narrator_worktree_resource_owner" ON "narrator_worktree_resources" USING btree ("owner_narrator_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_resource_scope_project" ON "narrator_worktree_resources" USING btree ("scope_project_id");--> statement-breakpoint
CREATE INDEX "idx_worktree_resource_scope_owner" ON "narrator_worktree_resources" USING btree ("scope_owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_permission_rule_request_attempt" ON "permission_rule_requests" USING btree ("tool_call_id","attempt");--> statement-breakpoint
CREATE INDEX "idx_permission_rule_request_narrator_created" ON "permission_rule_requests" USING btree ("narrator_id","created_at","id");--> statement-breakpoint
ALTER TABLE "container_instances" ADD CONSTRAINT "container_instances_worktree_resource_id_narrator_5abc7adf1d_fk" FOREIGN KEY ("worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_allocations" ADD CONSTRAINT "port_allocations_worktree_resource_id_narrator_wo_b0ba5bfaef_fk" FOREIGN KEY ("worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_view_state" ADD CONSTRAINT "terminal_view_state_worktree_resource_id_narrator_e3fa08d232_fk" FOREIGN KEY ("worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_worktree_resource_id_narrator_worktree_1ca6a4ef18_fk" FOREIGN KEY ("worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshot_applications" ADD CONSTRAINT "volume_snapshot_applications_target_worktree_reso_e1d1ff4ffa_fk" FOREIGN KEY ("target_worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_snapshots" ADD CONSTRAINT "volume_snapshots_source_worktree_resource_id_narr_7986881ef0_fk" FOREIGN KEY ("source_worktree_resource_id") REFERENCES "public"."narrator_worktree_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_container_instances_resource_service_status" ON "container_instances" USING btree ("worktree_resource_id","service_name","status");--> statement-breakpoint
CREATE INDEX "idx_port_allocations_resource" ON "port_allocations" USING btree ("worktree_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_view_state_user_resource" ON "terminal_view_state" USING btree ("user_id","worktree_resource_id");--> statement-breakpoint
CREATE INDEX "idx_view_state_resource" ON "terminal_view_state" USING btree ("worktree_resource_id");--> statement-breakpoint
CREATE INDEX "idx_terminals_resource_status" ON "terminals" USING btree ("worktree_resource_id","status","id");--> statement-breakpoint
CREATE INDEX "idx_snapshot_applications_target_resource" ON "volume_snapshot_applications" USING btree ("target_worktree_resource_id");--> statement-breakpoint
CREATE INDEX "idx_volume_snapshots_source_resource" ON "volume_snapshots" USING btree ("source_worktree_resource_id");--> statement-breakpoint
ALTER TABLE "container_instances" ADD CONSTRAINT "ck_container_instances_owner" CHECK (("chapter_id" is null) <> ("worktree_resource_id" is null));--> statement-breakpoint
ALTER TABLE "port_allocations" ADD CONSTRAINT "ck_port_allocations_owner" CHECK ("chapter_id" is null or "worktree_resource_id" is null);--> statement-breakpoint
ALTER TABLE "terminal_view_state" ADD CONSTRAINT "ck_view_state_resource_owner" CHECK ("worktree_resource_id" is null or ("chapter_id" is null and "narrator_id" is null));--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "ck_terminals_resource_owner" CHECK ("worktree_resource_id" is null or ("chapter_id" is null and "narrator_id" is null));--> statement-breakpoint
ALTER TABLE "volume_snapshot_applications" ADD CONSTRAINT "ck_snapshot_applications_owner" CHECK (("chapter_id" is null) <> ("target_worktree_resource_id" is null));