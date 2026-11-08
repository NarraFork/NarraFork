CREATE TABLE "outline_task_seen" (
	"user_id" text NOT NULL,
	"task_block_id" text NOT NULL,
	"seen_seq" integer NOT NULL,
	"seen_at" text NOT NULL,
	CONSTRAINT "outline_task_seen_user_id_task_block_id_pk" PRIMARY KEY("user_id","task_block_id")
);
--> statement-breakpoint
ALTER TABLE "outline_task_seen" ADD CONSTRAINT "outline_task_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_task_seen" ADD CONSTRAINT "outline_task_seen_task_block_id_outline_blocks_id_fk" FOREIGN KEY ("task_block_id") REFERENCES "public"."outline_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_task_seen_block" ON "outline_task_seen" USING btree ("task_block_id");--> statement-breakpoint
CREATE INDEX "idx_outline_task_seen_user_at" ON "outline_task_seen" USING btree ("user_id","seen_at");