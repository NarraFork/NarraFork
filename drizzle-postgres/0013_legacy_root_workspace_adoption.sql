CREATE TABLE "legacy_narrator_workspace_adoptions" (
	"narrator_id" text PRIMARY KEY NOT NULL,
	"migration_project_id" text NOT NULL,
	"previous_revision" integer NOT NULL,
	"adopted_revision" integer NOT NULL,
	"device_id" text NOT NULL,
	"cwd" text NOT NULL,
	"context_key" text NOT NULL,
	"history_digest" text NOT NULL,
	"workspace_key" text,
	"repository_key" text,
	"directory_dev" text NOT NULL,
	"directory_ino" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_project_sync_tombstones" (
	"canonical_root" text PRIMARY KEY NOT NULL,
	"disabled_project_id" text NOT NULL,
	"disabled_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_narrator_workspace_adoptions" ADD CONSTRAINT "legacy_narrator_workspace_adoptions_narrator_id_narrators_id_fk" FOREIGN KEY ("narrator_id") REFERENCES "public"."narrators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_narrator_workspace_adoptions" ADD CONSTRAINT "legacy_narrator_workspace_adoptions_migration_pro_b906383793_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."legacy_project_migrations"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_legacy_workspace_adoption_migration" ON "legacy_narrator_workspace_adoptions" USING btree ("migration_project_id");