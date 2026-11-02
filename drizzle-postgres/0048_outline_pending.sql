CREATE TABLE "outline_pending" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"page_id" text NOT NULL,
	"root_block_id" text,
	"ops_json" text NOT NULL,
	"base_json" text NOT NULL,
	"block_ids_json" text NOT NULL,
	"summary" text NOT NULL,
	"requested_by_json" text NOT NULL,
	"requester_session" text,
	"decider_json" text NOT NULL,
	"decider_user_id" text,
	"rev" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"decided_at" text,
	"decided_by_json" text,
	"decision_commit_id" text,
	"reason" text,
	"reported_at" text
);
--> statement-breakpoint
ALTER TABLE "outline_pending" ADD CONSTRAINT "outline_pending_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_pending_space" ON "outline_pending" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "idx_outline_pending_page_open" ON "outline_pending" USING btree ("page_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "idx_outline_pending_root_open" ON "outline_pending" USING btree ("root_block_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_pending_open_proposer" ON "outline_pending" USING btree ("requester_session","root_block_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "idx_outline_pending_requester_unreported" ON "outline_pending" USING btree ("requester_session") WHERE "reported_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_pending_decider_open" ON "outline_pending" USING btree ("decider_user_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_pending_decision_commit" ON "outline_pending" USING btree ("decision_commit_id");--> statement-breakpoint
CREATE INDEX "idx_outline_blocks_locked" ON "outline_blocks" USING btree ("page_id") WHERE ("task_json"::jsonb #>> '{lock}') IS NOT NULL AND "deleted" = FALSE;