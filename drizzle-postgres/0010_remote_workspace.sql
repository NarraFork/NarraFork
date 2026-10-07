CREATE TABLE "narrator_question_events" (
	"question_id" text NOT NULL,
	"message_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"resolution_json" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_history_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"source_instance_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"device_id" text NOT NULL,
	"workspace_instance_id" text NOT NULL,
	"root_identity" text NOT NULL,
	"object_id" text NOT NULL,
	"origin_path" text NOT NULL,
	"kind" text NOT NULL,
	"algorithm" text DEFAULT 'sha256' NOT NULL,
	"digest" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"placement" text DEFAULT 'remote' NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_history_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_instance_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"device_id" text NOT NULL,
	"workspace_instance_id" text NOT NULL,
	"root_identity" text NOT NULL,
	"operation_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"intent_digest" text,
	"intent_json" text,
	"fencing_token" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"receipt_json" text,
	"server_commit_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_switch_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"request_id" text NOT NULL,
	"actor_user_id" text,
	"request_digest" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"result_json" text NOT NULL,
	"install_state" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "resolution_json" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "withdraw_reason" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "summary_json" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "plan_file_binding" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "last_stop_reason" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "workspace_context" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "workspace_revision" integer;--> statement-breakpoint
ALTER TABLE "narrator_question_events" ADD CONSTRAINT "narrator_question_events_question_id_narrator_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."narrator_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_question_events" ADD CONSTRAINT "narrator_question_events_message_id_narrator_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."narrator_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_switch_requests" ADD CONSTRAINT "workspace_switch_requests_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_question_events_question_rowid" ON "narrator_question_events" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "idx_question_events_question_created" ON "narrator_question_events" USING btree ("question_id","created_at","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_remote_history_object" ON "remote_history_objects" USING btree ("source_instance_id","scope_id","object_id","kind");--> statement-breakpoint
CREATE INDEX "idx_remote_history_object_scope" ON "remote_history_objects" USING btree ("device_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_remote_history_receipt" ON "remote_history_receipts" USING btree ("source_instance_id","scope_id","operation_id");--> statement-breakpoint
CREATE INDEX "idx_remote_history_receipt_pending" ON "remote_history_receipts" USING btree ("device_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_switch_request" ON "workspace_switch_requests" USING btree ("narrator_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_switch_request_created" ON "workspace_switch_requests" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_narrator_questions_answer_message" ON "narrator_questions" USING btree ("answer_message_id");--> statement-breakpoint
CREATE INDEX "idx_narrator_questions_created" ON "narrator_questions" USING btree ("created_at","id");