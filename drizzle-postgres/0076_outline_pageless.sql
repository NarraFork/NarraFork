CREATE TABLE "outline_block_edges" (
	"parent_key" text NOT NULL,
	"block_id" text NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer,
	"order_key" text NOT NULL,
	CONSTRAINT "outline_block_edges_parent_key_block_id_from_seq_pk" PRIMARY KEY("parent_key","block_id","from_seq")
);
--> statement-breakpoint
CREATE TABLE "outline_fold_state" (
	"user_id" text NOT NULL,
	"space_id" text NOT NULL,
	"block_id" text NOT NULL,
	"open" boolean NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "outline_fold_state_user_id_space_id_block_id_pk" PRIMARY KEY("user_id","space_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "outline_live_log" (
	"space_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"seq" integer NOT NULL,
	"update_b64" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "outline_live_log_space_id_epoch_seq_pk" PRIMARY KEY("space_id","epoch","seq")
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
ALTER TABLE "outline_fold_state" ADD CONSTRAINT "outline_fold_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_fold_state" ADD CONSTRAINT "outline_fold_state_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_fold_state" ADD CONSTRAINT "outline_fold_state_block_id_outline_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_live_log" ADD CONSTRAINT "outline_live_log_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_subtree_changes" ADD CONSTRAINT "outline_subtree_changes_ancestor_id_outline_blocks_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_edges_block" ON "outline_block_edges" USING btree ("block_id","from_seq");--> statement-breakpoint
CREATE INDEX "idx_outline_edges_open" ON "outline_block_edges" USING btree ("parent_key","order_key","block_id","from_seq") WHERE "to_seq" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_edges_closed" ON "outline_block_edges" USING btree ("parent_key","to_seq","from_seq","order_key","block_id") WHERE "to_seq" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_fold_state_written" ON "outline_fold_state" USING btree ("user_id","space_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_outline_fold_state_block" ON "outline_fold_state" USING btree ("block_id");--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_edges_pending" ON "outline_spaces" USING btree ("id") WHERE "edges_ready" = FALSE;