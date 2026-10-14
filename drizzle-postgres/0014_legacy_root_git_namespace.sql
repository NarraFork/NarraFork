ALTER TABLE "legacy_narrator_workspace_adoptions" ADD COLUMN "git_directory_dev" text;--> statement-breakpoint
ALTER TABLE "legacy_narrator_workspace_adoptions" ADD COLUMN "git_directory_ino" text;--> statement-breakpoint
CREATE INDEX "idx_fc_scope_physical_root" ON "file_change_scopes" USING btree ("device_id","canonical_root");