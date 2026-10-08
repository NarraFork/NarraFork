CREATE TABLE "narrator_question_events" (
	"question_id" text NOT NULL,
	"message_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"resolution_json" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_tasks" ADD COLUMN "background_kind" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "resolution_json" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "withdraw_reason" text;--> statement-breakpoint
ALTER TABLE "narrator_questions" ADD COLUMN "summary_json" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "last_stop_reason" text;--> statement-breakpoint
ALTER TABLE "narrator_question_events" ADD CONSTRAINT "narrator_question_events_question_id_narrator_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."narrator_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_question_events" ADD CONSTRAINT "narrator_question_events_message_id_narrator_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."narrator_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_question_events_question_rowid" ON "narrator_question_events" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "idx_question_events_question_created" ON "narrator_question_events" USING btree ("question_id","created_at","message_id");--> statement-breakpoint
CREATE INDEX "idx_narrator_questions_answer_message" ON "narrator_questions" USING btree ("answer_message_id");--> statement-breakpoint
CREATE INDEX "idx_narrator_questions_created" ON "narrator_questions" USING btree ("created_at","id");