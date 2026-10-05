CREATE TABLE "narrator_context_char_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"generation" text NOT NULL,
	"page" integer NOT NULL,
	"segments_json" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narrator_messages" ADD COLUMN "context_chars_json" text;--> statement-breakpoint
ALTER TABLE "narrator_tool_calls" ADD COLUMN "input_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrator_tool_calls" ADD COLUMN "output_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "context_summary_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "context_system_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "context_tools_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "context_char_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "context_char_cache_json" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "treat_as_local_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "narrator_context_char_pages" ADD CONSTRAINT "narrator_context_char_pages_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_char_pages_generation_page_idx" ON "narrator_context_char_pages" USING btree ("narrator_id","generation","page");