CREATE TABLE "outline_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"time_zone" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"counts_json" text NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"items_json" text NOT NULL,
	"ranges_json" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"seen_at" text
);
--> statement-breakpoint
ALTER TABLE "outline_spaces" ADD COLUMN "last_commit_at" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "outline_digest_time_zone" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "outline_digest_time" text;--> statement-breakpoint
ALTER TABLE "outline_digests" ADD CONSTRAINT "outline_digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outline_digests_user_period" ON "outline_digests" USING btree ("user_id","kind","period_key");--> statement-breakpoint
CREATE INDEX "idx_outline_digests_unseen" ON "outline_digests" USING btree ("user_id") WHERE "seen_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_last_commit" ON "outline_spaces" USING btree ("last_commit_at","id");--> statement-breakpoint
CREATE INDEX "idx_outline_spaces_unstamped" ON "outline_spaces" USING btree ("id") WHERE "last_commit_at" IS NULL AND "next_seq" > 1;