CREATE TABLE "runtime_awaited_terminal_consumptions" (
	"producer_kind" text NOT NULL,
	"task_id" text NOT NULL,
	"logical_run_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"consumed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_execution_owners" (
	"owner_epoch" text PRIMARY KEY NOT NULL,
	"identity_json" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_change_scope_recoveries" ADD COLUMN "resolution_authority" text DEFAULT 'execution_proven' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_change_scope_recoveries" ADD COLUMN "maintenance_evidence_json" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "scheduled_task_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "cleanup_policy" text DEFAULT '{"mode":"none"}'::text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_write_leases" ADD COLUMN "execution_class" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_write_leases" ADD COLUMN "termination_evidence_json" text;--> statement-breakpoint
ALTER TABLE "runtime_awaited_terminal_consumptions" ADD CONSTRAINT "runtime_awaited_terminal_consumptions_recipient_i_d01467ba1c_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runtime_awaited_terminal_run" ON "runtime_awaited_terminal_consumptions" USING btree ("producer_kind","task_id","logical_run_id","recipient_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_awaited_terminal_recipient" ON "runtime_awaited_terminal_consumptions" USING btree ("recipient_id");--> statement-breakpoint
ALTER TABLE "narrators" ADD CONSTRAINT "narrators_scheduled_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("scheduled_task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_narrator_refs_narrator_id" ON "narrator_message_refs" USING btree ("narrator_id","id");--> statement-breakpoint
CREATE INDEX "idx_narrators_scheduled_task_created" ON "narrators" USING btree ("scheduled_task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_last_narrator" ON "scheduled_tasks" USING btree ("last_narrator_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_lease_owner" ON "workspace_write_leases" USING btree ("owner_epoch","lease_id");