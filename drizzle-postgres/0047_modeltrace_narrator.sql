ALTER TABLE "narrators" ADD COLUMN "hidden_from_lists" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "narrators" ADD COLUMN "modeltrace_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_narrators_modeltrace_key" ON "narrators" USING btree ("modeltrace_key");