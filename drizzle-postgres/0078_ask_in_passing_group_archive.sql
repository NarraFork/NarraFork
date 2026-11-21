ALTER TABLE "narrators" ADD COLUMN "ask_in_passing_group_id" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "archived_with_narrator_id" text;--> statement-breakpoint
ALTER TABLE "narrators" ADD CONSTRAINT "narrators_ask_in_passing_group_id_narrators_id_fk" FOREIGN KEY ("ask_in_passing_group_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrators" ADD CONSTRAINT "narrators_archived_with_narrator_id_narrators_id_fk" FOREIGN KEY ("archived_with_narrator_id") REFERENCES "public"."narrators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_narrators_ask_in_passing_group" ON "narrators" USING btree ("ask_in_passing_group_id");--> statement-breakpoint
CREATE INDEX "idx_narrators_archived_with" ON "narrators" USING btree ("archived_with_narrator_id");