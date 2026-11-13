CREATE TABLE "outline_spec_loss_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"narrator_id" text NOT NULL,
	"path" text NOT NULL,
	"before_revision_id" text NOT NULL,
	"after_revision_id" text NOT NULL,
	"before_at" text,
	"saved_at" text,
	"kinds" text NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"excerpt" text NOT NULL,
	"truncated" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"block_id" text,
	"attach_note" text,
	"attach_seq" integer DEFAULT 0 NOT NULL,
	"resolved_by" text,
	"resolved_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outline_spec_loss_scans" (
	"narrator_id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"findings" integer DEFAULT 0 NOT NULL,
	"note" text,
	"scanned_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outline_spec_loss_findings" ADD CONSTRAINT "outline_spec_loss_findings_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_spec_loss_scans" ADD CONSTRAINT "outline_spec_loss_scans_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outline_spec_loss_findings_status" ON "outline_spec_loss_findings" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_outline_spec_loss_findings_narrator" ON "outline_spec_loss_findings" USING btree ("narrator_id","status","created_at","id");