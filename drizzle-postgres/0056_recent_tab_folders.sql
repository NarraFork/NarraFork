ALTER TABLE "user_recent_tabs" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "user_recent_tabs" ADD COLUMN "folder_icon" text;--> statement-breakpoint
ALTER TABLE "user_recent_tabs" ADD COLUMN "folder_color" text;--> statement-breakpoint
ALTER TABLE "user_recent_tabs" ADD COLUMN "folder_preview_count" integer;--> statement-breakpoint
ALTER TABLE "user_recent_tabs_meta" ADD COLUMN "folders_migrated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_user_recent_tabs_user_folder" ON "user_recent_tabs" USING btree ("user_id","folder_id","sort_order");