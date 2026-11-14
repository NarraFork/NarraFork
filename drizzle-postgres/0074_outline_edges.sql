CREATE TABLE "outline_block_edges" (
	"parent_key" text NOT NULL,
	"block_id" text NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer,
	"order_key" text NOT NULL,
	CONSTRAINT "outline_block_edges_parent_key_block_id_from_seq_pk" PRIMARY KEY("parent_key","block_id","from_seq")
);
--> statement-breakpoint
CREATE TABLE "outline_subtree_changes" (
	"ancestor_id" text NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "outline_subtree_changes_ancestor_id_seq_pk" PRIMARY KEY("ancestor_id","seq")
);
--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD COLUMN "history_floor_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD COLUMN "edges_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outline_block_edges" ADD CONSTRAINT "outline_block_edges_block_id_outline_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_subtree_changes" ADD CONSTRAINT "outline_subtree_changes_ancestor_id_outline_blocks_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_edges_block" ON "outline_block_edges" USING btree ("block_id","from_seq");--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_edges_pending" ON "outline_spaces" USING btree ("id") WHERE "edges_ready" = FALSE;