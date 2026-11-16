CREATE TABLE "outline_fold_state" (
	"user_id" text NOT NULL,
	"space_id" text NOT NULL,
	"block_id" text NOT NULL,
	"open" boolean NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "outline_fold_state_user_id_space_id_block_id_pk" PRIMARY KEY("user_id","space_id","block_id")
);
--> statement-breakpoint
ALTER TABLE "outline_fold_state" ADD CONSTRAINT "outline_fold_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_fold_state" ADD CONSTRAINT "outline_fold_state_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_fold_state" ADD CONSTRAINT "outline_fold_state_block_id_outline_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_fold_state_written" ON "outline_fold_state" USING btree ("user_id","space_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_outline_fold_state_block" ON "outline_fold_state" USING btree ("block_id");