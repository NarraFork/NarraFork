ALTER TABLE "scheduled_task_runs" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "scheduled_for" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "trigger" text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "trigger_message_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "logical_run_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "block_reason" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "blocked_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "outcome_summary" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "outcome_reported_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "auto_handled" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "require_report" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "busy_deadline_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "interrupt_target" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "nudged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "missed_count" integer;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "deadline_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "stats" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "schedule" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "schedule_kind" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "fired_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "schedule_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "schedule_cursor_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "active_run_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "completed_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "target_narrator_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "context_policy" text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "on_busy" text DEFAULT 'skip' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "busy_wait_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "require_report" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "model_policy" text DEFAULT 'follow' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "on_blocked" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "blocked_wait_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "max_run_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_on_success" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "creator_kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "creator_narrator_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "creator_message_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "creator_tool_call_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "creator_tool_use_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "creator_snapshot" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "last_modified_by" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "last_run_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "last_summary" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_target_narrator_id_narrators_id_fk" FOREIGN KEY ("target_narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runs_task_status" ON "scheduled_task_runs" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runs_narrator_task" ON "scheduled_task_runs" USING btree ("narrator_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runs_wait_queue" ON "scheduled_task_runs" USING btree ("narrator_id","status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scheduled_task_runs_one_waiting" ON "scheduled_task_runs" USING btree ("task_id") WHERE "status" = 'waiting';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scheduled_task_runs_one_interrupt" ON "scheduled_task_runs" USING btree ("narrator_id") WHERE "status" = 'waiting' AND "interrupt_target" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runs_status" ON "scheduled_task_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_owner" ON "scheduled_tasks" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_target_narrator" ON "scheduled_tasks" USING btree ("target_narrator_id");