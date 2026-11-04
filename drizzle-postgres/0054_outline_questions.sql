CREATE TABLE "outline_questions" (
	"block_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"state" text NOT NULL,
	"proceed" boolean DEFAULT false NOT NULL,
	"to_user_id" text,
	"asker_narrator_id" text,
	"asker_user_id" text,
	"asker_tool_call_id" text,
	"created_at" text NOT NULL,
	"answered_at" text,
	"answer_commit_id" text,
	"delivered_at" text
);
--> statement-breakpoint
ALTER TABLE "outline_block_versions" ADD COLUMN "ask_json" text;--> statement-breakpoint
ALTER TABLE "outline_blocks" ADD COLUMN "ask_json" text;--> statement-breakpoint
ALTER TABLE "outline_pending" ADD COLUMN "digest_seen_at" text;--> statement-breakpoint
ALTER TABLE "outline_questions" ADD CONSTRAINT "outline_questions_block_id_outline_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_questions_to_open" ON "outline_questions" USING btree ("to_user_id") WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX "idx_outline_questions_space_open" ON "outline_questions" USING btree ("space_id") WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX "idx_outline_questions_asker_open" ON "outline_questions" USING btree ("asker_narrator_id") WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX "idx_outline_questions_undelivered" ON "outline_questions" USING btree ("answered_at") WHERE "state" = 'answered' AND "delivered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_pending_digest" ON "outline_pending" USING btree ("decider_user_id") WHERE "status" = 'confirmed' AND "digest_seen_at" IS NULL AND ("decided_by_json"::jsonb #>> '{kind}') = 'agent';