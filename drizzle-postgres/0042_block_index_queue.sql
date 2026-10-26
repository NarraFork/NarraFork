CREATE TABLE "narrator_block_index_queue" (
	"block_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narrator_blocks" ADD COLUMN "ledger_revision" text;--> statement-breakpoint
ALTER TABLE "narrator_messages" ADD COLUMN "blocks_content_hash" text;--> statement-breakpoint
ALTER TABLE "narrator_block_index_queue" ADD CONSTRAINT "narrator_block_index_queue_block_id_narrator_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."narrator_blocks"("id") ON DELETE cascade ON UPDATE no action;