CREATE TABLE "recent_tab_archive_marks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"narrator_id" text NOT NULL,
	"folder_id" text,
	"archived_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recent_tab_archive_marks" ADD CONSTRAINT "recent_tab_archive_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_tab_archive_marks" ADD CONSTRAINT "recent_tab_archive_marks_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_recent_tab_archive_mark" ON "recent_tab_archive_marks" USING btree ("user_id","narrator_id");