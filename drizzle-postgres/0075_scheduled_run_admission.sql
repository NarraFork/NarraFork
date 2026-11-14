ALTER TABLE "scheduled_task_runs" ADD COLUMN "logical_run_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "schedule_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "schedule_cursor_at" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "active_run_id" text;