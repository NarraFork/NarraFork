CREATE TABLE "legacy_project_migrations" (
	"project_id" text PRIMARY KEY NOT NULL,
	"project_name" text NOT NULL,
	"git_path" text,
	"archive_path" text,
	"actor_user_id" text NOT NULL,
	"phase" text NOT NULL,
	"revision" text NOT NULL,
	"narrator_ids" text NOT NULL,
	"chapter_targets" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "legacy_sync_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_legacy_migration_archive_path" ON "legacy_project_migrations" USING btree ("archive_path");--> statement-breakpoint
CREATE INDEX "idx_projects_legacy_sync_disabled" ON "projects" USING btree ("legacy_sync_disabled","id");