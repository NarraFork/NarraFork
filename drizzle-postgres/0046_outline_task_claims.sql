CREATE TABLE "outline_task_claims" (
	"task_block_id" text PRIMARY KEY NOT NULL,
	"holder_narrator_id" text,
	"holder_user_id" text,
	"epoch" integer NOT NULL,
	"task_version_at_claim" integer NOT NULL,
	"claimed_at" text NOT NULL,
	"expires_at" text
);
--> statement-breakpoint
ALTER TABLE "outline_blocks" ADD COLUMN "in_process" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD COLUMN "in_process_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outline_task_claims" ADD CONSTRAINT "outline_task_claims_task_block_id_outline_blocks_id_fk" FOREIGN KEY ("task_block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_task_claims_holder" ON "outline_task_claims" USING btree ("holder_narrator_id") WHERE "holder_narrator_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_task_claims_expiry" ON "outline_task_claims" USING btree ("expires_at") WHERE "expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_blocks_open_tasks" ON "outline_blocks" USING btree ("space_id") WHERE ("task_json"::jsonb #>> '{status}') IN ('todo', 'doing') AND "deleted" = FALSE;--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_in_process_pending" ON "outline_spaces" USING btree ("id") WHERE "in_process_ready" = FALSE;