CREATE TABLE "outline_live_log" (
	"space_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"seq" integer NOT NULL,
	"block_id" text,
	"update_b64" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "outline_live_log_space_id_epoch_seq_pk" PRIMARY KEY("space_id","epoch","seq")
);
--> statement-breakpoint
ALTER TABLE "outline_live_log" ADD CONSTRAINT "outline_live_log_space_id_outline_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."outline_spaces"("id") ON DELETE cascade ON UPDATE no action;