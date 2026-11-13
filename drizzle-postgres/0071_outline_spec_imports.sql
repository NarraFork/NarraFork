CREATE TABLE "outline_spec_imports" (
	"narrator_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"trigger" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_count" integer,
	"last_error_detail" text,
	"attention_reason" text,
	"switch_count" integer DEFAULT 0 NOT NULL,
	"switched_at" text,
	"notice_switch" integer DEFAULT 0 NOT NULL,
	"space_id" text,
	"task_page_id" text,
	"fence_revision_id" text,
	"tasks" integer,
	"pages" integer,
	"revert_count" integer DEFAULT 0 NOT NULL,
	"reverted_at" text,
	"reverted_by" text,
	"revert_source_key" text,
	"revert_note_ids" text,
	"last_actor" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outline_spec_imports" ADD CONSTRAINT "outline_spec_imports_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_spec_imports_status" ON "outline_spec_imports" USING btree ("status","updated_at","narrator_id");